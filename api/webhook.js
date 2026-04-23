import qs from 'qs';

// Отключаем стандартный body parser Vercel — парсим вручную
export const config = {
  api: {
    bodyParser: false,
  },
};

// ID этапа "Успешно реализовано" в amoCRM (стандартный = 142)
const SUCCESS_STATUS_ID = '142';

// ─── Читаем raw body из запроса ───────────────────────────────────────────────
async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk.toString()));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// ─── Запрос к amoCRM API: полные данные сделки + контакты + теги ──────────────
async function getLeadDetails(leadId) {
  const subdomain = process.env.AMO_SUBDOMAIN;   // uldanaavtoschool
  const token = process.env.AMO_ACCESS_TOKEN;

  if (!subdomain || !token) {
    throw new Error('AMO_SUBDOMAIN или AMO_ACCESS_TOKEN не заданы');
  }

  const url = `https://${subdomain}.amocrm.ru/api/v4/leads/${leadId}?with=contacts,tags`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`amoCRM API error ${response.status}: ${err}`);
  }

  return response.json();
}

// ─── Запрос к amoCRM API: имя контакта по ID ─────────────────────────────────
async function getContactName(contactId) {
  const subdomain = process.env.AMO_SUBDOMAIN;
  const token = process.env.AMO_ACCESS_TOKEN;

  const url = `https://${subdomain}.amocrm.ru/api/v4/contacts/${contactId}`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) return null;

  const data = await response.json();
  return data.name || null;
}

// ─── Извлечь значение кастомного поля по ключевым словам ─────────────────────
function getCustomField(fields, keywords) {
  if (!fields || !Array.isArray(fields)) return '—';
  const field = fields.find((f) =>
    keywords.some((kw) => f.name?.toLowerCase().includes(kw))
  );
  if (!field) return '—';
  const vals = field.values || [];
  return vals.map((v) => v.value).filter(Boolean).join(', ') || '—';
}

// ─── Форматируем сообщение для Telegram ───────────────────────────────────────
function formatMessage(lead, contactName) {
  const id = lead.id || '—';
  const name = lead.name || '—';
  const price = lead.price
    ? Number(lead.price).toLocaleString('ru-RU') + ' ₸'
    : '—';

  const fields = lead.custom_fields_values || [];

  // Ищем поле «Товар» / «Услуга» / «Product»
  const product = getCustomField(fields, ['товар', 'product', 'услуга', 'курс', 'программа']);

  // Теги сделки
  const tags = lead._embedded?.tags?.map((t) => t.name).join(', ') || '—';

  const contact = contactName || '—';

  return (
    `🎉 *Новая продажа!*\n\n` +
    `🔢 Сделка №${id}: ${name}\n` +
    `💰 Сумма: ${price}\n` +
    `🛍 Товар: ${product}\n` +
    `👤 Клиент: ${contact}\n` +
    `🏷 Теги: ${tags}`
  );
}

// ─── Отправка сообщения в Telegram ────────────────────────────────────────────
async function sendTelegramMessage(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    throw new Error('TELEGRAM_BOT_TOKEN или TELEGRAM_CHAT_ID не заданы');
  }

  const response = await fetch(
    `https://api.telegram.org/bot${token}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'Markdown',
      }),
    }
  );

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Telegram API error: ${errorBody}`);
  }

  return response.json();
}

// ─── Основной обработчик ──────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const rawBody = await getRawBody(req);

    // amoCRM шлёт application/x-www-form-urlencoded
    // с вложенными ключами вида leads[status][0][name]
    const body = qs.parse(rawBody);

    const leads = body?.leads?.status;

    if (!leads) {
      return res.status(200).json({ ok: true, message: 'No status leads' });
    }

    const leadsArray = Array.isArray(leads) ? leads : Object.values(leads);

    let notified = 0;

    for (const webhookLead of leadsArray) {
      if (String(webhookLead.status_id) !== SUCCESS_STATUS_ID) continue;

      console.log(`Сделка #${webhookLead.id} перешла в "Успешно реализовано" — запрашиваю детали...`);

      // Запрашиваем полные данные сделки из amoCRM API
      const lead = await getLeadDetails(webhookLead.id);

      // Получаем имя первого контакта
      let contactName = null;
      const contacts = lead._embedded?.contacts || [];
      if (contacts.length > 0) {
        contactName = await getContactName(contacts[0].id);
      }

      const message = formatMessage(lead, contactName);
      await sendTelegramMessage(message);
      notified++;

      console.log(`✅ Уведомление отправлено по сделке #${lead.id}`);
    }

    return res.status(200).json({ ok: true, notified });
  } catch (error) {
    console.error('❌ Ошибка обработки вебхука:', error.message);
    return res.status(500).json({ error: error.message });
  }
}

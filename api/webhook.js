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
  try {
    const subdomain = process.env.AMO_SUBDOMAIN;
    const token = process.env.AMO_ACCESS_TOKEN;
    if (!subdomain || !token) return null;

    const url = `https://${subdomain}.amocrm.ru/api/v4/leads/${leadId}?with=contacts,tags`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      console.warn(`amoCRM lead API: ${response.status} для сделки #${leadId}`);
      return null;
    }

    const text = await response.text();
    if (!text) return null;
    return JSON.parse(text);
  } catch (e) {
    console.warn('getLeadDetails error:', e.message);
    return null;
  }
}

// ─── Запрос к amoCRM API: имя контакта по ID ─────────────────────────────────
async function getContactName(contactId) {
  try {
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
    const text = await response.text();
    if (!text) return null;
    const data = JSON.parse(text);
    return data.name || null;
  } catch (e) {
    console.warn('getContactName error:', e.message);
    return null;
  }
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
function formatMessage(webhookLead, fullLead, contactName) {
  const id = webhookLead.id || '—';
  const name = fullLead?.name || webhookLead.name || '—';
  const price = (fullLead?.price || webhookLead.price)
    ? Number(fullLead?.price || webhookLead.price).toLocaleString('ru-RU') + ' ₸'
    : '—';

  const fields = fullLead?.custom_fields_values || [];

  // Ищем поле «Товар» / «Услуга» / «Product»
  const product = getCustomField(fields, ['товар', 'product', 'услуга', 'курс', 'программа']);

  // Теги сделки
  const tags = fullLead?._embedded?.tags?.map((t) => t.name).join(', ') || '—';

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
      const fullLead = await getLeadDetails(webhookLead.id);

      // Получаем имя первого контакта
      let contactName = null;
      if (fullLead) {
        const contacts = fullLead._embedded?.contacts || [];
        if (contacts.length > 0) {
          contactName = await getContactName(contacts[0].id);
        }
      }

      const message = formatMessage(webhookLead, fullLead, contactName);
      await sendTelegramMessage(message);
      notified++;

      console.log(`✅ Уведомление отправлено по сделке #${webhookLead.id}`);
    }

    return res.status(200).json({ ok: true, notified });
  } catch (error) {
    console.error('❌ Ошибка обработки вебхука:', error.message);
    return res.status(500).json({ error: error.message });
  }
}

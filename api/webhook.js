import qs from 'qs';

export const config = {
  api: {
    bodyParser: false,
  },
};

// ID этапов — можно указать несколько через запятую в Vercel ENV (SUCCESS_STATUS_IDS)
const SUCCESS_STATUS_IDS = (process.env.SUCCESS_STATUS_IDS || '85481598')
  .split(',')
  .map((s) => s.trim());

// ─── Читаем raw body ──────────────────────────────────────────────────────────
async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk.toString()));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// ─── amoCRM API: полные данные сделки ────────────────────────────────────────
async function getLeadDetails(leadId) {
  try {
    const subdomain = process.env.AMO_SUBDOMAIN;
    const token = process.env.AMO_ACCESS_TOKEN;
    if (!subdomain || !token) return null;

    const url = `https://${subdomain}.amocrm.ru/api/v4/leads/${leadId}?with=contacts,tags`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      console.warn(`amoCRM leads API ${response.status} для #${leadId}`);
      return null;
    }
    const text = await response.text();
    if (!text) return null;
    return JSON.parse(text);
  } catch (e) {
    console.warn('getLeadDetails:', e.message);
    return null;
  }
}

// ─── amoCRM API: имя менеджера по user_id ────────────────────────────────────
async function getManagerName(userId) {
  try {
    const subdomain = process.env.AMO_SUBDOMAIN;
    const token = process.env.AMO_ACCESS_TOKEN;
    if (!userId) return null;

    const url = `https://${subdomain}.amocrm.ru/api/v4/users/${userId}`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) return null;
    const text = await response.text();
    if (!text) return null;
    const data = JSON.parse(text);
    return data.name || null;
  } catch (e) {
    console.warn('getManagerName:', e.message);
    return null;
  }
}

// ─── Найти кастомное поле по ключевым словам ─────────────────────────────────
function getField(fields, keywords) {
  if (!Array.isArray(fields)) return null;
  return fields.find((f) =>
    keywords.some((kw) => f.field_name?.toLowerCase().includes(kw.toLowerCase()))
  ) || null;
}

function getFieldValue(fields, keywords) {
  const field = getField(fields, keywords);
  if (!field) return '—';
  const vals = field.values || [];
  return vals.map((v) => v.value).filter(Boolean).join(', ') || '—';
}

// ─── Форматирование даты (Unix timestamp → DD.MM.YYYY) ────────────────────────
function formatDate(value) {
  if (!value || value === '—') return '—';
  const ts = Number(value);
  if (!ts) return value;
  const d = new Date(ts * 1000);
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  return `${day}.${month}.${year}`;
}

// ─── Форматирование суммы ─────────────────────────────────────────────────────
function formatMoney(value) {
  if (!value || value === '—') return '—';
  const num = Number(String(value).replace(/\s/g, ''));
  if (isNaN(num)) return value;
  return num.toLocaleString('ru-RU') + ' ₸';
}

// ─── Формируем сообщение ──────────────────────────────────────────────────────
function formatMessage(fullLead, managerName) {
  const fields = fullLead?.custom_fields_values || [];

  // DEBUG: логируем все поля чтобы видеть точные названия
  console.log('FIELDS:', JSON.stringify(fields.map(f => ({ name: f.field_name, val: f.values?.[0]?.value }))));

  const sanatorium  = getFieldValue(fields, ['санатори', 'санатор', 'отель', 'объект']);
  const city        = getFieldValue(fields, ['город']);
  const checkIn     = formatDate(getFieldValue(fields, ['дата заезда', 'заезд', 'дата заезд']));
  const checkOut    = formatDate(getFieldValue(fields, ['дата выезда', 'выезд', 'дата выезд']));
  const totalGuests = getFieldValue(fields, ['кол-во человек', 'кол-во гостей', 'всего']);
  const adults      = getFieldValue(fields, ['кол-во взрослых', 'взрослы', 'adult']);
  const children    = getFieldValue(fields, ['кол-во детей', 'дет', 'ребен', 'child']);
  const comment     = getFieldValue(fields, ['комментари', 'коммент', 'примечан', 'заметк']);
  const manager     = managerName || '—';

  // Бюджет (системное поле price = общая сумма оплаты)
  const budget = Number(fullLead?.price) || 0;
  const totalPayment = formatMoney(budget);

  // Предоплата из кастомного поля
  const prepaymentRaw = getFieldValue(fields, ['предоплат', 'аванс', 'prepay']);
  const prepaymentNum = Number(String(prepaymentRaw).replace(/\s/g, '')) || 0;
  const prepayment = formatMoney(prepaymentRaw);

  // Остаток = Бюджет − Предоплата
  const remainderNum = budget - prepaymentNum;
  const remainder = remainderNum >= 0 ? formatMoney(remainderNum) : '—';

  return (
    `🏨 *НОВАЯ БРОНЬ*\n\n` +
    `📍 Санаторий: ${sanatorium}\n` +
    `🏙 Город: ${city}\n` +
    `📅 Заезд: ${checkIn}\n` +
    `📆 Выезд: ${checkOut}\n` +
    `👥 Гости: ${totalGuests}\n` +
    `👤 Взрослые: ${adults}\n` +
    `🧒 Дети: ${children}\n` +
    `💳 Оплата: ${totalPayment}\n` +
    `💰 Предоплата: ${prepayment}\n` +
    `💵 Остаток: ${remainder}\n` +
    `🧑 Менеджер: ${manager}\n` +
    `📝 Комментарий: ${comment}`
  );
}

// ─── Отправка в Telegram ──────────────────────────────────────────────────────
async function sendTelegramMessage(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error('Не заданы TELEGRAM_BOT_TOKEN или TELEGRAM_CHAT_ID');

  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Telegram API error: ${err}`);
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
    const body = qs.parse(rawBody);
    const leads = body?.leads?.status;

    if (!leads) {
      return res.status(200).json({ ok: true, message: 'No status leads' });
    }

    const leadsArray = Array.isArray(leads) ? leads : Object.values(leads);
    let notified = 0;

    for (const webhookLead of leadsArray) {
      console.log(`DEBUG lead #${webhookLead.id} status_id=${webhookLead.status_id} pipeline_id=${webhookLead.pipeline_id}`);

      if (!SUCCESS_STATUS_IDS.includes(String(webhookLead.status_id))) continue;

      console.log(`Сделка #${webhookLead.id} → запрашиваю данные из amoCRM...`);

      const fullLead = await getLeadDetails(webhookLead.id);
      const managerName = await getManagerName(fullLead?.responsible_user_id);

      const message = formatMessage(fullLead, managerName);
      await sendTelegramMessage(message);
      notified++;

      console.log(`✅ Уведомление отправлено по сделке #${webhookLead.id}`);
    }

    return res.status(200).json({ ok: true, notified });
  } catch (error) {
    console.error('❌ Ошибка:', error.message);
    return res.status(500).json({ error: error.message });
  }
}

import qs from 'qs';

export const config = {
  api: {
    bodyParser: false,
  },
};

// ─── Этапы ────────────────────────────────────────────────────────────────────
// Канал менеджеров (НОВАЯ БРОНЬ)
const BOOKING_STATUS_IDS = (process.env.SUCCESS_STATUS_IDS || '85481598')
  .split(',').map((s) => s.trim());

// Канал водителей (уведомление о заезде)
const DRIVERS_STATUS_IDS = (process.env.DRIVERS_STATUS_IDS || '85481606')
  .split(',').map((s) => s.trim());


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
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });

    if (!response.ok) { console.warn(`amoCRM leads ${response.status} #${leadId}`); return null; }
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  } catch (e) { console.warn('getLeadDetails:', e.message); return null; }
}

// ─── amoCRM API: контакт (имя + телефон) ─────────────────────────────────────
async function getContact(contactId) {
  try {
    const subdomain = process.env.AMO_SUBDOMAIN;
    const token = process.env.AMO_ACCESS_TOKEN;
    if (!contactId) return null;

    const url = `https://${subdomain}.amocrm.ru/api/v4/contacts/${contactId}`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });

    if (!response.ok) return null;
    const text = await response.text();
    if (!text) return null;
    const data = JSON.parse(text);

    // Ищем номер телефона в кастомных полях контакта
    const phoneField = (data.custom_fields_values || []).find(
      (f) => f.field_code === 'PHONE' || f.field_name?.toLowerCase().includes('телефон') || f.field_name?.toLowerCase().includes('phone')
    );
    const phone = phoneField?.values?.[0]?.value || '—';

    return { name: data.name || '—', phone };
  } catch (e) { console.warn('getContact:', e.message); return null; }
}

// ─── amoCRM API: имя менеджера ────────────────────────────────────────────────
async function getManagerName(userId) {
  try {
    const subdomain = process.env.AMO_SUBDOMAIN;
    const token = process.env.AMO_ACCESS_TOKEN;
    if (!userId) return null;

    const url = `https://${subdomain}.amocrm.ru/api/v4/users/${userId}`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });

    if (!response.ok) return null;
    const text = await response.text();
    if (!text) return null;
    return JSON.parse(text).name || null;
  } catch (e) { console.warn('getManagerName:', e.message); return null; }
}

// ─── Хелперы для полей ────────────────────────────────────────────────────────
function getFieldValue(fields, keywords) {
  if (!Array.isArray(fields)) return '—';
  const field = fields.find((f) =>
    keywords.some((kw) => f.field_name?.toLowerCase().includes(kw.toLowerCase()))
  );
  if (!field) return '—';
  return (field.values || []).map((v) => v.value).filter(Boolean).join(', ') || '—';
}

function formatDate(value) {
  if (!value || value === '—') return '—';
  const ts = Number(value);
  if (!ts) return value;
  const d = new Date(ts * 1000);
  return `${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')}.${d.getFullYear()}`;
}

function formatMoney(value) {
  if (!value && value !== 0) return '—';
  const num = Number(String(value).replace(/\s/g, ''));
  if (isNaN(num)) return String(value);
  return num.toLocaleString('ru-RU') + ' ₸';
}

// ─── Сообщение для менеджеров (НОВАЯ БРОНЬ) ──────────────────────────────────
function formatBookingMessage(fullLead, managerName) {
  const fields = fullLead?.custom_fields_values || [];
  console.log('FIELDS:', JSON.stringify(fields.map(f => ({ name: f.field_name, val: f.values?.[0]?.value }))));

  const sanatorium  = getFieldValue(fields, ['санатори', 'санатор', 'отель', 'объект']);
  const city        = getFieldValue(fields, ['город']);
  const checkIn     = formatDate(getFieldValue(fields, ['дата заезда', 'заезд']));
  const checkOut    = formatDate(getFieldValue(fields, ['дата выезда', 'выезд']));
  const totalGuests = getFieldValue(fields, ['кол-во человек', 'кол-во гостей', 'всего']);
  const adults      = getFieldValue(fields, ['кол-во взрослых', 'взрослы']);
  const children    = getFieldValue(fields, ['кол-во детей', 'дет', 'ребен']);
  const comment     = getFieldValue(fields, ['комментари', 'коммент', 'примечан']);
  const manager     = managerName || '—';

  const budget = Number(fullLead?.price) || 0;
  const prepaymentRaw = getFieldValue(fields, ['предоплат', 'аванс']);
  const prepaymentNum = Number(String(prepaymentRaw).replace(/\s/g, '')) || 0;
  const remainder = budget - prepaymentNum;

  return (
    `🏨 *НОВАЯ БРОНЬ*\n\n` +
    `📍 Санаторий: ${sanatorium}\n` +
    `🏙 Город: ${city}\n` +
    `📅 Заезд: ${checkIn}\n` +
    `📆 Выезд: ${checkOut}\n` +
    `👥 Гости: ${totalGuests}\n` +
    `👤 Взрослые: ${adults}\n` +
    `🧒 Дети: ${children}\n` +
    `💳 Оплата: ${formatMoney(budget)}\n` +
    `💰 Предоплата: ${formatMoney(prepaymentRaw)}\n` +
    `💵 Остаток: ${remainder >= 0 ? formatMoney(remainder) : '—'}\n` +
    `🧑 Менеджер: ${manager}\n` +
    `📝 Комментарий: ${comment}`
  );
}

// ─── Сообщение для водителей ──────────────────────────────────────────────────
function formatDriversMessage(fullLead, contact) {
  const fields = fullLead?.custom_fields_values || [];

  const sanatorium  = getFieldValue(fields, ['санатори', 'санатор', 'отель', 'объект']);
  const city        = getFieldValue(fields, ['город']);
  const checkIn     = formatDate(getFieldValue(fields, ['дата заезда', 'заезд']));
  const transport   = getFieldValue(fields, ['тип транспорта', 'транспорт']);
  const trainTicket = getFieldValue(fields, ['билет жд', 'жд билет', 'поезд']);
  const airTicket   = getFieldValue(fields, ['авиа билет', 'авиа', 'самолет']);
  const totalGuests = getFieldValue(fields, ['кол-во человек', 'кол-во гостей', 'всего']);
  const children    = getFieldValue(fields, ['кол-во детей', 'дет', 'ребен']);

  const clientName  = contact?.name || '—';
  const clientPhone = contact?.phone || '—';

  return (
    `Сәлеметсіз бе! Здравствуйте!\n\n` +
    `Мы хотели бы уведомить вас о предстоящем заезде гостей в наш санаторий.\n\n` +
    `👤 Фамилия Имя: ${clientName}\n` +
    `🏨 Санаторий: ${sanatorium}\n` +
    `📅 Дата заезда: ${checkIn}\n` +
    `🏙 Город: ${city}\n` +
    `🚌 Тип транспорта: ${transport}\n` +
    `🚂 Билет ЖД: ${trainTicket}\n` +
    `✈️ Авиа Билет: ${airTicket}\n` +
    `👥 Количество гостей: ${totalGuests}\n` +
    `🧒 Количество детей: ${children}\n` +
    `📞 Номер для связи: ${clientPhone}`
  );
}

// ─── Отправка в Telegram ──────────────────────────────────────────────────────
async function sendToChat(chatId, text, useMarkdownV2 = false) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !chatId) throw new Error('Не задан TELEGRAM_BOT_TOKEN или chatId');

  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: useMarkdownV2 ? 'MarkdownV2' : 'Markdown',
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Telegram API error: ${err}`);
  }
  return response.json();
}

// ─── Основной обработчик ──────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const rawBody = await getRawBody(req);
    const body = qs.parse(rawBody);
    const leads = body?.leads?.status;
    if (!leads) return res.status(200).json({ ok: true, message: 'No status leads' });

    const leadsArray = Array.isArray(leads) ? leads : Object.values(leads);
    let notified = 0;

    for (const webhookLead of leadsArray) {
      const sid = String(webhookLead.status_id);
      console.log(`DEBUG lead #${webhookLead.id} status_id=${sid} pipeline_id=${webhookLead.pipeline_id}`);

      const isBooking = BOOKING_STATUS_IDS.includes(sid);
      const isDrivers = DRIVERS_STATUS_IDS.includes(sid);
      if (!isBooking && !isDrivers) continue;

      console.log(`Сделка #${webhookLead.id} → запрашиваю данные...`);
      const fullLead = await getLeadDetails(webhookLead.id);
      const contacts = fullLead?._embedded?.contacts || [];
      const contact = contacts.length > 0 ? await getContact(contacts[0].id) : null;

      // Уведомление менеджерам
      if (isBooking) {
        const managerName = await getManagerName(fullLead?.responsible_user_id);
        const msg = formatBookingMessage(fullLead, managerName);
        await sendToChat(process.env.TELEGRAM_CHAT_ID, msg);
        console.log(`✅ Бронь отправлена менеджерам #${webhookLead.id}`);
      }

      // Уведомление водителям
      if (isDrivers) {
        const msg = formatDriversMessage(fullLead, contact);
        await sendToChat(process.env.TELEGRAM_DRIVERS_CHAT_ID, msg, false);
        console.log(`✅ Уведомление отправлено водителям #${webhookLead.id}`);
      }

      notified++;
    }

    return res.status(200).json({ ok: true, notified });
  } catch (error) {
    console.error('❌ Ошибка:', error.message);
    return res.status(500).json({ error: error.message });
  }
}

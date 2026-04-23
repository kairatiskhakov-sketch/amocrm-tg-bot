# amoCRM → Telegram уведомления о продажах

Serverless-функция на Vercel. При переводе сделки в amoCRM на этап **«Успешно реализовано»** делает запрос к amoCRM API, забирает полные данные сделки и отправляет уведомление в Telegram-группу.

## Уведомление выглядит так

```
🎉 Новая продажа!

🔢 Сделка №53610435: Название сделки
💰 Сумма: 150 000 ₸
🛍 Товар: Курс вождения категории B
👤 Клиент: Иван Иванов
🏷 Теги: Новый клиент, Онлайн
```

---

## Как это работает

```
amoCRM (смена этапа на "Успешно реализовано")
  → вебхук → Vercel /api/webhook
  → запрос к amoCRM API за полными данными сделки
  → запрос к amoCRM API за именем контакта
  → Telegram sendMessage → группа
```

---

## Деплой: пошаговая инструкция

### 1. Создай Telegram-бота

1. Открой [@BotFather](https://t.me/BotFather) → `/newbot`
2. Скопируй **токен** вида `7123456789:AAF...`
3. Добавь бота в свою группу и сделай его **администратором**
4. Узнай `chat_id` группы через [@userinfobot](https://t.me/userinfobot) (начинается с `-100...`)

---

### 2. Залей проект на GitHub

```bash
git init
git add .
git commit -m "init"
git remote add origin https://github.com/ТВО_ИМЯ/amocrm-tg-bot.git
git push -u origin main
```

---

### 3. Задеплой на Vercel

1. Зайди на [vercel.com](https://vercel.com) → **Add New Project**
2. Подключи свой GitHub-репозиторий
3. Нажми **Deploy**
4. Перейди в **Settings → Environment Variables** и добавь все 4 переменные:

| Переменная | Значение |
|---|---|
| `TELEGRAM_BOT_TOKEN` | токен от @BotFather |
| `TELEGRAM_CHAT_ID` | chat_id группы (начинается с `-100`) |
| `AMO_SUBDOMAIN` | `uldanaavtoschool` |
| `AMO_ACCESS_TOKEN` | твой Access Token из amoCRM |

5. После добавления переменных: **Deployments → Redeploy**
6. Скопируй URL проекта: `https://amocrm-tg-bot.vercel.app`

---

### 4. Настрой вебхук в amoCRM

1. **amoCRM → Настройки → Интеграции → Вебхуки**
2. **Добавить хук**
3. URL:
   ```
   https://amocrm-tg-bot.vercel.app/api/webhook
   ```
4. Событие: **Изменение статуса сделки**
5. Сохрани

---

### 5. Проверь

Переведи тестовую сделку на этап **«Успешно реализовано»** — через несколько секунд придёт уведомление в Telegram.

---

## Важные моменты

**ID этапа «Успешно реализовано»** — стандартный в amoCRM `status_id = 142`.
Если у тебя кастомный этап — найди его ID в настройках воронки и поменяй в `api/webhook.js`:
```js
const SUCCESS_STATUS_ID = '142'; // ← свой ID
```

**Access Token** — истекает примерно через год. Когда истечёт, обнови переменную `AMO_ACCESS_TOKEN` в настройках Vercel.

**Кастомное поле «Товар»** — код ищет поле с названием содержащим «товар», «product», «услуга», «курс» или «программа». Если у тебя другое название — добавь его в функцию `getCustomField` в `api/webhook.js`.

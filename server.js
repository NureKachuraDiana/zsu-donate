const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const orders = new Map();

//Налаштування
const MERCHANT_ACCOUNT = process.env.WFP_MERCHANT;
const MERCHANT_SECRET  = process.env.WFP_SECRET;
const MERCHANT_DOMAIN  = process.env.WFP_DOMAIN;
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
if (!MERCHANT_ACCOUNT || !MERCHANT_SECRET || !MERCHANT_DOMAIN || MERCHANT_ACCOUNT === 'test_merch_n1') {
  console.error('Задайте WFP_MERCHANT, WFP_SECRET та WFP_DOMAIN власного тестового магазину.');
  process.exit(1);
}
const MIN_AMOUNT = 10, MAX_AMOUNT = 50000;

//Допоміжні функції
const hmacMd5 = (str) =>
  crypto.createHmac('md5', MERCHANT_SECRET).update(str, 'utf8').digest('hex');

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e5) req.destroy(); });
    req.on('end', () => resolve(data));
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

//Створення платежу: підпис формується ТІЛЬКИ на сервері
function buildPayment(amount, email) {
  const orderReference = `donate_${Date.now()}_${crypto.randomBytes(16).toString('hex')}`;
  const orderDate = Math.floor(Date.now() / 1000);
  const productName = 'Благодійний внесок на потреби ЗСУ';
  const currency = 'UAH';
  orders.set(orderReference, {amount, status: 'Pending'});

  const signString = [
    MERCHANT_ACCOUNT, MERCHANT_DOMAIN, orderReference, orderDate,
    amount, currency, productName, 1, amount,
  ].join(';');

  return {
    action: 'https://secure.wayforpay.com/pay',
    fields: {
      merchantAccount: MERCHANT_ACCOUNT,
      merchantAuthType: 'SimpleSignature',
      merchantDomainName: MERCHANT_DOMAIN,
      merchantSignature: hmacMd5(signString),
      orderReference,
      orderDate,
      amount,
      currency,
      'productName[]': productName,
      'productCount[]': 1,
      'productPrice[]': amount,
      clientEmail: email,
      returnUrl: `${BASE_URL}/thanks?order=${orderReference}`,
      ...(BASE_URL.startsWith('https://') ? {serviceUrl: `${BASE_URL}/api/callback`} : {}),
      language: 'UA',
    },
  };
}

// Перевірка підпису, замовлення та суми перед підтвердженням.
async function applyStatus(d) {
  const order = orders.get(d.orderReference);
  const expected = hmacMd5([d.merchantAccount,d.orderReference,d.amount,d.currency,d.authCode,d.cardPan,d.transactionStatus,d.reasonCode].join(';'));
  if (!order || d.merchantAccount !== MERCHANT_ACCOUNT || d.currency !== 'UAH' || Number(d.amount) !== order.amount || expected !== d.merchantSignature) return false;
  order.status = d.transactionStatus;
  console.log(`[verified] ${d.orderReference}: ${d.transactionStatus}`);
  return true;
}

//Маршрути
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, BASE_URL);

  // 1) Клієнт просить підписані дані для платежу
  if (req.method === 'POST' && url.pathname === '/api/create-payment') {
    try {
      const { amount, email } = JSON.parse(await readBody(req));
      const value = Number(amount);
      if (!Number.isFinite(value) || value < MIN_AMOUNT || value > MAX_AMOUNT) {
        return sendJson(res, 400, { error: `Сума має бути від ${MIN_AMOUNT} до ${MAX_AMOUNT} грн` });
      }
      if (typeof email !== 'string' || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return sendJson(res, 400, {error: 'Вкажіть коректну електронну пошту'});
      return sendJson(res, 200, buildPayment(Math.round(value * 100) / 100, email));
    } catch {
      return sendJson(res, 400, { error: 'Некоректний запит' });
    }
  }

  // 2) WayForPay повідомляє про результат платежу (serviceUrl).
  //    Працює лише коли сервер доступний з інтернету (наприклад, через ngrok).
  if (req.method === 'POST' && url.pathname === '/api/callback') {
    try {
      const d = JSON.parse(await readBody(req));
      if (!await applyStatus(d)) return sendJson(res, 400, {error: 'invalid payment'});
      console.log(`[callback] ${d.orderReference}: ${d.transactionStatus}, ${d.amount} ${d.currency}`);
      const time = Math.floor(Date.now() / 1000);
      return sendJson(res, 200, {
        orderReference: d.orderReference,
        status: 'accept',
        time,
        signature: hmacMd5([d.orderReference, 'accept', time].join(';')),
      });
    } catch {
      return sendJson(res, 400, { error: 'bad request' });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/status') {
    const ref = url.searchParams.get('order');
    const order = orders.get(ref);
    if (!order) return sendJson(res, 404, {error: 'Замовлення не знайдено'});
    if (order.status !== 'Approved') {
      try {
        const response = await fetch('https://api.wayforpay.com/api', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({transactionType:'CHECK_STATUS',merchantAccount:MERCHANT_ACCOUNT,orderReference:ref,merchantSignature:hmacMd5([MERCHANT_ACCOUNT,ref].join(';')),apiVersion:1}), signal:AbortSignal.timeout(8000)});
        if (response.ok) await applyStatus(await response.json());
      } catch (e) { console.error('CHECK_STATUS:', e.message); }
    }
    return sendJson(res, 200, {status:order.status, amount:order.amount, orderReference:ref});
  }

  // 3) Повернення користувача після оплати (WayForPay робить POST на returnUrl)
  if (url.pathname === '/thanks') {
    res.writeHead(303, { Location: '/thanks.html?order=' + encodeURIComponent(url.searchParams.get('order') || '') });
    return res.end();
  }

  // 4) Статичні файли
  const file = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = path.join(__dirname, 'public', path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(path.join(__dirname, 'public'))) { res.writeHead(403); return res.end(); }
  fs.readFile(filePath, (err, content) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript' };
    res.writeHead(200, { 'Content-Type': types[path.extname(filePath)] || 'application/octet-stream' });
    res.end(content);
  });
});

server.listen(PORT, () => console.log(`Сторінка донату: ${BASE_URL}  (WayForPay — перевірте режим магазину в кабінеті)`));

/**
 * Nostr Order Bridge - Server
 * 
 * Simple bridge that:
 * 1. Receives orders from the web form
 * 2. Creates BTCPay invoice directly
 * 3. Returns payment link to customer
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

// Config from environment
const PORT = process.env.PORT || 3848;
const BTCPAY_URL = process.env.BTCPAY_URL || 'https://nostr.bitcoinbutlers.com';
const BTCPAY_STORE_ID = process.env.BTCPAY_STORE_ID;
const BTCPAY_API_KEY = process.env.BTCPAY_API_KEY;

if (!BTCPAY_STORE_ID || !BTCPAY_API_KEY) {
  console.error('ERROR: BTCPAY_STORE_ID and BTCPAY_API_KEY are required');
  process.exit(1);
}

// Simple static file serving
const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(res, filePath) {
  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  
  try {
    const data = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }
}

// Parse JSON body
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

// Create BTCPay invoice
async function createInvoice(order) {
  const items = order.items || [];
  let total = 0;
  let currency = 'USD';
  
  for (const item of items) {
    total += (item.price || 0) * (item.quantity || 1);
    currency = item.currency || currency;
  }
  
  const invoiceRequest = {
    amount: total.toString(),
    currency: currency,
    metadata: {
      orderId: order.id,
      items: items.map(i => ({
        name: i.name,
        quantity: i.quantity,
        price: i.price,
      })),
      shipping: order.shipping,
      contact: order.contact,
      message: order.message,
      source: 'nostr-bridge',
    },
    checkout: {
      defaultLanguage: 'en',
      redirectURL: `${BTCPAY_URL}/order-complete`,
    },
    receipt: {
      enabled: true,
    },
  };
  
  const url = `${BTCPAY_URL}/api/v1/stores/${BTCPAY_STORE_ID}/invoices`;
  
  console.log(`[${new Date().toISOString()}] Creating BTCPay invoice: ${total} ${currency} for order ${order.id}`);
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `token ${BTCPAY_API_KEY}`,
    },
    body: JSON.stringify(invoiceRequest),
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[${new Date().toISOString()}] BTCPay error: ${response.status} ${errorText}`);
    throw new Error(`BTCPay error: ${response.status}`);
  }
  
  const invoice = await response.json();
  console.log(`[${new Date().toISOString()}] Invoice created: ${invoice.id} → ${invoice.checkoutLink}`);
  
  return invoice;
}

// Request handler
const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  
  const url = new URL(req.url, `http://localhost:${PORT}`);
  
  // API: Create order
  if (req.method === 'POST' && url.pathname === '/api/order') {
    try {
      const body = await parseBody(req);
      const order = body.order;
      
      if (!order || !order.items || order.items.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid order: no items' }));
        return;
      }
      
      if (!order.shipping || !order.shipping.name) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid order: shipping details required' }));
        return;
      }
      
      // Create BTCPay invoice
      const invoice = await createInvoice(order);
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        invoice: {
          id: invoice.id,
          checkoutLink: invoice.checkoutLink,
          amount: invoice.amount,
          currency: invoice.currency,
        },
      }));
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Error:`, err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }
  
  // API: Health check
  if (req.method === 'GET' && url.pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }
  
  // Static files
  if (req.method === 'GET') {
    let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
    filePath = path.join(__dirname, filePath);
    
    // Prevent directory traversal
    if (!filePath.startsWith(__dirname)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    
    serveStatic(res, filePath);
    return;
  }
  
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[${new Date().toISOString()}] Nostr Order Bridge running on port ${PORT}`);
  console.log(`[${new Date().toISOString()}] BTCPay: ${BTCPAY_URL}/api/v1/stores/${BTCPAY_STORE_ID}`);
});

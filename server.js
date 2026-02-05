/**
 * Nostr Order Bridge - Registration Server
 * 
 * Invite-only registration for WooCommerce merchants.
 * Connects their store to the nostr-order-listener.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Config
const PORT = process.env.PORT || 3848;
const LISTENER_URL = process.env.LISTENER_URL || 'http://127.0.0.1:3847';
const LISTENER_TOKEN = process.env.LISTENER_TOKEN || '';
const INVITES_FILE = process.env.INVITES_FILE || './invites.json';

// In-memory invite store
let invites = {};

function loadInvites() {
  try {
    if (fs.existsSync(INVITES_FILE)) {
      invites = JSON.parse(fs.readFileSync(INVITES_FILE, 'utf8'));
      console.log(`[${ts()}] Loaded ${Object.keys(invites).length} invites`);
    }
  } catch (e) {
    console.error(`[${ts()}] Failed to load invites:`, e.message);
  }
}

function saveInvites() {
  try {
    fs.writeFileSync(INVITES_FILE, JSON.stringify(invites, null, 2));
  } catch (e) {
    console.error(`[${ts()}] Failed to save invites:`, e.message);
  }
}

function ts() { return new Date().toISOString(); }

// MIME types
const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.zip': 'application/zip',
};

function serveStatic(res, filePath) {
  const ext = path.extname(filePath);
  try {
    const data = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}

function jsonResponse(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

/**
 * Convert npub to hex
 */
function npubToHex(npub) {
  if (!npub.startsWith('npub1')) return npub; // already hex
  
  // Bech32 decode
  const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  const data = npub.slice(5); // remove npub1
  const values = [];
  for (const c of data) {
    const v = CHARSET.indexOf(c);
    if (v === -1) throw new Error('Invalid npub character');
    values.push(v);
  }
  
  // Convert 5-bit to 8-bit
  let acc = 0, bits = 0;
  const bytes = [];
  for (const v of values.slice(0, -6)) { // exclude checksum
    acc = (acc << 5) | v;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      bytes.push((acc >> bits) & 0xff);
    }
  }
  
  return bytes.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Register merchant on the nostr-order-listener
 */
async function registerOnListener(pubkeyHex, storeName, webhookUrl, webhookSecret) {
  const res = await fetch(`${LISTENER_URL}/api/merchants`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${LISTENER_TOKEN}`,
    },
    body: JSON.stringify({
      pubkey: pubkeyHex,
      name: storeName,
      webhookUrl: webhookUrl,
      webhookSecret: webhookSecret,
    }),
  });
  
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Listener registration failed: ${res.status} ${err}`);
  }
  
  return await res.json();
}

// Server
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  
  const url = new URL(req.url, `http://localhost:${PORT}`);
  
  // === Admin: Create invite ===
  if (req.method === 'POST' && url.pathname === '/api/invites') {
    const auth = req.headers.authorization;
    if (!auth || auth !== `Bearer ${LISTENER_TOKEN}`) {
      return jsonResponse(res, 401, { error: 'Unauthorized' });
    }
    
    try {
      const body = await parseBody(req);
      const token = crypto.randomBytes(16).toString('hex');
      
      invites[token] = {
        label: body.label || '',
        createdAt: Date.now(),
        used: false,
      };
      saveInvites();
      
      const inviteUrl = `https://nostr.bitcoinbutlers.com?invite=${token}`;
      console.log(`[${ts()}] Invite created: ${token} (${body.label || 'no label'})`);
      
      return jsonResponse(res, 200, { success: true, token, inviteUrl });
    } catch (e) {
      return jsonResponse(res, 400, { error: e.message });
    }
  }
  
  // === Admin: List invites ===
  if (req.method === 'GET' && url.pathname === '/api/invites') {
    const auth = req.headers.authorization;
    if (!auth || auth !== `Bearer ${LISTENER_TOKEN}`) {
      return jsonResponse(res, 401, { error: 'Unauthorized' });
    }
    return jsonResponse(res, 200, { invites });
  }
  
  // === Register merchant via invite ===
  if (req.method === 'POST' && url.pathname === '/api/register') {
    try {
      const body = await parseBody(req);
      
      // Validate invite
      if (!body.invite || !invites[body.invite]) {
        return jsonResponse(res, 403, { error: 'Invalid or expired invite' });
      }
      if (invites[body.invite].used) {
        return jsonResponse(res, 403, { error: 'Invite already used' });
      }
      
      // Validate fields
      if (!body.npub || !body.wooUrl || !body.storeName) {
        return jsonResponse(res, 400, { error: 'Missing required fields: npub, wooUrl, storeName' });
      }
      
      // Convert npub to hex
      let pubkeyHex;
      try {
        pubkeyHex = npubToHex(body.npub);
      } catch (e) {
        return jsonResponse(res, 400, { error: 'Invalid npub format' });
      }
      
      if (pubkeyHex.length !== 64) {
        return jsonResponse(res, 400, { error: 'Invalid npub: decoded key is wrong length' });
      }
      
      // Generate webhook secret
      const webhookSecret = crypto.randomBytes(32).toString('hex');
      
      // Build webhook URL (the merchant's WooCommerce endpoint)
      const wooUrl = body.wooUrl.replace(/\/$/, '');
      const webhookUrl = `${wooUrl}/wp-json/woo-nostr-market/v1/order-webhook`;
      
      // Register on the listener
      await registerOnListener(pubkeyHex, body.storeName, webhookUrl, webhookSecret);
      
      // Mark invite as used
      invites[body.invite].used = true;
      invites[body.invite].usedBy = body.storeName;
      invites[body.invite].usedAt = Date.now();
      saveInvites();
      
      console.log(`[${ts()}] Merchant registered: ${body.storeName} (${pubkeyHex.slice(0,16)}...)`);
      
      return jsonResponse(res, 200, {
        success: true,
        webhookUrl: webhookUrl,
        webhookSecret: webhookSecret,
      });
      
    } catch (e) {
      console.error(`[${ts()}] Registration error:`, e.message);
      return jsonResponse(res, 500, { error: e.message });
    }
  }
  
  // === Health ===
  if (req.method === 'GET' && url.pathname === '/api/health') {
    return jsonResponse(res, 200, { status: 'ok' });
  }
  
  // === Static files ===
  if (req.method === 'GET') {
    let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
    filePath = path.join(__dirname, filePath);
    if (!filePath.startsWith(__dirname)) { res.writeHead(403); res.end(); return; }
    serveStatic(res, filePath);
    return;
  }
  
  jsonResponse(res, 404, { error: 'Not found' });
});

loadInvites();
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[${ts()}] Nostr Bridge running on port ${PORT}`);
  console.log(`[${ts()}] Listener: ${LISTENER_URL}`);
});

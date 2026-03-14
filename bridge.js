#!/usr/bin/env node
/**
 * Feishu Bot-to-Bot Bridge Proxy
 * 
 * Enables bot-to-bot communication in Feishu group chats via Tailscale.
 * Runs as an independent HTTP server — no dependency on agent sessions.
 */

const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// --- Load Config ---
const CONFIG_PATH = process.env.BRIDGE_CONFIG || path.join(__dirname, 'config.json');

let config;
try {
  config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
} catch (err) {
  console.error(`Failed to load config from ${CONFIG_PATH}: ${err.message}`);
  console.error('Copy config.template.json to config.json and fill in your values.');
  process.exit(1);
}

const PORT = config.bridge?.port || 18800;
const TS_SOCKET = config.tailscale?.socket || '/tmp/tailscaled.sock';
const PEER_IP = config.tailscale?.peerIp;
const PEER_PORT = config.tailscale?.peerPort || 18800;
const FEISHU_APP_ID = config.feishu?.appId;
const FEISHU_APP_SECRET = config.feishu?.appSecret;
const GROUP_CHAT_ID = config.feishu?.groupChatId;
const PEER_BOT_USER_ID = config.feishu?.peerBotUserId;
const PEER_BOT_NAME = config.feishu?.peerBotName || 'Bot';
const TAILSCALE_BIN = config.tailscale?.bin || 'tailscale';

// Validate required config
const required = { PEER_IP, FEISHU_APP_ID, FEISHU_APP_SECRET, GROUP_CHAT_ID };
for (const [key, val] of Object.entries(required)) {
  if (!val) {
    console.error(`Missing required config: ${key}`);
    process.exit(1);
  }
}

// --- State ---
let cachedToken = null;
let tokenExpiry = 0;
let stats = { nudgesReceived: 0, nudgesSent: 0, errors: 0, startTime: Date.now() };

// --- Server ---
const server = http.createServer(async (req, res) => {
  const body = await getBody(req);

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      uptime: Math.floor((Date.now() - stats.startTime) / 1000),
      stats,
      peer: PEER_IP,
      ts: Date.now()
    }));
    return;
  }

  if (req.method === 'POST' && req.url === '/nudge') {
    stats.nudgesReceived++;
    log('Received nudge:', JSON.stringify(body).slice(0, 300));

    try {
      if (body.type === 'feishu_mention' || body.from) {
        const senderName = body.from || 'Unknown';
        const message = body.message || '(empty)';
        const chatId = body.chat_id || GROUP_CHAT_ID;

        // Reply in Feishu group
        const replyText = `收到来自 ${senderName} 的消息：「${message}」`;
        await sendFeishuMessage(replyText, PEER_BOT_USER_ID, PEER_BOT_NAME, chatId);

        log('Replied in Feishu:', replyText.slice(0, 100));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'replied_in_feishu' }));
      } else {
        log('Generic nudge acknowledged');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ack' }));
      }
    } catch (err) {
      stats.errors++;
      log('ERROR handling nudge:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', error: err.message }));
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/send-nudge') {
    stats.nudgesSent++;
    log('Sending nudge to peer');

    try {
      const result = await sendNudgeViaTailscale(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'nudge_sent', response: result.slice(0, 200) }));
    } catch (err) {
      stats.errors++;
      log('ERROR sending nudge:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', error: err.message }));
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

// --- Helpers ---
function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

function getBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(data)); } catch { resolve({}); }
    });
  });
}

// --- Feishu API ---
async function getFeishuToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  const data = await httpsPost('open.feishu.cn', '/open-apis/auth/v3/tenant_access_token/internal', {
    app_id: FEISHU_APP_ID,
    app_secret: FEISHU_APP_SECRET
  });

  if (!data.tenant_access_token) {
    throw new Error(`Feishu token error: ${JSON.stringify(data)}`);
  }

  cachedToken = data.tenant_access_token;
  tokenExpiry = Date.now() + (data.expire - 120) * 1000; // refresh 2 min early
  log('Feishu token refreshed, expires in', data.expire, 'seconds');
  return cachedToken;
}

async function sendFeishuMessage(text, mentionUserId, mentionName, chatId) {
  const token = await getFeishuToken();

  let msgText = text;
  if (mentionUserId) {
    msgText = `<at user_id="${mentionUserId}">${mentionName || 'user'}</at> ${text}`;
  }

  const result = await httpsPost(
    'open.feishu.cn',
    '/open-apis/im/v1/messages?receive_id_type=chat_id',
    {
      receive_id: chatId || GROUP_CHAT_ID,
      msg_type: 'text',
      content: JSON.stringify({ text: msgText })
    },
    { 'Authorization': `Bearer ${token}` }
  );

  if (result.code !== 0) {
    throw new Error(`Feishu send error: code=${result.code} msg=${result.msg}`);
  }
  return result;
}

function httpsPost(hostname, urlPath, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname, path: urlPath, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...extraHeaders
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve({ raw: data }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(new Error('Request timeout')); });
    req.write(payload);
    req.end();
  });
}

// --- Tailscale ---
function sendNudgeViaTailscale(body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const httpReq = [
      `POST /nudge HTTP/1.1`,
      `Host: ${PEER_IP}:${PEER_PORT}`,
      `Content-Type: application/json`,
      `Content-Length: ${Buffer.byteLength(payload)}`,
      `Connection: close`,
      ``,
      payload
    ].join('\r\n');

    const tc = spawn(TAILSCALE_BIN, [
      '--socket', TS_SOCKET,
      'nc', PEER_IP, String(PEER_PORT)
    ]);

    let output = '';
    let errOutput = '';
    const timer = setTimeout(() => {
      tc.kill();
      reject(new Error(`Tailscale nc timeout (15s) to ${PEER_IP}:${PEER_PORT}`));
    }, 15000);

    tc.stdout.on('data', d => output += d);
    tc.stderr.on('data', d => errOutput += d);

    tc.on('close', (code) => {
      clearTimeout(timer);
      if (errOutput && !output) {
        reject(new Error(`tailscale nc error: ${errOutput}`));
      } else {
        resolve(output || '(empty response)');
      }
    });

    tc.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`spawn error: ${err.message}`));
    });

    tc.stdin.write(httpReq);
    tc.stdin.end();
  });
}

// --- Start ---
server.listen(PORT, '0.0.0.0', () => {
  log(`Feishu Bot Bridge running on :${PORT}`);
  log(`  Peer: ${PEER_IP}:${PEER_PORT}`);
  log(`  Feishu Group: ${GROUP_CHAT_ID}`);
  log(`  Tailscale Socket: ${TS_SOCKET}`);
  log(`  Config: ${CONFIG_PATH}`);
});

// Graceful shutdown
process.on('SIGTERM', () => { log('SIGTERM received, shutting down'); server.close(); process.exit(0); });
process.on('SIGINT', () => { log('SIGINT received, shutting down'); server.close(); process.exit(0); });

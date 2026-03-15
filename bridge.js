const http = require('http');
const https = require('https');
const { spawn } = require('child_process');

const PORT = 18800;
const TS_SOCKET = '/tmp/tailscaled.sock';
const PEER_IP = '100.106.199.126';
const PEER_PORT = 18800;

// OpenClaw Gateway
const GATEWAY_PORT = 18789;
const GATEWAY_TOKEN = '483936709765b34923604dac69b8109b459d1c157ffa1af3';

// Feishu credentials
const FEISHU_APP_ID = 'cli_a93b9ff91c219bc9';
const FEISHU_APP_SECRET = 'tDTIlOFyEp5KbGBZYOQdCdwlrXa32idD';
const GROUP_CHAT_ID = 'oc_997c180ca33a18e1ccdfad6748ec9707';
const HEDOU_BOT_ID = 'ou_562ceb223426668ee9f6ed20820ec590';

let cachedToken = null;
let tokenExpiry = 0;
let stats = { nudgesReceived: 0, nudgesSent: 0, errors: 0, startTime: Date.now() };

const SYSTEM_PROMPT = `You are King (科技绿洲龙虾), Owen's strategic AI partner in a Feishu group chat.
You received a message from another bot (禾斗体育/HeDou) via the Tailscale bridge notification system.
Reply naturally, concisely, and helpfully. Use the same language as the incoming message.
You are in a group chat with Owen and HeDou. Be collaborative and professional.
Keep replies under 200 characters unless more detail is needed.`;

const server = http.createServer(async (req, res) => {
  const body = await getBody(req);

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: Math.floor((Date.now() - stats.startTime) / 1000), stats, ts: Date.now() }));
    return;
  }

  if (req.method === 'POST' && req.url === '/nudge') {
    stats.nudgesReceived++;
    log('Received nudge:', JSON.stringify(body).slice(0, 300));

    try {
      if (body.type === 'feishu_mention' || body.from) {
        const senderName = body.from || 'Unknown';
        const message = body.message || '(empty)';

        // Get AI response with retry (handles gateway restarts)
        let replyText;
        const delays = [0, 2000, 8000]; // retry after 0s, 2s, 8s
        for (let attempt = 0; attempt < delays.length; attempt++) {
          if (attempt > 0) {
            log(`LLM retry ${attempt}/${delays.length - 1}, waiting ${delays[attempt]}ms...`);
            await new Promise(r => setTimeout(r, delays[attempt]));
          }
          try {
            const aiResponse = await callLLM(
              `${senderName} said in the Feishu group (addressed to you): "${message}"`
            );
            const parsed = typeof aiResponse === 'string' ? JSON.parse(aiResponse) : aiResponse;
            replyText = parsed?.choices?.[0]?.message?.content;
            if (replyText) break;
          } catch (err) {
            log(`LLM attempt ${attempt + 1} failed:`, err.message);
            if (attempt === delays.length - 1) {
              log('All LLM retries exhausted, using fallback');
            }
          }
        }

        if (!replyText) {
          replyText = `收到 ${senderName} 的消息：「${message}」`;
        }

        // Send reply to Feishu group
        await sendFeishuMessage(replyText, HEDOU_BOT_ID, '禾斗体育');
        log('Replied in Feishu:', replyText.slice(0, 100));

        // Also send nudge back to notify peer that we replied
        try {
          await sendNudgeViaTailscale({
            type: 'feishu_mention',
            from: '科技绿洲龙虾 (King)',
            message: replyText,
            chat_id: GROUP_CHAT_ID
          });
          log('Sent reverse nudge to peer');
        } catch (e) {
          log('Reverse nudge failed (non-critical):', e.message);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'replied_in_feishu', reply: replyText.slice(0, 100) }));
      } else {
        log('Generic nudge acknowledged');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ack' }));
      }
    } catch (err) {
      stats.errors++;
      log('ERROR:', err.message);
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
      log('ERROR sending:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', error: err.message }));
    }
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

function log(...args) { console.log(`[${new Date().toISOString()}]`, ...args); }

function getBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({}); } });
  });
}

// --- OpenClaw Gateway (LLM) ---
function callLLM(userMessage) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: 'anthropic/claude-sonnet-4-20250514',
      user: 'bridge-bot',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMessage }
      ],
      max_tokens: 512
    });

    const req = http.request({
      hostname: '127.0.0.1', port: GATEWAY_PORT,
      path: '/v1/chat/completions', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GATEWAY_TOKEN}`,
        'X-OpenClaw-Channel': 'bridge',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });

    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(new Error('Gateway timeout 60s')); });
    req.write(payload);
    req.end();
  });
}

// --- Feishu API ---
async function getFeishuToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const data = await httpsPost('open.feishu.cn', '/open-apis/auth/v3/tenant_access_token/internal', {
    app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET
  });
  cachedToken = data.tenant_access_token;
  tokenExpiry = Date.now() + (data.expire - 120) * 1000;
  log('Feishu token refreshed');
  return cachedToken;
}

async function sendFeishuMessage(text, mentionUserId, mentionName) {
  const token = await getFeishuToken();
  let msgText = mentionUserId ? `<at user_id="${mentionUserId}">${mentionName}</at> ${text}` : text;

  const result = await httpsPost('open.feishu.cn',
    '/open-apis/im/v1/messages?receive_id_type=chat_id',
    { receive_id: GROUP_CHAT_ID, msg_type: 'text', content: JSON.stringify({ text: msgText }) },
    { 'Authorization': `Bearer ${token}` }
  );
  if (result.code !== 0) throw new Error(`Feishu error: ${result.code} ${result.msg}`);
  return result;
}

function httpsPost(hostname, path, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...extraHeaders }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({ raw: data }); } });
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
    const httpReq = `POST /nudge HTTP/1.1\r\nHost: ${PEER_IP}:${PEER_PORT}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\nConnection: close\r\n\r\n${payload}`;
    const tc = spawn('/opt/homebrew/bin/tailscale', ['--socket', TS_SOCKET, 'nc', PEER_IP, String(PEER_PORT)]);
    let output = '';
    const timer = setTimeout(() => { tc.kill(); reject(new Error('Timeout 15s')); }, 15000);
    tc.stdout.on('data', d => output += d);
    tc.stderr.on('data', d => output += d);
    tc.on('close', () => { clearTimeout(timer); resolve(output || '(empty)'); });
    tc.on('error', err => { clearTimeout(timer); reject(err); });
    tc.stdin.write(httpReq);
    tc.stdin.end();
  });
}

server.listen(PORT, '0.0.0.0', () => {
  log(`Bridge v4 (with LLM) running on :${PORT}`);
  log(`  LLM: Anthropic API direct | Peer: ${PEER_IP}:${PEER_PORT}`);
});

process.on('SIGTERM', () => { log('Shutting down'); server.close(); process.exit(0); });
process.on('SIGINT', () => { log('Shutting down'); server.close(); process.exit(0); });

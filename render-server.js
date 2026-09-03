/**
 * Render/Railway 一键部署后端: 静态页面 + API 代理
 * - GET  /            → docs/index.html 静态页面
 * - GET  /api/ping    → {render:true} 页面据此进入"免填Key"模式
 * - POST /api/search  → 转发 Nexscope 商品搜索(Key在服务端环境变量)
 * - POST /ai/chat     → 转发智谱GLM流式对话(Key在服务端环境变量)
 *
 * 环境变量:
 *   NEXSCOPE_API_KEY  必填
 *   AI_API_KEY        必填(智谱)
 *   AI_MODEL          选填, 默认 glm-4.5-flash
 *   PORT              平台自动注入
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const https = require('https');

const PORT = process.env.PORT || 8080;
const NEX_KEY = process.env.NEXSCOPE_API_KEY || '';
const AI_KEY = process.env.AI_API_KEY || '';
const AI_BASE = (process.env.AI_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4').replace(/\/+$/, '');
const AI_MODEL = process.env.AI_MODEL || 'glm-4.5-flash';
const DOCS = path.join(__dirname, 'docs');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}
function postJSON(url, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, headers),
      timeout: 60000 }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('timeout', () => req.destroy(new Error('上游超时')));
    req.on('error', reject);
    req.end(body);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && u.pathname === '/api/ping') return json(res, 200, { render: true, ai: !!AI_KEY, nex: !!NEX_KEY });

    if (req.method === 'POST' && u.pathname === '/api/search') {
      if (!NEX_KEY) return json(res, 500, { error: '服务端未配置 NEXSCOPE_API_KEY' });
      const raw = await readBody(req);
      const up = await postJSON('https://api.nexscope.ai/api/skill-api/v1/skills/1688-product-search/run',
        { 'Authorization': 'Bearer ' + NEX_KEY }, raw || '{}');
      res.writeHead(up.status, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(up.body);
    }

    if (req.method === 'POST' && u.pathname === '/ai/chat') {
      if (!AI_KEY) return json(res, 500, { error: '服务端未配置 AI_API_KEY' });
      const raw = await readBody(req);
      const body = JSON.parse(raw || '{}');
      // 智谱带thinking参数; OpenRouter等OpenAI兼容端点不带
      const isZhipu = AI_BASE.includes('bigmodel');
      const payload = JSON.stringify(Object.assign(
        { model: AI_MODEL, stream: true, max_tokens: 4096, messages: body.messages || [] },
        isZhipu ? { thinking: { type: 'enabled' } } : {}));
      const up = await postJSONStream(AI_BASE + '/chat/completions',
        { 'Authorization': 'Bearer ' + AI_KEY }, payload, res);
      return up;
    }

    // 静态文件
    let file = u.pathname === '/' ? '/index.html' : u.pathname;
    file = path.normalize(file).replace(/^(\.\.[\/\\])+/, '');
    const fp = path.join(DOCS, file);
    if (!fp.startsWith(DOCS) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not Found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
    fs.createReadStream(fp).pipe(res);
  } catch (e) {
    try { json(res, 502, { error: String(e.message || e) }); } catch (_) {}
  }
});

// 智谱SSE透传: 上游字节流原样pipe给浏览器
function postJSONStream(url, headers, body, res) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, headers),
      timeout: 120000 }, (up) => {
      res.writeHead(up.statusCode || 502, { 'Content-Type': up.headers['content-type'] || 'text/event-stream', 'Cache-Control': 'no-store' });
      up.pipe(res);
      resolve();
    });
    req.on('timeout', () => req.destroy(new Error('上游超时')));
    req.on('error', (e) => { try { json(res, 502, { error: String(e.message || e) }); } catch (_) {} resolve(); });
    req.end(body);
  });
}

server.listen(PORT, () => {
  console.log(`✅ 1688Products 后端已启动: http://localhost:${PORT}`);
  console.log(`   Nexscope Key ${NEX_KEY ? '已加载' : '缺失!'} | AI Key ${AI_KEY ? '已加载' : '缺失!'}`);
});

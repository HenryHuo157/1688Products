/**
 * Nexscope API 跨域代理 (Cloudflare Worker)
 *
 * 部署步骤(约5分钟, 免费额度每天10万次请求, 足够测试):
 *  1. 注册/登录 https://dash.cloudflare.com
 *  2. 左侧菜单 Workers & Pages → Create → Create Worker → 随便起个名字 → Deploy
 *  3. 点 Edit code, 把本文件全部代码粘贴进去, 替换原有内容 → Deploy
 *  4. 回到 Worker 页面复制你的地址, 形如 https://xxx.your-name.workers.dev
 *  5. 打开演示页面 → ⚙ 设置密钥 → 把地址填进「Nexscope 代理地址」→ 保存
 *
 * 说明: Worker 只做请求转发, 不存储任何 Key (Key 由每个使用者在自己浏览器里填写)。
 */
export default {
  async fetch(request) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'authorization, content-type',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/skill-api/')) {
      return new Response(JSON.stringify({ error: 'path must start with /api/skill-api/' }),
        { status: 404, headers: { ...cors, 'Content-Type': 'application/json' } });
    }
    try {
      const upstream = await fetch('https://api.nexscope.ai' + url.pathname, {
        method: 'POST',
        headers: { 'Authorization': request.headers.get('Authorization') || '', 'Content-Type': 'application/json' },
        body: request.body,
      });
      const headers = new Headers(upstream.headers);
      Object.entries(cors).forEach(([k, v]) => headers.set(k, v));
      return new Response(upstream.body, { status: upstream.status, headers });
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e) }),
        { status: 502, headers: { ...cors, 'Content-Type': 'application/json' } });
    }
  },
};

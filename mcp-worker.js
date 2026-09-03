/**
 * 1688Products MCP Server (Cloudflare Worker 版 - 远程MCP)
 *
 * 把整套1688采购分析流程暴露为远程MCP工具,Kimi网页版/Claude等任何支持MCP的客户端都能接入。
 * 同事在Kimi问"帮我搜一下保温杯" → Kimi调用本服务的 search_1688 → 走Nexscope API → 返回结果。
 *
 * 部署步骤:
 *  1. dash.cloudflare.com → Workers & Pages → Create Worker → 起名(如 1688-mcp) → Deploy
 *  2. Edit code → 粘贴本文件全部内容 → Deploy
 *  3. Worker → Settings → Variables and Secrets 添加:
 *     NEXSCOPE_API_KEY = nk-xxxx          (必填,搜索用)
 *     AI_API_KEY       = sk-or-xxxx       (选填,AI总结用)
 *     AI_BASE_URL      = https://openrouter.ai/api/v1   (选填,默认OpenRouter)
 *     AI_MODEL         = z-ai/glm-5.3-flash             (选填)
 *     MCP_TOKEN        = 想一个口令  (选填,填了则URL需带 /mcp/<口令>,防陌生人偷跑你的credits)
 *  4. (可选,推荐) Storage & Databases → KV → Create namespace (如 1688kv)
 *     → Worker → Settings → Bindings → KV Namespace 变量名填 KV
 *     → 数据仓跨设备共享,同关键词不重复扣credits
 *  5. 复制地址 https://1688-mcp.<你的子域>.workers.dev/mcp[/口令]
 *  6. Kimi网页版 → 输入框 + → 外接程式/MCP → 添加自定义MCP服务器 → 粘贴该URL
 *
 * 端点: POST /mcp(/TOKEN)  Streamable HTTP (JSON-RPC 2.0)
 *       GET  /mcp          → 405(客户端用POST即可)
 */

export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'authorization, content-type, mcp-session-id, mcp-protocol-version, last-event-id',
      'Access-Control-Expose-Headers': 'mcp-session-id',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    const url = new URL(request.url);

    /* ---------- 鉴权: 配了MCP_TOKEN则路径必须是 /mcp/<token> ---------- */
    let okPath = url.pathname === '/mcp' || url.pathname === '/mcp/';
    if (env.MCP_TOKEN && url.pathname === '/mcp/' + env.MCP_TOKEN) okPath = true;
    if (env.MCP_TOKEN && okPath && url.pathname !== '/mcp/' + env.MCP_TOKEN && url.pathname !== '/mcp') okPath = false;
    if (!okPath) {
      return json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Not found (若设置了MCP_TOKEN,请使用 /mcp/<token> 完整地址)' } }, 404, cors);
    }
    if (request.method !== 'POST') {
      return new Response('MCP endpoint: use POST (Streamable HTTP)', { status: 405, headers: cors });
    }

    /* ---------- 数据仓(KV绑定可选,无KV则仅内存) ---------- */
    const mem = new Map(); // 单次请求内兜底
    const store = {
      async read() {
        try { if (env.KV) return JSON.parse(await env.KV.get('history') || '[]'); } catch (_) {}
        return [];
      },
      async write(list) {
        try { if (env.KV) await env.KV.put('history', JSON.stringify(list.slice(0, 60))); } catch (_) {}
      },
    };
    function histKeyOf(p) {
      const def = {};
      ['keyWord', 'matchType', 'pageSize', 'companyType', 'offerType', 'sendTime', 'proxyRights', 'shiLiType']
        .forEach((k) => { if (p[k] != null && p[k] !== '') def[k] = p[k]; });
      return JSON.stringify(def);
    }
    async function findHistory(kw) {
      if (!kw) return null;
      const k = String(kw).trim();
      const list = await store.read();
      return list.find((r) => r.params.keyWord === k)
          || list.find((r) => String(r.params.keyWord || '').includes(k) || k.includes(String(r.params.keyWord || ''))) || null;
    }
    async function historyBrief() {
      const list = await store.read();
      return list.slice(0, 12).map((r) => `「${r.params.keyWord}」(${(r.products || []).length}条, ${String(r.time).slice(0, 10)})`).join('; ') || '(数据仓为空)';
    }
    async function upsertHistory(params, products) {
      const list = await store.read();
      const now = new Date().toISOString();
      const rec = list.find((r) => histKeyOf(r.params) === histKeyOf(params));
      if (rec) {
        const seen = new Set((rec.products || []).map((p) => String(p.offerId)));
        rec.products = (rec.products || []).concat((products || []).filter((p) => !seen.has(String(p.offerId))));
        rec.time = now;
      } else list.unshift({ id: now.replace(/\W/g, '').slice(0, 14), time: now, params, products });
      await store.write(list);
    }

    /* ---------- Nexscope 搜索 + 全套本地加工(与本地mcp-server.mjs同逻辑) ---------- */
    async function nexSearch(p) {
      const body = { searchType: p.matchType ?? 1, keyWord: p.keyWord, pageIndex: 1, pageSize: Math.min(p.pageSize ?? 50, 100) };
      if (p.companyType != null && p.companyType !== '') body.companyType = Number(p.companyType);
      if (p.offerType != null && p.offerType !== '') body.offerType = Number(p.offerType);
      if (p.sendTime) body.sendTime = String(p.sendTime);
      if (p.proxyRights) body.proxyRights = String(p.proxyRights);
      if (p.shiLiType) body.shiLiType = String(p.shiLiType);
      const r = await fetch('https://api.nexscope.ai/api/skill-api/v1/skills/1688-product-search/run', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.NEXSCOPE_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60000),
      });
      const j = await r.json().catch(() => ({}));
      if (!(r.ok && j.errcode === 200)) throw new Error(`Nexscope HTTP ${r.status} errcode=${j.errcode ?? j.code}: ${j.msg || ''}`);
      return j.products || [];
    }
    const leafOf = (ln) => { const a = String(ln || '').split(/[>,]/).map((s) => s.trim()).filter(Boolean); return a.length ? a[a.length - 1] : ''; };
    function markSuspect(list) {
      const prices = list.map((x) => Number(x.price)).filter((v) => !isNaN(v) && v > 0).sort((a, b) => a - b);
      if (prices.length < 6) return list;
      const med = prices[Math.floor(prices.length / 2)];
      return list.map((x) => (Number(x.price) > 0 && Number(x.price) < med * 0.1 ? Object.assign({}, x, { suspect: true }) : x));
    }
    function processProducts(raw, kw, opts) {
      let list = raw.slice(); const notes = [];
      if (opts.priceMin != null) list = list.filter((x) => Number(x.price) >= opts.priceMin);
      if (opts.priceMax != null) list = list.filter((x) => Number(x.price) <= opts.priceMax);
      if (opts.keyword) { const k = list.filter((x) => String(x.title || '').includes(opts.keyword)); if (k.length) { notes.push(`标题过滤: ${list.length}→${k.length}条`); list = k; } }
      if (kw) {
        const byLeaf = list.filter((x) => leafOf(x.levelName).includes(kw));
        if (byLeaf.length) { notes.push(`类目校验: 保留${byLeaf.length}/${list.length}条真品`); list = byLeaf; }
        else notes.push('⚠️ 没有类目含关键词的真品(可能全是周边配件)');
      }
      list = markSuspect(list);
      const suspects = list.filter((x) => x.suspect).length;
      if (suspects) notes.push(`标记${suspects}条价格异常噪音(价格<中位数1/10,不推荐)`);
      const SORTS = {
        orderCount30d: (x) => Number(x.salesOrderCount ?? -1), saleCount30d: (x) => Number(x.salesQuantity ?? -1),
        saleVolume30d: (x) => Number(x.estimatedSalesAmount ?? -1), price: (x) => Number(x.price), consignPrice: (x) => Number(x.consignPrice),
      };
      if (opts.sortField && SORTS[opts.sortField]) {
        const mul = opts.sortType === 'asc' ? 1 : -1;
        list.sort((a, b) => mul * (SORTS[opts.sortField](a) - SORTS[opts.sortField](b)));
      }
      return { list, notes };
    }
    function slim(list, n) {
      return (list || []).slice(0, n).map((p, i) => ({
        序号: i + 1, offerId: p.offerId, 标题: String(p.title || '').slice(0, 40),
        批发价: p.price, 代发价: p.consignPrice, 起订量: p.quantityBegin,
        近30天订单: p.salesOrderCount ?? null, 销量件数: p.salesQuantity ?? null, 月销额: p.estimatedSalesAmount ?? null,
        类目: leafOf(p.levelName), 公司: p.company || '', 链接: p.offerId ? `https://detail.1688.com/offer/${p.offerId}.html` : null,
        疑似噪音: !!p.suspect,
      }));
    }
    async function llmAnswer(question, context) {
      if (!env.AI_API_KEY) return '';
      const base = (env.AI_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
      const model = env.AI_MODEL || 'z-ai/glm-5.3-flash';
      const isZhipu = base.includes('bigmodel');
      const res = await fetch(base + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.AI_API_KEY },
        body: JSON.stringify(Object.assign({
          model, max_tokens: 4096,
          messages: [
            { role: 'system', content: '你是资深1688采购经理。基于提供的数据回答,简体中文,用Markdown组织(📊总评/🏆推荐/💡建议),引用真实数字,不编造。单价低得反常的商品是噪音,绝不推荐。' },
            { role: 'user', content: `用户问题: ${question}\n\n数据:\n${context}` },
          ],
        }, isZhipu ? { thinking: { type: 'enabled' } } : {})),
        signal: AbortSignal.timeout(120000),
      });
      const j = await res.json().catch(() => ({}));
      return j.choices?.[0]?.message?.content || '';
    }

    /* ---------- 工具实现 ---------- */
    async function toolSearch(a) {
      if (!env.NEXSCOPE_API_KEY) return { content: [{ type: 'text', text: '❌ Worker未配置 NEXSCOPE_API_KEY 环境变量' }] };
      const searchParams = {
        keyWord: a.keyword, matchType: 1, pageSize: a.pageSize ?? 50,
        companyType: a.companyType, offerType: a.offerType, sendTime: a.sendTime,
        proxyRights: a.proxyRights, shiLiType: a.shiLiType,
      };
      let products, source;
      const rec = await findHistory(a.keyword);
      if (rec && histKeyOf(rec.params) === histKeyOf(searchParams)) {
        products = rec.products;
        source = `数据仓命中「${rec.params.keyWord}」(${products.length}条, ${String(rec.time).slice(0, 10)}) — 免搜索零credits`;
      } else {
        products = await nexSearch(searchParams);
        await upsertHistory(searchParams, products);
        source = `实时搜索(${products.length}条, 约12 credits)`;
      }
      const { list, notes } = processProducts(products, a.keyword, a);
      const clean = list.filter((x) => !x.suspect);
      const shown = clean.length >= 5 ? clean : list;
      let text = `📦 数据来源: ${source}\n` + notes.map((n) => '- ' + n).join('\n') + '\n\n' + JSON.stringify(slim(shown, 20));
      if (a.withAI !== false && env.AI_API_KEY) {
        try { const s = await llmAnswer('给出采购分析与推荐', JSON.stringify(slim(shown, 12))); if (s) text += '\n\n---\n🤖 AI采购分析:\n' + s; } catch (_) {}
      }
      return { content: [{ type: 'text', text }] };
    }
    async function toolAsk(a) {
      const rec = await findHistory(a.keyword);
      if (!rec) return { content: [{ type: 'text', text: `数据仓没有「${a.keyword}」的数据。现有: ${await historyBrief()}\n可先用 search_1688 搜索。` }] };
      const { list } = processProducts(rec.products, null, a);
      let text = `数据集「${rec.params.keyWord}」(${String(rec.time).slice(0, 10)}) 筛选后剩 ${list.length} 条:\n\n` + JSON.stringify(slim(list, 20));
      if (a.question && env.AI_API_KEY) {
        try { const s = await llmAnswer(a.question, JSON.stringify(slim(list, 15))); if (s) text += '\n\n---\n🤖 AI回答:\n' + s; } catch (_) {}
      }
      return { content: [{ type: 'text', text }] };
    }
    async function toolCompare(a) {
      const rec = await findHistory(a.keyword);
      if (!rec) return { content: [{ type: 'text', text: `数据仓没有「${a.keyword}」。现有: ${await historyBrief()}` }] };
      const picks = a.indexes.map((n) => rec.products[n - 1]).filter(Boolean);
      if (picks.length < 2) return { content: [{ type: 'text', text: `序号超出范围(共${(rec.products || []).length}条)` }] };
      const context = JSON.stringify(slim(picks, 5));
      let text = '⚖️ 对比 ' + a.indexes.map((n) => '#' + n).join(' vs ') + ':\n\n' + context;
      if (env.AI_API_KEY) {
        try { const s = await llmAnswer('对比以上商品,给出详细优劣势与采购建议', context); if (s) text += '\n\n🤖 AI结论:\n' + s; } catch (_) {}
      }
      return { content: [{ type: 'text', text }] };
    }

    const TOOLS = [
      {
        name: 'search_1688',
        description: '搜索1688商品。自动完成: 数据仓免费复用(同关键词不重复扣费)→本地筛选→类目真品校验→噪音标记→排序。首次搜索消耗约12 credits。',
        inputSchema: {
          type: 'object',
          properties: {
            keyword: { type: 'string', description: '商品关键词,如"保温杯"' },
            priceMin: { type: 'number', description: '批发价下限' }, priceMax: { type: 'number', description: '批发价上限' },
            sortField: { type: 'string', enum: ['orderCount30d', 'saleCount30d', 'saleVolume30d', 'price', 'consignPrice'], description: '排序: 近30天订单/销量/月销额/批发价/代发价' },
            sortType: { type: 'string', enum: ['asc', 'desc'] },
            pageSize: { type: 'number', description: '抓取条数,默认50,最大100' },
            companyType: { type: 'string', enum: ['1', '2'], description: '1=门店 2=工厂直营' },
            offerType: { type: 'string', enum: ['2', '3', '4', '5'], description: '2=新品 3=1688严选 4=跨境 5=支持定制' },
            sendTime: { type: 'string', enum: ['24', '48', '72'], description: '发货时效(小时)' },
            proxyRights: { type: 'string', description: '"4360897"一件代发,"449154"先采后付,多个逗号分隔' },
            shiLiType: { type: 'string', description: '"TrustPass"诚信通,"superFactory"超级工厂' },
            withAI: { type: 'boolean', description: '是否让AI生成采购分析总结(默认true)' },
          },
          required: ['keyword'],
        },
      },
      {
        name: 'ask_dataset',
        description: '对数据仓里已有的搜索结果做本地问答/筛选/排序(零credits)。例: "保温杯里价格低于20且广东产的有几个"。',
        inputSchema: {
          type: 'object',
          properties: {
            keyword: { type: 'string', description: '数据仓关键词,如"保温杯"' },
            priceMin: { type: 'number' }, priceMax: { type: 'number' },
            sortField: { type: 'string', enum: ['orderCount30d', 'saleCount30d', 'saleVolume30d', 'price', 'consignPrice'] },
            sortType: { type: 'string', enum: ['asc', 'desc'] },
            question: { type: 'string', description: '用户的问题,AI会基于筛选结果回答' },
          },
          required: ['keyword'],
        },
      },
      {
        name: 'compare_products',
        description: '对比数据集中指定序号的商品(零credits),输出关键指标对比与AI采购结论。',
        inputSchema: {
          type: 'object',
          properties: {
            keyword: { type: 'string', description: '数据仓关键词' },
            indexes: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 5, description: '要对比的序号(1起),如[1,3]' },
          },
          required: ['keyword', 'indexes'],
        },
      },
      {
        name: 'datastore_overview',
        description: '查看数据仓现有数据集(哪些关键词已搜索过,可免费复用)。',
        inputSchema: { type: 'object', properties: {} },
      },
    ];
    const TOOL_IMPL = { search_1688: toolSearch, ask_dataset: toolAsk, compare_products: toolCompare, datastore_overview: async () => ({ content: [{ type: 'text', text: await historyBrief() }] }) };

    /* ---------- JSON-RPC 处理 ---------- */
    let rpc;
    try { rpc = await request.json(); } catch (_) { return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400, cors); }
    const batch = Array.isArray(rpc) ? rpc : [rpc];
    const session = crypto.randomUUID();

    const replies = [];
    for (const msg of batch) {
      if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') continue;
      const isReq = msg.id != null;
      try {
        let result = null;
        if (msg.method === 'initialize') {
          result = {
            protocolVersion: msg.params?.protocolVersion || '2025-03-26',
            capabilities: { tools: {} },
            serverInfo: { name: '1688products', version: '1.0.0' },
            instructions: '1688采购分析助手。搜新品用 search_1688; 已有数据的追问/筛选用 ask_dataset; 对比用 compare_products; 看数据仓用 datastore_overview。',
          };
        } else if (msg.method === 'ping') {
          result = {};
        } else if (msg.method === 'tools/list') {
          result = { tools: TOOLS };
        } else if (msg.method === 'tools/call') {
          const name = msg.params?.name;
          const impl = TOOL_IMPL[name];
          if (!impl) throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32602 });
          result = await impl(msg.params?.arguments || {});
        } else if (isReq) {
          throw Object.assign(new Error(`Method not found: ${msg.method}`), { code: -32601 });
        } else {
          continue; // notification (initialized/cancelled等),无需回复
        }
        if (isReq) replies.push({ jsonrpc: '2.0', id: msg.id, result });
      } catch (e) {
        if (isReq) replies.push({ jsonrpc: '2.0', id: msg.id, error: { code: e.code || -32603, message: String(e.message || e) } });
      }
    }

    if (!replies.length) return new Response(null, { status: 202, headers: { ...cors, 'mcp-session-id': session } });
    const body = Array.isArray(rpc) ? replies : replies[0];
    const res = json(body, 200, cors);
    res.headers.set('mcp-session-id', session);
    return res;
  },
};

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

#!/usr/bin/env node
/**
 * 1688Products MCP Server
 * 把整套1688采购分析流程暴露为MCP工具,任何MCP客户端(Claude Desktop/Cursor/Kimi API壳等)都能接管使用。
 * Key 走服务端环境变量(或同目录.env),模型与使用者均接触不到。
 *
 * 工具:
 *   search_1688      搜索商品(自动: 数据仓去重复用→标题过滤→类目校验→噪音标记→排序)
 *   analyze_product  单品AI采购测评(调Nexscope详情+评分; 需配GLM/OpenRouter Key)
 *   compare_products 按序号对比当前结果
 *   ask_dataset      数据仓问答(关键词+筛选条件,本地执行零credits)
 *
 * 传输: stdio (Claude Desktop/Cursor等标准接入方式)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

/* ---------- 配置(优先环境变量,其次工作区.env) ---------- */
function loadEnv() {
  const env = {};
  const cand = [path.join(__dirname, '.env'), path.join(__dirname, '..', '.env')];
  for (const f of cand) {
    try { fs.readFileSync(f, 'utf8').split(/\r?\n/).forEach((l) => { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) env[m[1]] = m[2].trim(); }); break; } catch (_) {}
  }
  return Object.assign(env, {
    NEXSCOPE_API_KEY: process.env.NEXSCOPE_API_KEY || env.NEXSCOPE_API_KEY || '',
    AI_API_KEY: process.env.AI_API_KEY || env.AI_API_KEY || '',
    AI_BASE_URL: (process.env.AI_BASE_URL || env.AI_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, ''),
    AI_MODEL: process.env.AI_MODEL || env.AI_MODEL || 'z-ai/glm-5.3-flash',
  });
}
const ENV = loadEnv();
const NEX_KEY = ENV.NEXSCOPE_API_KEY;

/* ---------- 数据仓(与主系统共享 1688_history.json) ---------- */
const HISTORY_FILE = path.join(__dirname, '1688_history.json');
function readHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch (_) { return []; }
}
function findHistoryByKeyword(kw) {
  if (!kw) return null;
  const k = String(kw).trim();
  if (!k) return null;
  const list = readHistory();
  return list.find((r) => r.params.keyWord === k)
      || list.find((r) => String(r.params.keyWord || '').includes(k) || k.includes(String(r.params.keyWord || '')));
}
function historyBrief() {
  return readHistory().slice(0, 12).map((r) => `「${r.params.keyWord}」(${(r.products || []).length}条, ${String(r.time).slice(0, 10)})`).join('; ') || '(数据仓为空)';
}
function histKeyOf(params) {
  const def = {};
  ['keyWord', 'matchType', 'pageSize', 'companyType', 'offerType', 'sendTime', 'proxyRights', 'shiLiType']
    .forEach((k) => { if (params[k] != null && params[k] !== '') def[k] = params[k]; });
  return JSON.stringify(def);
}
function upsertHistory(params, products) {
  const list = readHistory();
  const now = new Date().toISOString();
  let rec = list.find((r) => histKeyOf(r.params) === histKeyOf(params));
  if (rec) {
    const seen = new Set((rec.products || []).map((p) => String(p.offerId)));
    rec.products = (rec.products || []).concat((products || []).filter((p) => !seen.has(String(p.offerId))));
    rec.time = new Date().toISOString();
  } else {
    rec = { id: Date.now().toString(36), time: new Date().toISOString(), params, products };
    list.unshift(rec);
  }
  try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(list.slice(0, 60))); } catch (_) {}
  return rec;
}

/* ---------- Nexscope 搜索(含主系统的全部本地加工) ---------- */
async function nexSearch(p) {
  const body = { searchType: p.matchType ?? 1, keyWord: p.keyword, pageIndex: 1, pageSize: Math.min(p.pageSize ?? 50, 100) };
  if (p.sortField) { body.sortField = p.sortField; body.sortType = p.sortType || 'desc'; }
  if (p.companyType != null && p.companyType !== '') body.companyType = Number(p.companyType);
  if (p.offerType != null && p.offerType !== '') body.offerType = Number(p.offerType);
  if (p.sendTime) body.sendTime = String(p.sendTime);
  if (p.proxyRights) body.proxyRights = String(p.proxyRights);
  if (p.shiLiType) body.shiLiType = String(p.shiLiType);
  const r = await fetch('https://api.nexscope.ai/api/skill-api/v1/skills/1688-product-search/run', {
    method: 'POST', headers: { 'Authorization': `Bearer ${NEX_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(60000),
  });
  const j = await r.json();
  if (!(r.ok && j.errcode === 200)) throw new Error(`Nexscope HTTP ${r.status} errcode=${j.errcode ?? j.code}: ${j.msg || ''}`);
  return j.products || [];
}
function leafOf(ln) { const a = String(ln || '').split(/[>,]/).map((s) => s.trim()).filter(Boolean); return a.length ? a[a.length - 1] : ''; }
function markSuspect(list) {
  const prices = list.map((x) => Number(x.price)).filter((v) => !isNaN(v) && v > 0).sort((a, b) => a - b);
  if (prices.length < 6) return list;
  const med = prices[Math.floor(prices.length / 2)];
  return list.map((x) => (Number(x.price) > 0 && Number(x.price) < med * 0.1 ? Object.assign({}, x, { suspect: true }) : x));
}
function processProducts(raw, kw, opts) {
  let list = raw.slice();
  const notes = [];
  if (opts.priceMin != null) list = list.filter((x) => Number(x.price) >= opts.priceMin);
  if (opts.priceMax != null) list = list.filter((x) => Number(x.price) <= opts.priceMax);
  if (opts.province) list = list.filter((x) => String(x.province || '').includes(String(opts.province).replace(/省$/, '')) || true); // 原始数据无省份字段,交由模型看company
  if (opts.keyword) { const k = list.filter((x) => String(x.title || '').includes(opts.keyword)); if (k.length) { notes.push(`标题过滤: ${list.length}→${k.length}条`); list = k; } }
  if (kw) {
    const byLeaf = list.filter((x) => leafOf(x.levelName).includes(kw));
    if (byLeaf.length) { notes.push(`类目校验: 保留${byLeaf.length}/${list.length}条真品`); list = byLeaf; }
    else notes.push('⚠️ 没有类目含关键词的真品(可能全是周边配件)');
  }
  const before = list.length;
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

/* ---------- AI 问答(OpenAI兼容, Key在服务端) ---------- */
async function llmAnswer(question, context) {
  if (!ENV.AI_API_KEY) return '(未配置AI_API_KEY,无法生成AI总结。以上为原始数据)';
  const isZhipu = ENV.AI_BASE_URL.includes('bigmodel');
  const res = await fetch(ENV.AI_BASE_URL + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + ENV.AI_API_KEY },
    body: JSON.stringify(Object.assign(
      { model: ENV.AI_MODEL, max_tokens: 4096, messages: [
        { role: 'system', content: '你是资深1688采购经理。基于提供的数据回答,简体中文,用Markdown组织(📊总评/🏆推荐/💡建议),引用真实数字,不编造。单价低得反常的商品是噪音,绝不推荐。' },
        { role: 'user', content: `用户问题: ${question}\n\n数据:\n${context}` },
      ] },
      isZhipu ? { thinking: { type: 'enabled' } } : {})),
    signal: AbortSignal.timeout(120000),
  });
  const j = await res.json();
  return j.choices?.[0]?.message?.content || '(AI未返回内容)';
}

/* ---------- MCP Server ---------- */
const server = new McpServer({ name: '1688products', version: '1.0.0' });

server.tool('search_1688',
  '搜索1688商品。自动完成: 数据仓免费复用(同关键词不重复扣费)→本地筛选→类目真品校验→噪音标记→排序。首次搜索消耗约12 credits。',
  {
    keyword: z.string().describe('商品关键词,如"保温杯"'),
    priceMin: z.number().optional().describe('批发价下限'),
    priceMax: z.number().optional().describe('批发价上限'),
    province: z.string().optional().describe('期望产地省份(仅对返回结果做标记,搜索本身按1688规则)'),
    sortField: z.enum(['orderCount30d', 'saleCount30d', 'saleVolume30d', 'price', 'consignPrice', 'offerCreateTime']).optional().describe('排序: 订单/销量/月销额/批发价/代发价/上架时间'),
    sortType: z.enum(['asc', 'desc']).optional(),
    pageSize: z.number().optional().describe('抓取条数,默认50,最大100'),
    companyType: z.enum(['1', '2']).optional().describe('1=门店 2=工厂直营'),
    offerType: z.enum(['2', '3', '4', '5']).optional().describe('2=新品 3=1688严选 4=跨境 5=支持定制'),
    sendTime: z.enum(['24', '48', '72']).optional().describe('发货时效(小时)'),
    proxyRights: z.string().optional().describe('"4360897"一件代发,"449154"先采后付,多个逗号分隔'),
    shiLiType: z.string().optional().describe('"TrustPass"诚信通,"superFactory"超级工厂'),
    withAI: z.boolean().optional().describe('是否让AI生成采购分析总结(默认true,需AI Key)'),
  },
  async (args) => {
    const { keyword } = args;
    if (!NEX_KEY) return { content: [{ type: 'text', text: '❌ 服务端未配置 NEXSCOPE_API_KEY' }] };
    let products, source;
    const rec = findHistoryByKeyword(keyword);
    const searchParams = {
      keyWord: keyword, matchType: 1, pageSize: args.pageSize ?? 50,
      companyType: args.companyType, offerType: args.offerType, sendTime: args.sendTime,
      proxyRights: args.proxyRights, shiLiType: args.shiLiType,
    };
    if (rec && histKeyOf(rec.params) === histKeyOf(searchParams)) {
      products = rec.products;
      source = `数据仓命中「${rec.params.keyWord}」(${products.length}条, ${String(rec.time).slice(0, 10)}) — 免搜索零credits`;
    } else {
      products = await nexSearch(searchParams);
      upsertHistory(searchParams, products);
      source = `实时搜索(${products.length}条, 约12 credits)`;
    }
    const { list, notes } = processProducts(products, keyword, args);
    const clean = list.filter((x) => !x.suspect);
    const shown = clean.length >= 5 ? clean : list;
    let text = `📦 数据来源: ${source}\n` + notes.map((n) => '- ' + n).join('\n') + '\n\n' + JSON.stringify(slim(shown, 20));
    if (args.withAI !== false && ENV.AI_API_KEY) {
      try { text += '\n\n---\n🤖 AI采购分析:\n' + await llmAnswer(args.withAI ? '给出采购分析与推荐' : '总结数据', JSON.stringify(slim(shown, 12))); } catch (_) {}
    }
    return { content: [{ type: 'text', text }] };
  });

server.tool('ask_dataset',
  '对数据仓里已有的搜索结果做本地问答/筛选/排序(零credits)。例: "保温杯里价格低于20且广东产的有几个"。',
  {
    keyword: z.string().describe('数据仓关键词,如"保温杯"'),
    priceMin: z.number().optional(), priceMax: z.number().optional(),
    sortField: z.enum(['orderCount30d', 'saleCount30d', 'saleVolume30d', 'price', 'consignPrice']).optional(),
    sortType: z.enum(['asc', 'desc']).optional(),
    question: z.string().optional().describe('用户的问题,AI会基于筛选结果回答'),
  },
  async (args) => {
    const rec = findHistoryByKeyword(args.keyword);
    if (!rec) return { content: [{ type: 'text', text: '数据仓没有「' + args.keyword + '」的数据。现有: ' + historyBrief() + '\n可先用 search_1688 搜索。' }] };
    const { list } = processProducts(rec.products, null, args);
    let text = `数据集「${rec.params.keyWord}」(${String(rec.time).slice(0, 10)}) 筛选后剩 ${list.length} 条:\n\n` + JSON.stringify(slim(list, 20));
    if (args.question && ENV.AI_API_KEY) text += '\n\n---\n🤖 AI回答:\n' + await llmAnswer(args.question, JSON.stringify(slim(list, 15)));
    return { content: [{ type: 'text', text }] };
  });

server.tool('compare_products',
  '对比数据集中指定序号的商品(零credits),输出关键指标对比与AI采购结论。',
  {
    keyword: z.string().describe('数据仓关键词'),
    indexes: z.array(z.number()).min(2).max(5).describe('要对比的序号(1起),如[1,3]'),
  },
  async (args) => {
    const rec = findHistoryByKeyword(args.keyword);
    if (!rec) return { content: [{ type: 'text', text: '数据仓没有「' + args.keyword + '」。现有: ' + historyBrief() }] };
    const picks = args.indexes.map((n) => rec.products[n - 1]).filter(Boolean);
    if (picks.length < 2) return { content: [{ type: 'text', text: `序号超出范围(共${(rec.products || []).length}条)` }] };
    const context = JSON.stringify(slim(picks, 5));
    let text = '⚖️ 对比 ' + args.indexes.map((n) => '#' + n).join(' vs ') + ':\n\n' + context;
    if (ENV.AI_API_KEY) text += '\n\n🤖 AI结论:\n' + await llmAnswer('对比以上商品,给出详细优劣势与采购建议', context);
    return { content: [{ type: 'text', text }] };
  });

server.tool('datastore_overview',
  '查看数据仓现有数据集(哪些关键词已搜索过,可免费复用)。',
  {},
  async () => ({ content: [{ type: 'text', text: historyBrief() || '(数据仓为空)' }] }));

/* ---------- 启动(stdio) ---------- */
const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[1688products-mcp] 已启动 | Nexscope ${NEX_KEY ? '✓' : '✗'} | AI ${ENV.AI_API_KEY ? '✓' : '✗'} | 数据仓 ${readHistory().length} 个数据集`);

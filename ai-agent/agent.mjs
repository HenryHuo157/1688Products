#!/usr/bin/env node
/**
 * Nexscope AI 采购助手 — LangGraph.js 编排的独立服务
 * 端口 3001 · 依赖 ../.env 里的 AI_API_KEY(GLM)与 NEXSCOPE_API_KEY
 *
 * 能力: 自然语言 → 搜索1688 → 本地过滤 → 产地推断 → (确认后)详情精查尺寸 → 人话总结
 * 成本: 搜索12cr/次 · 详情精查2cr/条(执行前先报价等确认) · GLM免费
 */
import fs from 'fs';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';
import { ChatOpenAI } from '@langchain/openai';
import { Annotation, StateGraph, START, END, interrupt, Command, MemorySaver } from '@langchain/langgraph';
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ---------- 配置 ---------- */
const ENV = {};
try {
  fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/).forEach((l) => {
    const m = l.match(/^([A-Z_]+)=(.*)$/);
    if (m) ENV[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  });
} catch (_) {}
const NEX_KEY = process.env.NEXSCOPE_API_KEY || ENV.NEXSCOPE_API_KEY || '';
const AI_KEY = process.env.AI_API_KEY || ENV.AI_API_KEY || '';
const AI_BASE = (process.env.AI_BASE_URL || ENV.AI_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4').replace(/\/+$/, '');
const AI_MODEL = process.env.AI_MODEL || ENV.AI_MODEL || 'glm-4-flash';
const MAX_ENRICH = 25;          // 单次尺寸精查上限(条)
const ENRICH_PRICE = 2;         // 每条详情消耗credits
const PORT = 3001;

const log = (s) => console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${s}`);

const llm = new ChatOpenAI({
  model: AI_MODEL, apiKey: AI_KEY, temperature: 0.3, maxTokens: 4096, maxRetries: 1,
  configuration: { baseURL: AI_BASE },
  modelKwargs: { thinking: { type: 'enabled' } },  // GLM-4.5系列思考链(最终回答用)
});
// 意图解析/JSON提取用: 关思考、低温,保证JSON稳定且不被思考挤占token
const llmFast = new ChatOpenAI({
  model: AI_MODEL, apiKey: AI_KEY, temperature: 0.1, maxTokens: 2048, maxRetries: 1,
  configuration: { baseURL: AI_BASE },
  modelKwargs: { thinking: { type: 'disabled' } },
});

/* ---------- LLM JSON 输出工具 ---------- */
function extractJSON(txt) {
  let t = String(txt).replace(/```(json)?/gi, '').trim();
  const s = t.search(/[\[{]/);
  if (s === -1) throw new Error('LLM未返回JSON');
  const e = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
  return JSON.parse(t.slice(s, e + 1));
}
async function askJSON(system, user) {
  const res = await llmFast.invoke([{ role: 'system', content: system }, { role: 'user', content: user }]);
  return extractJSON(String(res.content));
}

/* ---------- Nexscope 接口 ---------- */
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
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => null);
  if (r.status !== 200 || !j || j.errcode !== 200) throw new Error(`搜索失败: ${(j && (j.msg || j.errmsg)) || 'HTTP ' + r.status}`);
  return j.products || [];
}
async function nexDetail(offerId) {
  const r = await fetch('https://api.nexscope.ai/api/skill-api/v1/skills/1688-product-detail/run', {
    method: 'POST', headers: { 'Authorization': `Bearer ${NEX_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ offerId: String(offerId) }),
  });
  const j = await r.json().catch(() => null);
  if (r.status !== 200 || !j || !j.product) throw new Error(`详情失败: ${(j && (j.msg || j.errmsg)) || 'HTTP ' + r.status}`);
  return j.product;
}
async function pool(items, worker, concurrency = 3) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) { const idx = i++; try { out[idx] = await worker(items[idx], idx); } catch (e) { out[idx] = { error: e.message }; } }
  }));
  return out;
}

/* ---------- 省份推断 ---------- */
const CITY_MAP = [ // 常见产业带城市 → 省份(关键词命中即免LLM)
  ['义乌', '浙江'], ['杭州', '浙江'], ['宁波', '浙江'], ['温州', '浙江'], ['台州', '浙江'], ['永康', '浙江'], ['金华', '浙江'], ['嘉兴', '浙江'], ['绍兴', '浙江'],
  ['广州', '广东'], ['深圳', '广东'], ['东莞', '广东'], ['佛山', '广东'], ['潮州', '广东'], ['汕头', '广东'], ['中山', '广东'], ['珠海', '广东'], ['揭阳', '广东'],
  ['临沂', '山东'], ['青岛', '山东'], ['济南', '山东'], ['威海', '山东'], ['烟台', '山东'],
  ['苏州', '江苏'], ['南京', '江苏'], ['无锡', '江苏'], ['常州', '江苏'], ['南通', '江苏'],
  ['泉州', '福建'], ['厦门', '福建'], ['福州', '福建'], ['晋江', '福建'],
  ['上海', '上海'], ['北京', '北京'], ['天津', '天津'], ['重庆', '重庆'],
  ['郑州', '河南'], ['许昌', '河南'], ['武汉', '湖北'], ['长沙', '湖南'], ['成都', '四川'], ['西安', '陕西'], ['合肥', '安徽'], ['芜湖', '安徽'], ['南昌', '江西'], ['石家庄', '河北'], ['廊坊', '河北'], ['保定', '河北'],
];
function guessProvince(company) {
  const name = String(company || '');
  for (const [city, prov] of CITY_MAP) if (name.includes(city)) return prov;
  const m = name.match(/^(.*?(?:省|市))/);
  return m ? m[1].replace(/有限公司.*$/, '') : null;
}
async function inferProvinces(companies) {
  const out = companies.map((c) => guessProvince(c));
  const unknown = companies.map((c, i) => ({ c, i })).filter((x) => !out[x.i]);
  if (unknown.length) {
    try {
      const arr = await askJSON(
        '你是中国行政区划专家。根据公司名称中的地名推断注册省份。输出JSON字符串数组,顺序与输入一致,无法判断填null。',
        '公司名单: ' + JSON.stringify(unknown.map((x) => x.c)));
      if (Array.isArray(arr)) unknown.forEach((x, k) => { if (arr[k]) out[x.i] = String(arr[k]).replace(/省$/, '') || arr[k]; });
    } catch (_) {}
  }
  return out.map((p) => (p ? String(p).replace(/省$/, '') : null));
}

/* ---------- 尺寸提取 ---------- */
async function extractMaxDims(items) {
  const payload = items.map((it, i) => ({ i, title: it.title, attrs: it.attrsText }));
  const arr = await askJSON(
    '你是五金/家居品类专家。对每个商品,从规格属性和标题中提取"最大尺寸"(最长一边),统一换算成厘米cm。纯体积(毫升/升)或重量不是尺寸。找不到尺寸则cm为null。输出JSON数组: [{"i":0,"cm":12.5,"basis":"最长边"},...] 与输入顺序一致。',
    JSON.stringify(payload));
  const map = new Map();
  if (Array.isArray(arr)) arr.forEach((x) => map.set(Number(x.i), Number(x.cm) || null));
  return items.map((it, i) => ({ ...it, maxDimCm: map.has(i) ? map.get(i) : null }));
}

/* ---------- 数据仓(与网页工具共享的 1688_history.json) ---------- */
const HISTORY_FILE = path.join(__dirname, '..', '1688_history.json');
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
  const list = readHistory();
  if (!list.length) return '(数据仓为空)';
  return list.slice(0, 10).map((r) => {
    const d = new Date(r.time), p2 = (n) => String(n).padStart(2, '0');
    return `${r.params.keyWord}(${r.products.length}条, ${(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())})`;
  }).join('; ');
}
function writeHistoryRecord(params, products, elapsedMs) {
  try {
    const recParams = { searchType: params.matchType ?? 1, keyWord: params.keyword, pageIndex: 1, pageSize: params.pageSize ?? 50 };
    if (params.sortField) { recParams.sortField = params.sortField; recParams.sortType = params.sortType || 'desc'; }
    const key = JSON.stringify(recParams);
    const list = readHistory();
    const existing = list.find((r) => JSON.stringify(r.params) === key);
    if (existing) { existing.time = new Date().toISOString(); existing.products = products; existing.elapsedMs = elapsedMs || 0; }
    else list.unshift({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), time: new Date().toISOString(), params: recParams, products, elapsedMs: elapsedMs || 0 });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(list.slice(0, 100)));
    log(`[history] 新数据已写入数据仓: "${params.keyword}" ${products.length}条`);
  } catch (e) { log('[history] 写入失败: ' + e.message); }
}

/* ---------- LangGraph 状态与节点 ---------- */
const AgentState = Annotation.Root({
  question: Annotation(),      // 用户输入; 确认续跑时为 '__confirm__'
  confirmed: Annotation({ default: () => false }),
  pending: Annotation(),       // 确认闸门挂起的动作: 'search' | 'enrich'
  action: Annotation(),        // search | history_hit | operate | resume_search | resume | chat
  params: Annotation(),        // 解析出的结构化条件
  useHistory: Annotation(),    // 命中的数据仓关键词
  historyTime: Annotation(),   // 命中数据仓的搜索时间
  reply: Annotation(),         // 直接回复(chat)
  products: Annotation(),      // 当前数据集
  province: Annotation(),
  sizeCm: Annotation(),
  needsConfirm: Annotation({ default: () => false }),
  searchApproved: Annotation({ default: () => false }),
  enrichNote: Annotation(),
  junkDropped: Annotation({ default: () => 0 }),
  noRealProduct: Annotation({ default: () => false }),
  datasetKeyword: Annotation(),
  answer: Annotation(),
  rows: Annotation({ default: () => [] }),
  compareIdx: Annotation(),
  lastCompareIdx: Annotation(),
  memory: Annotation(),
});

async function intentNode(state) {
  if (state.question === '__confirm__') {
    return { action: state.pending === 'search' ? 'resume_search' : 'resume' };
  }
  const has = (state.products || []).length;
  let out;
  try {
    out = await askJSON(
    '你是1688采购助手的意图解析器。把用户的自然语言解析成JSON:\n' +
    '{"action":"search|operate|chat|compare","keyword":"搜索词(中文)","matchType":1,"sortField":"orderCount30d|saleCount30d|saleVolume30d|price|consignPrice|offerCreateTime|null","sortType":"desc|asc","pageSize":50,"priceMin":null,"priceMax":null,"province":"省份或null","sizeCm":null,"budgetTotal":null,"quantity":null,"companyType":null,"offerType":null,"sendTime":null,"proxyRights":null,"shiLiType":null,"useHistory":null,"reply":null,"compareIdx":null}\n' +
    '规则:\n' +
    '- 想找新商品/换关键词 → action=search,提取keyword(必须保留商品词,如"笔记本电脑")\n' +
    '- 是对已有结果继续筛选/排序/收窄 → action=operate(此时keyword保持null,除非用户换了商品词)\n' +
    '- 【预算换算】"总预算X元买Y个"→ budgetTotal=X,quantity=Y,priceMax=X/Y(向上取整到0.1元)。例:"预算500买50个"→ priceMax=10\n' +
    '- 采购条件:"工厂直营/源头工厂"→companyType=2,"门店"→companyType=1,"支持定制/印logo/定制包装"→offerType=5,"新品"→offerType=2,"1688严选"→offerType=3,"跨境"→offerType=4,"24小时发货"→sendTime="24"(同理"48"/"72"),"一件代发"→proxyRights="4360897","先采后付"→proxyRights="449154"(两者都要则"4360897,449154"),"诚信通"→shiLiType="TrustPass","超级工厂"→shiLiType="superFactory"(可逗号组合)\n' +
    '- sortField【只能】取这些值之一: orderCount30d / saleCount30d / saleVolume30d / price / consignPrice / offerCreateTime,禁止自创其他写法;"销量件数"=saleCount30d,"订单数"=orderCount30d,"销售额"=saleVolume30d\n' +
    '- "卖的最好/销量最高"→ sortField=orderCount30d,sortType=desc;"价格最低"→ price asc\n' +
    '- "尺寸大于X cm"→ sizeCm=X;"售价不高于X元"→ priceMax=X;"必须X省产"→ province=X(不带"省"字)\n' +
    '- 如果用户的问题就是在分析/筛选下面列出的某个已有数据集 → action=operate,并把 useHistory 设为该数据集的关键词\n' +
    '- 【闲聊识别(重要)】打招呼("你好/在吗")、感谢("谢谢/辛苦了")、肯定否定反馈("不错/挺好/我觉得不好/不满意/太贵了")、情绪表达、与采购无关的话题 → 一律 action=chat,不要分析数据不要搜索。特别是用户刚看完推荐后说"我觉得不好",是在给反馈,应该追问哪里不满意(价格?销量?类目?),绝不能把原推荐再原样输出一遍\n' +
    '- "换一批/再来几个/有别的吗" → action=operate并调整条件(如提高priceMin下限或跳过已推荐过的),不是闲聊\n' +
    '- 【技能需求】"出询价单/生成RFQ"、"怎么验厂/供应商靠不靠谱"、"怎么砍价/谈判"这类基于数据的采购任务 → action=operate(沿用当前/指定的数据集),后续由工具提供专业指导\n' +
    '- 闲聊/问能力 → action=chat,reply=简短介绍自己能做什么\n' +
    '- 【对比】用户要求对比已有结果中的某几条(如"对比1和3"/"第2和第5哪个好") → action=compare,compareIdx=[序号数组],不要搜索\n' +
    '- 【指代消解】"他们/它/这两个/刚才那些"指的是对话记忆里最近的结果。若上一轮是对比(见下方"上一轮对比序号"),继续问优劣势/哪个好 → action=compare,compareIdx沿用上一轮序号;若上一轮是筛选结果 → action=operate\n' +
    '- 已有数据集(复用免费): ' + historyBrief() + '\n' +
    (has ? `- 当前会话在册${has}条数据。用户没提新商品词时优先operate。` : '- 当前会话无数据。') + '\n' +
    ((state.lastCompareIdx || []).length ? '- 上一轮对比序号: ' + JSON.stringify(state.lastCompareIdx) + '\n' : '') +
    '- 【对话记忆】最近几轮:\n' + memText(state.memory) + '\n',
    state.question);
  } catch (e) {
    // JSON解析失败(如用户在闲聊/问元问题) → 转自然对话模式,由respond节点正常回答
    log('[intent] JSON解析失败,转对话模式: ' + e.message);
    return { action: 'chat_fallback' };
  }
  const params = {
    keyword: out.keyword ?? null, matchType: out.matchType ?? 1,
    sortField: out.sortField ?? 'orderCount30d', sortType: out.sortType ?? 'desc',
    pageSize: Math.min(out.pageSize ?? 50, 100),
    priceMin: out.priceMin ?? null, priceMax: out.priceMax ?? null,
    province: out.province ?? null, sizeCm: out.sizeCm ?? null,
    budgetTotal: out.budgetTotal ?? null, quantity: out.quantity ?? null,
    companyType: out.companyType ?? null, offerType: out.offerType ?? null,
    sendTime: out.sendTime ?? null, proxyRights: out.proxyRights ?? null, shiLiType: out.shiLiType ?? null,
  };
  const compareIdx = Array.isArray(out.compareIdx) ? out.compareIdx.map(Number).filter((n) => n >= 1 && n <= 50) : null;
  // 预算换算: 总预算÷数量 → 单价上限
  if (params.budgetTotal != null && params.quantity > 0 && params.priceMax == null) {
    params.priceMax = Math.ceil((Number(params.budgetTotal) / Number(params.quantity)) * 100) / 100;
    log(`[intent] 预算换算: ${params.budgetTotal}元/${params.quantity}个 → 单价上限${params.priceMax}元`);
  }
  let action = out.action || 'search';
  // 对比指令: 直接走respond出对比表,不搜索不筛选;会话没数据但用户指定了数据集则先加载
  if (action === 'compare' && compareIdx && compareIdx.length >= 2) {
    log(`[intent] compare idx=${compareIdx} kw=${params.keyword} useHistory=${out.useHistory}`);
    if (!(state.products || []).length) {
      const rec = (out.useHistory && findHistoryByKeyword(out.useHistory)) || findHistoryByKeyword(params.keyword || '') || findHistoryByKeyword(state.question);
      if (rec) {
        log(`[intent] 对比从数据仓取数 "${rec.params.keyWord}"(${rec.products.length}条)`);
        return { action: 'compare', compareIdx, products: rec.products, useHistory: rec.params.keyWord, historyTime: rec.time, datasetKeyword: rec.params.keyWord, params };
      }
      return { action: 'compare', compareIdx, params };
    }
    return { action: 'compare', compareIdx, params };
  }
  // 加固1: 判成search却没提取到商品词 → 降级为对已有数据的operate
  if (action === 'search' && !params.keyword && (state.products || []).length) action = 'operate';
  // 加固2: operate带了商品词 → 数据仓有该商品数据则免费复用;没有 → 实为新商品搜索(转search走闸门)
  if (action === 'operate' && params.keyword) {
    const rec = findHistoryByKeyword(params.keyword);
    if (rec) {
      log(`[intent] ✅ 命中数据仓 "${rec.params.keyWord}"(${rec.products.length}条),免搜索复用`);
      return { action: 'history_hit', products: rec.products, useHistory: rec.params.keyWord, historyTime: rec.time, datasetKeyword: rec.params.keyWord, params };
    }
    action = 'search';
    log(`[intent] ⚠️ operate带新商品词"${params.keyword}"且数据仓没有 → 转为新搜索(待确认)`);
  }
  // 加固3: operate无关键词且会话无数据 → 只允许复用useHistory明确指定的数据集,绝不静默取"最近一条"
  if (action === 'operate' && !has) {
    const rec = out.useHistory ? findHistoryByKeyword(out.useHistory) : null;
    if (rec) {
      log(`[intent] operate从数据仓取数 "${rec.params.keyWord}"(${rec.products.length}条)`);
      return { action: 'history_hit', products: rec.products, useHistory: rec.params.keyWord, historyTime: rec.time, datasetKeyword: rec.params.keyWord, params };
    }
    action = 'search';
    log('[intent] ⚠️ operate但无任何数据 → 转为新搜索(待确认)');
  }
  // 加固4: operate时继承上一轮条件(省份/尺寸/价格/采购条件),只覆盖用户本轮明确给出的
  if (action === 'operate') {
    const prev = state.params || {};
    ['priceMin','priceMax','province','sizeCm','companyType','offerType','sendTime','proxyRights','shiLiType'].forEach((k) => {
      params[k] = params[k] ?? prev[k] ?? null;
    });
    params.datasetKeyword = params.datasetKeyword ?? prev.datasetKeyword ?? state.datasetKeyword ?? null;
  }
  // 数据仓优先: search请求先看数据仓里有没有同关键词数据,命中则免费复用
  if (action === 'search') {
    const rec = findHistoryByKeyword(params.keyword);
    if (rec) {
      log(`[intent] ✅ 命中数据仓 "${rec.params.keyWord}"(${rec.products.length}条),免搜索复用`);
      return { action: 'history_hit', products: rec.products, useHistory: rec.params.keyWord, historyTime: rec.time, datasetKeyword: rec.params.keyWord, params };
    }
  }
  // operate但会话无数据 → 从数据仓取(useHistory指定,否则最近一条)
  if (action === 'operate' && !has) {
    const rec = (out.useHistory && findHistoryByKeyword(out.useHistory)) || readHistory()[0];
    if (rec) {
      log(`[intent] operate从数据仓取数 "${rec.params.keyWord}"(${rec.products.length}条)`);
      return { action: 'history_hit', products: rec.products, useHistory: rec.params.keyWord, historyTime: rec.time, datasetKeyword: rec.params.keyWord, params };
    }
  }
  log(`[intent] action=${action} kw=${params.keyword} sort=${params.sortField}:${params.sortType} price=${params.priceMin ?? ''}-${params.priceMax ?? ''} prov=${params.province} size=${params.sizeCm} useHistory=${out.useHistory ?? 'null'}`);
  return { action, params, reply: out.reply || null };
}

async function searchNode(state) {
  const p = state.params || {};
  if (!p.keyword) return { products: state.products || [] };
  log(`[search] "${p.keyword}" 排序=${p.sortField}:${p.sortType} (12cr)`);
  const t0 = Date.now();
  const products = await nexSearch(p);
  log(`[search] 抓回${products.length}条`);
  writeHistoryRecord(p, products, Date.now() - t0);
  return { products, datasetKeyword: p.keyword };
}

async function localOpsNode(state) {
  const p = state.params || {};
  let list = state.products || [];
  if (p.priceMin != null) list = list.filter((x) => Number(x.price) >= Number(p.priceMin));
  if (p.priceMax != null) list = list.filter((x) => Number(x.price) <= Number(p.priceMax));
  // 采购常识过滤: 标题须含完整关键词(滤掉"保温"钩钉/保温袋这类模糊匹配杂音)
  let droppedJunk = 0;
  const effKw = p.keyword || state.datasetKeyword || '';
  if (effKw && String(effKw).length >= 2) {
    const keep = list.filter((x) => String(x.title || '').includes(effKw));
    droppedJunk = list.length - keep.length;
    if (keep.length) list = keep;
  }
  // 类目叶子校验: "保温杯刷/保温杯套"标题含全词但类目是"杯刷/杯套" → 只保留类目叶子命中关键词的真品
  let noReal = false;
  if (effKw && String(effKw).length >= 2) {
    const leafOf = (ln) => { const arr = String(ln || '').split(/[>,]/).map((s) => s.trim()).filter(Boolean); return arr.length ? arr[arr.length - 1] : ''; };
    const byLeaf = list.filter((x) => leafOf(x.levelName).includes(effKw));
    if (byLeaf.length) {
      log(`[localops] 类目校验: 保留类目含"${effKw}"的商品${byLeaf.length}/${list.length}条`);
      list = byLeaf;
    } else if (list.length) {
      noReal = true;
      log(`[localops] ⚠️ ${list.length}条结果里没有类目含"${effKw}"的真品(全是周边配件)`);
    }
  }
  // 采购常识校验: 价格低于中位数1/10 → 标记疑似数据噪音(不进推荐)
  const prices = list.map((x) => Number(x.price)).filter((v) => !isNaN(v) && v > 0).sort((a, b) => a - b);
  if (prices.length >= 6) {
    const med = prices[Math.floor(prices.length / 2)];
    list = list.map((x) => {
      const pr = Number(x.price);
      return pr > 0 && pr < med * 0.1 ? Object.assign({}, x, { suspect: true }) : x;
    });
  }
  if (droppedJunk) log(`[localops] 已过滤${droppedJunk}条标题不含"${p.keyword}"的结果`);
  const suspects = list.filter((x) => x.suspect).length;
  if (suspects) log(`[localops] ⚠️ 标记${suspects}条疑似噪音(价格低于中位数1/10)`);
  // 排序字段名归一化(GLM偶尔会输出别名)
  const SORT_KEY = {
    orderCount30d: 'salesOrderCount', saleCount30d: 'salesQuantity', saleVolume30d: 'estimatedSalesAmount',
    price: 'price', consignPrice: 'consignPrice', offerCreateTime: 'availableDate',
    orders: 'salesOrderCount', qty: 'salesQuantity', salesQuantity: 'salesQuantity',
    amount: 'estimatedSalesAmount', salesOrderCount: 'salesOrderCount', estimatedSalesAmount: 'estimatedSalesAmount',
    orderCount: 'salesOrderCount', saleCount: 'salesQuantity', saleVolume: 'estimatedSalesAmount',
  };
  if (p.sortField) {
    const key = SORT_KEY[p.sortField];
    if (key) {
      list.sort((a, b) => {
        const va = key === 'availableDate' ? String(a[key] || '') : Number(a[key] ?? -1);
        const vb = key === 'availableDate' ? String(b[key] || '') : Number(b[key] ?? -1);
        const mul = (p.sortType || 'desc') === 'asc' ? 1 : -1;
        if (typeof va === 'string') return va < vb ? -mul : va > vb ? mul : 0;
        return (va - vb) * mul;
      });
    } else {
      log(`[localops] ⚠️ 未识别的排序字段 "${p.sortField}",跳过排序`);
    }
  }
  return { products: list, junkDropped: droppedJunk, noRealProduct: noReal };
}

async function provinceNode(state) {
  const target = (state.params.province || state.province || '').replace(/省$/, '');
  if (!target) return {};
  const list = state.products || [];
  const provs = await inferProvinces(list.map((x) => x.company));
  const kept = list.map((x, i) => ({ ...x, province: provs[i] }))
    .filter((x) => x.province && (x.province.includes(target) || target.includes(x.province)));
  log(`[province] 目标${target}: ${kept.length}/${list.length}条匹配`);
  return { products: kept, province: target };
}

async function sizeGateNode(state) {
  const sizeCm = state.params?.sizeCm ?? state.sizeCm;
  const list = state.products || [];
  if (!sizeCm) return {};
  if (!list.length) return { answer: '按前面的条件筛选后没有剩余商品,没法做尺寸精查。可以放宽条件再试。' };
  const batch = Math.min(list.length, MAX_ENRICH);
  // LangGraph官方human-in-the-loop: 中断等人工确认,resume后从断点继续,不重跑前面的节点
  await interrupt({ type: 'enrich', estimate: batch * ENRICH_PRICE,
    message: `本地筛选后剩 **${list.length} 条**符合价格/产地条件。要判断"尺寸大于${sizeCm}cm"需要逐条调商品详情接口精查规格:\n- 预计消耗 **${batch * ENRICH_PRICE} credits**(每条2cr,最多精查${MAX_ENRICH}条,优先订单量高的)\n\n点下方按钮确认执行,或调整条件缩小范围。` });
  const top = list.slice(0, batch);
  return { products: top, enrichNote: `对前${batch}条做详情精查` };
}

async function searchGateNode(state) {
  const kw = state.params?.keyword || '该商品';
  const go = await interrupt({ type: 'search', estimate: 12,
    message: `数据仓里还没有「${kw}」的搜索结果,需要发起一次**新搜索**:\n- 预计消耗 **12 credits**\n- 也可以换个数据仓已有的关键词(免费复用)\n\n现有数据: ${historyBrief()}` });
  return { searchApproved: go === true || go === 'true' };
}

async function enrichNode(state) {
  const sizeCm = state.params?.sizeCm ?? state.sizeCm;
  const list = state.products || [];
  log(`[enrich] 详情精查 ${list.length}条 (2cr/条)`);
  const enriched = await pool(list, async (p) => {
    const prod = await nexDetail(p.offerId);
    const attrs = (prod.productAttributes || []).map((a) => `${a.attributeName || a.attributeNameTrans || ''}:${a.value || a.valueTrans || ''}`).join('; ');
    const skuAttrs = (prod.skuList || []).slice(0, 5).map((s) => (s.attributes || []).map((a) => a.value || a.valueTrans || '').join('/')).join('; ');
    return { ...p, attrsText: [p.title, attrs, skuAttrs, (prod.sellingPoints || []).join(';')].filter(Boolean).join(' | ') };
  }, 3);
  const ok = enriched.filter((e) => !e.error);
  const withDims = ok.length ? await extractMaxDims(ok) : [];
  const kept = withDims.filter((x) => x.maxDimCm != null && x.maxDimCm >= sizeCm);
  log(`[enrich] 尺寸≥${sizeCm}cm: ${kept.length}/${ok.length}条`);
  return {
    products: kept,
    enrichNote: `精查${ok.length}条(失败${enriched.length - ok.length}),尺寸≥${sizeCm}cm的共${kept.length}条`,
    params: Object.assign({}, state.params, { sizeCm: null }),
  };
}

function rowsOf(products, provs) {
  return (products || []).map((p, i) => ({
    offerId: p.offerId, title: p.title, price: p.price, consignPrice: p.consignPrice,
    orders: p.salesOrderCount ?? null, qty: p.salesQuantity ?? null,
    amount: p.estimatedSalesAmount ?? null, company: p.company || '',
    province: (provs && provs[i]) || p.province || null,
    sizeCm: p.maxDimCm ?? null, moq: p.quantityBegin ?? null,
    url: p.asinUrl || (p.offerId ? 'https://detail.1688.com/offer/' + p.offerId + '.html' : '#'),
  }));
}

/* 流式输出: /ask/stream 在invoke前挂上回调,respondNode里的LLM逐token推送 */
let streamCb = null;
let traceCb = null;   // ReAct 思考/行动轨迹(SSE type=trace)
let thinkCb = null;   // GLM思考链(SSE type=think,前端折叠展示)
function memText(memory) {
  return (memory || []).map((m) => (m.role === 'user' ? '用户: ' : '助手: ') + String(m.text || '').replace(/\n/g, ' ').slice(0, 140)).join('\n') || '(无)';
}
function slimRows(rows, n) {
  return (rows || []).slice(0, n || 10).map((p, i) => ({
    i: i + 1, 标题: String(p.title || '').slice(0, 36), 批发价: p.price, 代发价: p.consignPrice,
    近30天订单: p.salesOrderCount ?? null, 销量件数: p.salesQuantity ?? null, 月销额: p.estimatedSalesAmount ?? null,
    起订量: p.quantityBegin ?? null, 公司: p.company || '', 产地: p.province || null, 最大尺寸cm: p.maxDimCm ?? null,
  }));
}
function reactFilter(rows, q) {
  let out = (rows || []).slice();
  if (q.keyword) out = out.filter((x) => String(x.title || '').includes(q.keyword));
  if (q.province) out = out.filter((x) => String(x.province || '').includes(String(q.province).replace(/省$/, '')));
  if (q.priceMin != null) out = out.filter((x) => Number(x.price) >= q.priceMin);
  if (q.priceMax != null) out = out.filter((x) => Number(x.price) <= q.priceMax);
  const SORTS = { orderCount30d: (x) => Number(x.salesOrderCount ?? -1), saleCount30d: (x) => Number(x.salesQuantity ?? -1), saleVolume30d: (x) => Number(x.estimatedSalesAmount ?? -1), price: (x) => Number(x.price), consignPrice: (x) => Number(x.consignPrice) };
  if (q.sortField && SORTS[q.sortField]) out.sort((a, b) => (q.sortType === 'asc' ? 1 : -1) * (SORTS[q.sortField](a) - SORTS[q.sortField](b)));
  return out;
}
/* ---------- 技能库(skills/*.md,放文件即扩展,无需改代码) ---------- */
const SKILLS_DIR = path.join(__dirname, 'skills');
function loadSkills() {
  try {
    return fs.readdirSync(SKILLS_DIR).filter((f) => f.endsWith('.md')).map((f) => {
      const raw = fs.readFileSync(path.join(SKILLS_DIR, f), 'utf8');
      const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
      const meta = {};
      (m ? m[1] : '').split(/\r?\n/).forEach((l) => { const mm = l.match(/^(\w+):\s*(.*)$/); if (mm) meta[mm[1]] = mm[2].trim(); });
      return { name: meta.name || f.replace(/\.md$/, ''), description: meta.description || '', body: (m ? m[2] : raw).trim() };
    });
  } catch (_) { return []; }
}

/* ReAct分析: LangGraph官方createReactAgent,GLM工具调用,LOOK/FILTER本地执行零credits */
async function reactLoop(state) {
  let rows = (state.products || []).slice();
  const lookData = tool(async ({ n }) => JSON.stringify(slimRows(rows, Math.min(Number(n) || 5, 10))), {
    name: 'lookData',
    description: '查看当前数据集前N条商品明细(标题/批发价/代发价/近30天订单/销量件数/月销额/起订量/公司/产地/最大尺寸cm)。信息不够时先用这个看数据。',
    schema: z.object({ n: z.number().optional().describe('条数,默认5,最大10') }),
  });
  const filterData = tool(async ({ keyword, province, priceMin, priceMax, sortField, sortType }) => {
    const before = rows.length;
    rows = reactFilter(rows, { keyword, province, priceMin, priceMax, sortField, sortType });
    return `筛选完成: ${before}条 → ${rows.length}条` + (before === rows.length ? '(无变化)' : '');
  }, {
    name: 'filterData',
    description: '对当前数据集做本地筛选/排序(免费,不重新搜索)。sortField可用: orderCount30d(订单)/saleCount30d(销量)/saleVolume30d(月销额)/price(批发价)/consignPrice(代发价)',
    schema: z.object({
      keyword: z.string().optional().describe('标题须包含的关键词'),
      province: z.string().optional().describe('产地省份,不带"省"字'),
      priceMin: z.number().optional(), priceMax: z.number().optional(),
      sortField: z.enum(['orderCount30d', 'saleCount30d', 'saleVolume30d', 'price', 'consignPrice']).optional(),
      sortType: z.enum(['asc', 'desc']).optional(),
    }),
  });
  const skills = loadSkills();
  const useSkill = tool(async ({ name }) => {
    const s = skills.find((x) => x.name === name);
    if (!s) return '未找到技能「' + name + '」。可用: ' + skills.map((x) => x.name).join('、');
    return s.body;
  }, {
    name: 'useSkill',
    description: '调用采购专业技能,获取该技能的详细执行指导。调用后按指导内容完成任务。',
    schema: z.object({ name: z.string().describe('技能名,须与可用技能列表完全一致') }),
  });
  const reactAgent = createReactAgent({
    llm,
    tools: [lookData, filterData, useSkill],
    stateModifier: '你是资深1688采购数据分析员。当前数据集共' + rows.length + '条商品。\n' +
      '工作方式: 先思考需要什么信息,用lookData/filterData工具查看和加工数据(本地操作,免费),信息足够后给出最终回答。至多4次工具调用。\n' +
      '采购常识: 单价低得反常的商品(如几毛钱的日用品)大概率是关联配件或数据噪音,绝不推荐;引用数字必须来自工具返回的真实数据,绝不编造。\n' +
      (skills.length ? '【可用技能】用户提出以下需求时,先调用useSkill工具获取执行指导,再按指导完成任务:\n' +
        skills.map((s) => '- ' + s.name + ': ' + s.description).join('\n') + '\n' : '') +
      '【回答格式(重要)】用Markdown组织,分三段:\n' +
      '**📊 总评** 一到两句:共几条符合、整体价位与销量水平\n' +
      '**🏆 推荐** 逐条列表,每条一行:`- **标题(20字内)** — 批发价¥X · 近30天订单X · 月销额¥X · 一句话亮点` (推荐3-5条,不要带内部序号i=N)\n' +
      '**💡 采购建议** 两三句:结合价格梯度/起订量/复购视角给出可执行建议,必要时提示风险\n' +
      '用户对话记忆:\n' + memText(state.memory),
  });
  let answer = '';
  const userMsg = `用户问题: ${state.question}\n\n当前数据集已有 ${rows.length} 条商品,全部在本地内存里。**必须先调用 lookData 工具查看真实数据**(至少一次),再基于工具返回的数字回答,禁止凭空回答。\n\n对话记忆:\n${memText(state.memory)}`;
  const stream = await reactAgent.stream({ messages: [{ role: 'user', content: userMsg }] }, { streamMode: 'updates' });
  for await (const upd of stream) {
    if (upd.tools && upd.tools.messages) {
      for (const m of upd.tools.messages) {
        if (typeof m.getName === 'function' && m.getName()) {
          const brief = String(m.content || '').replace(/\n/g, ' ').slice(0, 60);
          if (traceCb) traceCb(`🔧 ${m.getName()}: ${brief}`);
        }
      }
    }
    if (upd.agent && upd.agent.messages) {
      const m = upd.agent.messages[upd.agent.messages.length - 1];
      const r = m && m.additional_kwargs && m.additional_kwargs.reasoning_content;
      if (r && thinkCb) thinkCb(String(r).slice(0, 800));
      if (m && m.tool_calls && m.tool_calls.length) {
        m.tool_calls.forEach((tc) => {
          const args = JSON.stringify(tc.args || {}).slice(0, 80);
          if (traceCb) traceCb('调用工具 ' + tc.name + '(' + args + ')');
        });
      }
      if (m && m.content && !(m.tool_calls && m.tool_calls.length)) answer = String(m.content);
    }
  }
  if (answer) return answer;
  // 兜底: 工具循环没产生最终文本
  const ans = await llmAnswer([
    { role: 'system', content: '你是1688采购数据分析助手。基于已有信息回答,简体中文,用Markdown分:📊总评/🏆推荐/💡建议,引用具体数字,不编造。' },
    { role: 'user', content: `用户问题: ${state.question}\n当前数据集${rows.length}条,前10条:\n${JSON.stringify(slimRows(rows, 10))}\n对话记忆:\n${memText(state.memory)}` },
  ]);
  return ans;
}

async function llmAnswer(msgs) {
  if (streamCb) {
    let full = '';
    try {
      // 原生SSE直连: LangChain适配层会丢弃reasoning_content,这里手动解析以获得思考链
      const res = await fetch(AI_BASE + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + AI_KEY },
        body: JSON.stringify({ model: AI_MODEL, thinking: { type: 'enabled' }, max_tokens: 4096, stream: true, messages: msgs }),
      });
      if (res.ok && res.body) {
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        outer: for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop();
          for (const line of lines) {
            const s = line.trim();
            if (!s.startsWith('data:')) continue;
            const payload = s.slice(5).trim();
            if (payload === '[DONE]') break outer;
            try {
              const delta = JSON.parse(payload).choices?.[0]?.delta || {};
              if (delta.reasoning_content && thinkCb) thinkCb(String(delta.reasoning_content));
              if (delta.content) { full += delta.content; streamCb(String(delta.content)); }
            } catch (_) {}
          }
        }
        if (full) return full;
      }
    } catch (_) { /* 直连失败则回退LangChain */ }
  }
  const res = await llm.invoke(msgs);
  return String(res.content);
}

async function respondNode(state) {
  // ReAct分析: 数据类问题走 思考→行动→观察 循环(本地操作,零credits)
  if (state.action === 'compare' && !(state.compareIdx || state.lastCompareIdx || []).length && (state.products || []).length) {
    const answer = await reactLoop(state);
    return { answer, rows: rowsOf(state.products) };
  }
  if (state.action === 'compare') {
    const all = state.products || [];
    const idx = state.compareIdx || state.lastCompareIdx || [];
    const picks = idx.map((n) => all[n - 1]).filter(Boolean);
    if (picks.length < 2) {
      return { answer: '要对比的序号超出了当前结果范围(当前共' + all.length + '条)。请说"对比1和3"这样在范围内的序号。', rows: [] };
    }
    const line = (label, fn) => label + ': ' + picks.map((p, i) => '#' + idx[i] + ' ' + fn(p)).join(' | ');
    let answer = [
      '⚖️ 对比 ' + idx.map((n) => '#' + n).join(' vs ') + '(' + picks.length + '条):',
      line('商品', (p) => String(p.title || '').slice(0, 30)),
      line('批发价', (p) => '¥' + (p.price ?? '—')),
      line('代发价', (p) => '¥' + (p.consignPrice ?? '—')),
      line('起订量', (p) => (p.quantityBegin ?? '—') + '件'),
      line('近30天订单', (p) => (p.salesOrderCount ?? '—')),
      line('销量件数', (p) => (p.salesQuantity ?? '—')),
      line('预估月销额', (p) => (p.estimatedSalesAmount == null ? '—' : '¥' + Number(p.estimatedSalesAmount).toLocaleString())),
      line('公司', (p) => (p.company || '—')),
      line('产地', (p) => (p.province || '—')),
      line('链接', (p) => (p.offerId ? 'detail.1688.com/offer/' + p.offerId + '.html' : '—')),
    ].join('\n');
    // ReAct式收尾: 基于对比数据给采购结论(结合对话记忆,如"他们有什么优劣势")
    const verdict = await llmAnswer([
      { role: 'system', content: '你是资深1688采购经理。基于对比数据给出**详细的**采购结论,用Markdown分三段:\n' +
        '**📊 关键指标对比** 逐项列价格/订单/销量差异(用 `- ` 列表)\n' +
        '**⚖️ 优劣势** 每个候选一条:`- **#序号 标题(短)** — 优势:…;劣势:…`\n' +
        '**💡 结论与建议** 明确说选哪个、什么场景选另一个、下单前注意什么。引用真实数字,不编造。' },
      { role: 'user', content: `用户问题: ${state.question}\n对比数据:\n${JSON.stringify(slimRows(picks, 5))}\n(以上序号i对应${idx.map((n) => '#' + n).join(', ')})\n对话记忆:\n${memText(state.memory)}` },
    ]);
    answer += '\n\n🎯 采购结论: ' + verdict;
    return { answer, rows: rowsOf(picks) };
  }
  if (state.action === 'chat' || state.action === 'chat_fallback') {
    const answer = await llmAnswer([
      { role: 'system', content: '你是1688采购助手,和采购部同事自然对话。用简体中文,像同事聊天一样简短回应,通常1-3句话。\n' +
        '【重要】\n' +
        '1. 用户打招呼/感谢 → 简短回应即可,绝不主动倾倒数据分析。\n' +
        '2. 用户给否定反馈("我觉得不好/不满意") → 真诚接住反馈,追问具体哪里不满意(价格高了?销量不够?类目不对?),并给出可以调整的方向,不要重复之前的内容。\n' +
        '3. 绝对禁止编造数据:不存在的商品名、好评率、销量数字一律不许出现。引用数字只能来自对话记忆里已有的内容。\n' +
        '4. 可以用 **加粗** 和 `- ` 列表,但闲聊时别堆格式。' },
      { role: 'user', content: state.question + '\n\n对话记忆:\n' + memText(state.memory) + '\n\n背景信息:\n- 数据仓现有数据(可免费复用): ' + historyBrief() + '\n- 当前会话在册: ' + (state.products || []).length + '条商品\n- 你能做的: 自然语言搜索1688商品、按价格/产地/尺寸筛选排序、商品详情精查(花credits前会先报价确认)。' },
    ]);
    return { answer, rows: [] };
  }
  const all = state.products || [];
  if (state.noRealProduct) {
    return {
      answer: `⚠️ 如实说: 这次抓到的${all.length}条结果里,没有一条是真正的"${(state.params && state.params.keyword) || '目标商品'}"——全是标题蹭关键词的周边配件(杯刷、包装袋、贴纸这类)。给你推荐它们是不负责任的,所以我不推。\n建议:\n1. 换更精确的关键词,比如"304保温杯""真空保温杯",我再帮你搜(12cr)\n2. 或者在网页表格里用"类目筛选"只勾选正品类目\n3. 如果之前搜到过真品,直接说"用之前搜的XX数据分析"(免费)`,
      rows: rowsOf(all.slice(0, 10)),
    };
  }
  const clean = all.filter((x) => !x.suspect);
  const suspectN = all.length - clean.length;
  const list = clean.length >= 5 ? clean : all;
  if (!list.length) return { answer: state.answer || '按条件筛选后没有匹配的商品。可以放宽价格/产地/尺寸条件,或换个关键词。', rows: [] };
  // ReAct模式: 让Agent自己决定查看/筛选/作答,而不是一次性喂数据
  const answer = await reactLoop(Object.assign({}, state, { products: list, question: state.question +
    (suspectN ? `(注意:已排除${suspectN}条价格明显异常的疑似噪音数据,不要推荐它们)` : '') }));
  return { answer, rows: rowsOf(clean.concat(list.filter((x) => x.suspect))) };
}

/* ---------- 组装图 ---------- */
const graph = new StateGraph(AgentState)
  .addNode('intent', intentNode)
  .addNode('search', searchNode)
  .addNode('localops', localOpsNode)
  .addNode('provinceFilter', provinceNode)
  .addNode('searchgate', searchGateNode)
  .addNode('sizegate', sizeGateNode)
  .addNode('enrich', enrichNode)
  .addNode('respond', respondNode)
  .addEdge(START, 'intent')
  .addConditionalEdges('intent', (s) => {
    if (s.action === 'resume_search') return 'search';
    if (s.action === 'resume') return 'enrich';
    if (s.action === 'history_hit') return 'localops';
    if (s.action === 'search') return 'searchgate';
    if (s.action === 'operate') return s.products?.length ? 'localops' : 'respond';
    return 'respond';
  }, { searchgate: 'searchgate', search: 'search', localops: 'localops', enrich: 'enrich', respond: 'respond' })
  .addConditionalEdges('searchgate', (s) => (s.searchApproved ? 'search' : END), { search: 'search', [END]: END })
  .addEdge('search', 'localops')
  .addConditionalEdges('localops', (s) => (s.params?.province ? 'provinceFilter' : (s.params?.sizeCm ? 'sizegate' : 'respond')),
    { provinceFilter: 'provinceFilter', sizegate: 'sizegate', respond: 'respond' })
  .addConditionalEdges('provinceFilter', (s) => (s.params?.sizeCm ? 'sizegate' : 'respond'), { sizegate: 'sizegate', respond: 'respond' })
  .addEdge('sizegate', 'enrich')
  .addEdge('enrich', 'respond')
  .addEdge('respond', END)
  .compile({ checkpointer: new MemorySaver() });

/* ---------- 会话存储(持久化到磁盘,重启不丢) ---------- */
const SESS_FILE = path.join(__dirname, 'sessions.json');
const sessions = new Map();
try {
  const saved = JSON.parse(fs.readFileSync(SESS_FILE, 'utf8'));
  for (const [k, v] of Object.entries(saved)) sessions.set(k, v);
  log(`已恢复 ${sessions.size} 个会话`);
} catch (_) {}
function persistSessions() {
  try { fs.writeFileSync(SESS_FILE, JSON.stringify(Object.fromEntries(sessions))); } catch (e) { log('会话持久化失败: ' + e.message); }
}
function getSession(id) {
  if (!sessions.has(id)) sessions.set(id, { products: [], params: null, province: null, sizeCm: null, messages: [] });
  if (!sessions.get(id).messages) sessions.get(id).messages = [];
  return sessions.get(id);
}
function recordTurn(sess, question, final, estimate) {
  sess.messages.push({ role: 'user', text: question === '__confirm__' ? '✅ 确认执行' : question, t: Date.now() });
  sess.messages.push({ role: 'bot', text: final.answer || '', rows: final.rows || [], needsConfirm: !!final.needsConfirm, estimate, t: Date.now() });
  if (sess.messages.length > 200) sess.messages = sess.messages.slice(-200);
}

/* ---------- 聊天页面 ---------- */
const PAGE = String.raw`<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><title>AI 采购助手</title>
<style>
* { box-sizing:border-box; margin:0; padding:0; }
:root {
  --bg:#F0EEE6; --surface:#FFFFFF; --ink:#26241F; --ink2:#79766B; --line:#E4E1D6;
  --accent:#C96442; --accent-d:#B0522F; --accent-soft:#F6EAE2;
}
html,body { height:100%; }
body { font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif; background:var(--bg); color:var(--ink); display:flex; flex-direction:column; }
header { background:rgba(240,238,230,.88); backdrop-filter:blur(8px); border-bottom:1px solid var(--line); padding:13px 28px; display:flex; justify-content:space-between; align-items:center; }
.brand { display:flex; align-items:center; gap:11px; }
.mark { width:32px; height:32px; border-radius:9px; background:var(--accent); color:#FFF7F0; display:flex; align-items:center; justify-content:center; font-size:15px; font-weight:700; }
.brand h1 { font-size:16.5px; font-weight:650; letter-spacing:.3px; font-family:Georgia,"Songti SC","SimSun",serif; }
.brand .sub { display:block; font-size:11.5px; color:var(--ink2); font-weight:400; margin-top:2px; }
header .links a { font-size:12.5px; color:var(--ink2); text-decoration:none; border:1px solid var(--line); border-radius:20px; padding:5px 14px; background:var(--surface); }
header .links a:hover { color:var(--accent-d); border-color:var(--accent); }
#log { flex:1; overflow-y:auto; }
.inner { max-width:840px; margin:0 auto; padding:28px 20px 12px; }
.msg { margin:13px 0; font-size:14.5px; line-height:1.8; }
.msg.user { display:flex; justify-content:flex-end; }
.msg.user .bub { background:var(--accent-soft); border:1px solid #EBD5C8; color:#4A382C; padding:10px 16px; border-radius:16px 16px 4px 16px; max-width:75%; }
.msg.bot { background:var(--surface); border:1px solid var(--line); border-radius:14px; padding:15px 20px 16px; box-shadow:0 1px 4px rgba(72,60,40,.06); }
.msg.bot .who { font-size:11px; color:var(--ink2); letter-spacing:1px; margin-bottom:7px; }
.msg.sys { text-align:center; color:#A6A296; font-size:12px; margin:12px 0; }
.msg.tblwrap { padding:12px 14px; overflow-x:auto; }
table { border-collapse:collapse; width:100%; margin:6px 0 2px; font-size:12.8px; }
th { text-align:left; color:var(--ink2); font-weight:600; font-size:11.5px; letter-spacing:.4px; padding:7px 10px; border-bottom:1px solid var(--line); white-space:nowrap; }
td { padding:8px 10px; border-bottom:1px solid #F1EEE4; }
tbody tr:hover { background:#FBF9F2; }
td a { color:var(--accent-d); text-decoration:none; border-bottom:1px solid #E5C9B9; }
td a:hover { color:var(--accent); }
td.num { font-variant-numeric:tabular-nums; }
footer { padding:14px 20px 20px; }
.composer { max-width:840px; margin:0 auto; background:var(--surface); border:1px solid var(--line); border-radius:16px; padding:10px 10px 10px 18px; display:flex; gap:10px; align-items:center; box-shadow:0 4px 20px rgba(72,60,40,.09); }
.composer:focus-within { border-color:var(--accent); box-shadow:0 4px 24px rgba(201,100,66,.18); }
#inp { flex:1; border:0; outline:0; font-size:14.5px; background:transparent; color:var(--ink); }
#inp::placeholder { color:#B5B0A2; }
#send { background:var(--accent); color:#FFF7F0; border:0; border-radius:11px; padding:9px 24px; font-size:14px; font-weight:600; cursor:pointer; }
#send:hover { background:var(--accent-d); }
#send:disabled { opacity:.45; cursor:default; }
button.confirm { background:var(--surface); color:var(--accent-d); border:1px solid var(--accent); border-radius:20px; padding:6px 18px; font-size:13px; cursor:pointer; font-weight:600; margin-top:8px; }
button.confirm:hover { background:var(--accent-soft); }
.hint { text-align:center; font-size:11.5px; color:#A6A296; margin-top:9px; }
</style></head><body>
<header>
  <div class="brand"><div class="mark">采</div><div><h1>AI 采购助手</h1><span class="sub">LangGraph 编排 · 自然语言筛选 · 数据仓复用免费 · 精查前必报价</span></div></div>
  <div class="links"><a href="http://127.0.0.1:3000" target="_blank">数据表格 →</a></div>
</header>
<div id="log"><div class="inner" id="inner"></div></div>
<footer>
  <div class="composer">
    <input id="inp" placeholder="例: 帮我找保温杯,售价不超过50元,必须浙江产的,按订单数从高到低">
    <button id="send">发送</button>
  </div>
  <div class="hint">搜索 12cr · 详情精查 2cr/条(执行前先报价) · 追问与本地筛选免费 · GLM 生成免费</div>
</footer>
<script>
var sid = 's' + Date.now().toString(36);
var log = document.getElementById('log');
var inner = document.getElementById('inner');
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
function add(cls, text) {
  var d = document.createElement('div'); d.className = 'msg ' + cls;
  if (cls === 'user') { var b = document.createElement('div'); b.className = 'bub'; b.innerHTML = text; d.appendChild(b); }
  else { d.innerHTML = '<div class="who">AI 采购助手</div>' + text; }
  inner.appendChild(d); log.scrollTop = log.scrollHeight; return d;
}
function renderRows(rows) {
  if (!rows || !rows.length) return '';
  var heads = ['商品','批发价','代发价','30天订单','销量(件)','供应商','产地','最大尺寸cm'];
  var h = '<table><thead><tr>' + heads.map(function(x){ return '<th>' + x + '</th>'; }).join('') + '</tr></thead><tbody>';
  rows.forEach(function(r) {
    h += '<tr><td><a href="' + esc(r.url) + '" target="_blank">' + esc(String(r.title).slice(0,30)) + '</a></td>' +
      '<td class="num">¥' + esc(r.price) + '</td><td class="num">¥' + esc(r.consignPrice == null ? '—' : r.consignPrice) + '</td>' +
      '<td class="num">' + esc(r.orders == null ? '—' : r.orders) + '</td><td class="num">' + esc(r.qty == null ? '—' : r.qty) + '</td>' +
      '<td>' + esc(r.company) + '</td><td>' + esc(r.province || '—') + '</td><td class="num">' + esc(r.sizeCm == null ? '—' : r.sizeCm) + '</td></tr>';
  });
  return h + '</tbody></table>';
}
var busy = false;
function send(text, confirm) {
  if (busy) return;
  busy = true;
  if (!confirm && text) add('user', esc(text));
  var wait = add('sys', confirm ? '正在精查尺寸…' : 'AI思考中…');
  fetch('/ask', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ sessionId: sid, question: confirm ? '__confirm__' : text, confirm: !!confirm }) })
  .then(function(r){ return r.json(); })
  .then(function(d) {
    wait.remove();
    if (d.error) { add('bot', '❌ ' + esc(d.error)); return; }
    add('bot', esc(d.answer || ''));
    if (d.rows && d.rows.length) { var w = document.createElement('div'); w.className = 'msg bot tblwrap'; w.innerHTML = renderRows(d.rows); inner.appendChild(w); }
    if (d.needsConfirm) {
      var b = document.createElement('button'); b.className = 'confirm'; b.textContent = '✅ 确认执行,预计消耗 ' + (d.estimate || 0) + ' credits';
      b.onclick = function() { b.disabled = true; sid = d.sessionId; send(null, true); };
      inner.appendChild(b); log.scrollTop = log.scrollHeight; return;
    }
    sid = d.sessionId || sid;
    log.scrollTop = log.scrollHeight;
  })
  .catch(function(e){ wait.remove(); add('bot', '❌ ' + esc(e.message)); })
  .finally(function(){ busy = false; });
}
document.getElementById('send').onclick = function() { var i = document.getElementById('inp'); var v = i.value.trim(); if (v) { i.value = ''; send(v); } };
document.getElementById('inp').addEventListener('keydown', function(e) { if (e.key === 'Enter') document.getElementById('send').onclick(); });
add('sys', '会话已建立。试试: "帮我找保温杯,售价不超过50元,必须浙江产的,按订单数从高到低"');
</script></body></html>`;

/* ---------- HTTP 服务 ---------- */
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(PAGE);
  }
  if (req.method === 'POST' && u.pathname === '/ask') {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      let body;
      try { body = JSON.parse(raw || '{}'); } catch (_) { res.writeHead(400, json).end(JSON.stringify({ error: 'bad json' })); return; }
      const sess = getSession(body.sessionId || 'default');
      const input = buildInput(sess, body);
      try {
        let final;
        if (body.resume || body.question === '__confirm__') {
          // 官方interrupt恢复: 从断点继续执行,不重跑intent等节点
          final = await graph.invoke(new Command({ resume: true }), { configurable: { thread_id: sess.threadId || (body.sessionId || 'default') + '#0' } });
        } else {
          // 每个新问题开新线程;同一问题的interrupt/resume共用一个线程
          sess.threadN = (sess.threadN || 0) + 1;
          sess.threadId = (body.sessionId || 'default') + '#' + sess.threadN;
          final = await graph.invoke(buildInput(sess, body), { configurable: { thread_id: sess.threadId } });
        }
        // 0.2.74: interrupt不体现在invoke返回值里,要用getState检测挂起的人工确认
        const iv = await (async () => {
          try {
            const st = await graph.getState({ configurable: { thread_id: sess.threadId } });
            return (st.tasks || []).flatMap((t) => t.interrupts || [])[0] || null;
          } catch (_) { return null; }
        })();
        if (iv) {
          // 图在此中断等人工确认: 不推进会话数据,把确认请求返回给前端
          const val = iv.value || {};
          recordTurn(sess, body.resume ? '✅ (待确认的付费操作)' : (body.question || ''), { answer: val.message || '需要确认', rows: [] }, val.estimate || 0);
          persistSessions();
          const payload = {
            sessionId: body.sessionId || 'default',
            answer: val.message || '需要确认',
            rows: [], needsConfirm: true, estimate: val.estimate || 0,
            resume: true, count: (sess.products || []).length,
          };
          if (body._sse) { send({ type: 'replace', text: payload.answer }); send({ type: 'done', ...payload }); }
          else { res.writeHead(200, json); res.end(JSON.stringify(payload)); }
          return;
        }
        applyFinal(sess, final);
        const estimate = calcEstimate(final);
        recordTurn(sess, body.question || '', final, estimate);
        persistSessions();
        res.writeHead(200, json);
        res.end(JSON.stringify({
          sessionId: body.sessionId || 'default',
          answer: final.answer,
          rows: final.rows || [],
          needsConfirm: !!final.needsConfirm,
          estimate,
          count: (final.products || []).length,
        }));
      } catch (e) {
        log('ask失败: ' + e.message);
        res.writeHead(502, json);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  if (req.method === 'POST' && u.pathname === '/ask/stream') {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      let body;
      try { body = JSON.parse(raw || '{}'); } catch (_) { res.writeHead(400, json).end(JSON.stringify({ error: 'bad json' })); return; }
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      const send = (o) => { try { res.write('data: ' + JSON.stringify(o) + '\n\n'); } catch (_) {} };
      body._sse = true;
      const sess = getSession(body.sessionId || 'default');
      const input = buildInput(sess, body);
      let acc = '';
      streamCb = (t) => { acc += t; send({ type: 'delta', text: t }); };
      traceCb = (t) => send({ type: 'trace', text: t });
      thinkCb = (t) => send({ type: 'think', text: t });
      try {
        let final;
        if (body.resume || body.question === '__confirm__') {
          // 官方interrupt恢复: 从断点继续执行,不重跑intent等节点
          final = await graph.invoke(new Command({ resume: true }), { configurable: { thread_id: sess.threadId || (body.sessionId || 'default') + '#0' } });
        } else {
          // 每个新问题开新线程;同一问题的interrupt/resume共用一个线程
          sess.threadN = (sess.threadN || 0) + 1;
          sess.threadId = (body.sessionId || 'default') + '#' + sess.threadN;
          final = await graph.invoke(buildInput(sess, body), { configurable: { thread_id: sess.threadId } });
        }
        // 0.2.74: interrupt不体现在invoke返回值里,要用getState检测挂起的人工确认
        const iv = await (async () => {
          try {
            const st = await graph.getState({ configurable: { thread_id: sess.threadId } });
            return (st.tasks || []).flatMap((t) => t.interrupts || [])[0] || null;
          } catch (_) { return null; }
        })();
        if (iv) {
          // 图在此中断等人工确认: 不推进会话数据,把确认请求返回给前端
          const val = iv.value || {};
          recordTurn(sess, body.resume ? '✅ (待确认的付费操作)' : (body.question || ''), { answer: val.message || '需要确认', rows: [] }, val.estimate || 0);
          persistSessions();
          const payload = {
            sessionId: body.sessionId || 'default',
            answer: val.message || '需要确认',
            rows: [], needsConfirm: true, estimate: val.estimate || 0,
            resume: true, count: (sess.products || []).length,
          };
          if (body._sse) { send({ type: 'replace', text: payload.answer }); send({ type: 'done', ...payload }); }
          else { res.writeHead(200, json); res.end(JSON.stringify(payload)); }
          return;
        }
        applyFinal(sess, final);
        const estimate = calcEstimate(final);
        recordTurn(sess, body.question || '', final, estimate);
        persistSessions();
        // 模板类回复不走LLM,没有delta,这里补发全文
        if (final.answer && final.answer !== acc) {
          if (acc && final.answer.startsWith(acc)) send({ type: 'delta', text: final.answer.slice(acc.length) });
          else if (!acc) send({ type: 'delta', text: final.answer });
          else send({ type: 'replace', text: final.answer });
        }
        send({ type: 'done', sessionId: body.sessionId || 'default', rows: final.rows || [], needsConfirm: !!final.needsConfirm, estimate, count: (final.products || []).length });
      } catch (e) {
        log('ask/stream失败: ' + e.message);
        send({ type: 'error', error: e.message });
      } finally {
        streamCb = null; traceCb = null; thinkCb = null;
        res.end();
      }
    });
    return;
  }
  if (req.method === 'GET' && u.pathname === '/chat/history') {
    const sess = getSession(u.searchParams.get('sid') || 'default');
    res.writeHead(200, json);
    return res.end(JSON.stringify({ messages: sess.messages || [] }));
  }
  if (req.method === 'GET' && u.pathname === '/chat/sessions') {
    const items = [];
    for (const [sid, s] of sessions) {
      const msgs = s.messages || [];
      if (!msgs.length) continue;
      const first = msgs.find((m) => m.role === 'user');
      items.push({ sid, title: String((first && first.text) || '新对话').slice(0, 26), count: msgs.length,
                   time: msgs[msgs.length - 1].t || 0 });
    }
    items.sort((a, b) => b.time - a.time);
    res.writeHead(200, json);
    return res.end(JSON.stringify({ sessions: items }));
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});
const json = { 'Content-Type': 'application/json; charset=utf-8' };
function buildInput(sess, body) {
  return {
    question: body.question || '',
    confirmed: !!body.confirm,
    pending: sess.pending || null,
    products: sess.products,
    params: sess.params,
    province: sess.province,
    sizeCm: sess.sizeCm,
    datasetKeyword: sess.datasetKeyword || null,
    lastCompareIdx: sess.lastCompareIdx || null,
    memory: (sess.messages || []).slice(-8).map((m) => ({ role: m.role, text: String(m.text || '').slice(0, 160) })),
  };
}
function applyFinal(sess, final) {
  sess.products = final.products || [];
  sess.params = final.params || sess.params;
  sess.province = final.province ?? sess.province;
  sess.sizeCm = final.params?.sizeCm ?? sess.sizeCm;
  sess.pending = final.pending ?? null;
  sess.datasetKeyword = final.datasetKeyword ?? sess.datasetKeyword ?? null;
  if (final.compareIdx) sess.lastCompareIdx = final.compareIdx;
}
function calcEstimate(final) {
  const batch = Math.min((final.products || []).length, MAX_ENRICH);
  return final.needsConfirm ? (final.pending === 'search' ? 12 : batch * ENRICH_PRICE) : 0;
}

server.listen(PORT, () => {
  log(`✅ AI 采购助手 (LangGraph.js) 已启动: http://localhost:${PORT}`);
  log(`   模型: ${AI_MODEL} @ ${AI_BASE} | Nexscope Key ${NEX_KEY ? '已加载' : '缺失'} | AI Key ${AI_KEY ? '已加载' : '缺失'}`);
});

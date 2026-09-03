#!/usr/bin/env node
/**
 * 1688 商品搜索可视化界面 v2 — 零依赖单文件服务
 * 新增: 搜索历史持久化(1688_history.json)、请求日志、假total修正、
 *       等待计时、明确错误提示、URL哈希刷新恢复
 * 用法: NEXSCOPE_API_KEY=nk-xxx node server_1688.js  (或同目录 .env)
 * 浏览器打开 http://localhost:3000
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

function loadKey() {
  if (process.env.NEXSCOPE_API_KEY) return process.env.NEXSCOPE_API_KEY;
  try {
    const m = fs.readFileSync(path.join(__dirname, '.env'), 'utf8').match(/^NEXSCOPE_API_KEY=(.+)$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  } catch (_) {}
  return '';
}
const API_KEY = loadKey();

const API_HOST = 'api.nexscope.ai';
const API_PATH = '/api/skill-api/v1/skills/1688-product-search/run';
const HISTORY_FILE = path.join(__dirname, '1688_history.json');
const HISTORY_MAX = 100;          // 最多保留100条历史
const UPSTREAM_TIMEOUT_MS = 45000; // 上游超时45秒

/* ---------------- 历史记录持久化 ---------------- */
function loadHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch (_) { return []; }
}
function saveHistory(list) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(list.slice(0, HISTORY_MAX)));
}

function histKeyOf(params) {
  // 搜索定义字段才参与去重: 排序/页码不同视为同一次搜索(数据可合并)
  const def = {};
  ['keyWord', 'matchType', 'pageSize', 'companyType', 'offerType', 'sendTime', 'proxyRights', 'shiLiType']
    .forEach((k) => { if (params[k] != null && params[k] !== '') def[k] = params[k]; });
  return JSON.stringify(def);
}
function upsertHistory(params, products, elapsedMs) {
  const list = loadHistory();
  const key = histKeyOf(params);
  const now = new Date().toISOString();
  let rec = list.find((r) => histKeyOf(r.params) === key);
  if (rec) {
    const seen = new Set((rec.products || []).map((p) => String(p.offerId)));
    const merged = (rec.products || []).concat((products || []).filter((p) => !seen.has(String(p.offerId))));
    rec.time = now; rec.params = params; rec.products = merged; rec.elapsedMs = elapsedMs;
  } else {
    rec = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
            time: now, params, products, elapsedMs };
    list.unshift(rec);
  }
  saveHistory(list);
  return rec;
}

/* ---------------- 上游API ---------------- */
function callApi(body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: API_HOST, path: API_PATH, method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: UPSTREAM_TIMEOUT_MS,
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (_) {}
        if (res.statusCode === 200 && json && json.errcode === 200) resolve(json);
        else reject(new Error(`上游 HTTP ${res.statusCode} errcode=${json && (json.errcode ?? json.code)}: ${(json && (json.msg || json.errmsg)) || data.slice(0, 200)}`));
      });
    });
    req.on('timeout', () => req.destroy(new Error(`上游超时(${UPSTREAM_TIMEOUT_MS / 1000}秒无响应)`)));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

const log = (line) => console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${line}`);

/* ---------------- 前端页面 ---------------- */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

const HTML = String.raw`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>1688 商品搜索</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: "Microsoft YaHei", system-ui, sans-serif; background: #f5f6f8; color: #222; }
  .app { display: flex; min-height: 100vh; }
  /* 侧栏历史 */
  aside { width: 250px; flex-shrink: 0; background: #fff; border-right: 1px solid #e8eaee;
          padding: 14px 10px; overflow-y: auto; max-height: 100vh; position: sticky; top: 0; }
  aside h2 { font-size: 14px; margin: 0 6px 10px; }
  aside h2 .hint { display: block; font-size: 11px; color: #999; font-weight: normal; margin-top: 3px; }
  .hitem { padding: 8px 8px; border-radius: 8px; cursor: pointer; display: flex; justify-content: space-between;
           align-items: center; gap: 6px; }
  .hitem:hover { background: #f2f5fa; }
  .hitem.active { background: #fff1e8; }
  .hitem .k { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .hitem .t { font-size: 11px; color: #999; }
  .hitem .n { font-size: 11px; color: #ff6600; }
  .hdel { border: 0; background: none; color: #ccc; font-size: 15px; cursor: pointer; padding: 0 3px; flex-shrink: 0; }
  .hdel:hover { color: #d33; }
  .hempty { font-size: 12px; color: #bbb; text-align: center; padding: 20px 0; }
  /* 主区 */
  main { flex: 1; padding: 18px 20px; min-width: 0; }
  h1 { font-size: 19px; margin-bottom: 12px; }
  h1 .sub { font-size: 12px; color: #888; font-weight: normal; margin-left: 10px; }
  .bar { background: #fff; border-radius: 10px; padding: 12px 14px; box-shadow: 0 1px 4px rgba(0,0,0,.06);
         display: flex; flex-wrap: wrap; gap: 9px; align-items: center; }
  .bar input, .bar select { border: 1px solid #d9dce1; border-radius: 6px; padding: 7px 9px; font-size: 14px; }
  .bar input:focus, .bar select:focus { outline: 2px solid #4b8bf5; border-color: transparent; }
  #kw { width: 220px; }
  .num { width: 78px; }
  button { background: #ff6600; color: #fff; border: 0; border-radius: 6px; padding: 8px 24px;
           font-size: 14px; cursor: pointer; }
  button:hover { background: #e85d00; }
  button:disabled { background: #ccc; cursor: wait; }
  .banner { margin-top: 12px; background: #fff8ec; border: 1px solid #f0dcb0; color: #8a6d3b;
            border-radius: 8px; padding: 9px 12px; font-size: 13px; display: flex;
            justify-content: space-between; align-items: center; gap: 10px; }
  .banner button { background: #fff; color: #ff6600; border: 1px solid #ff6600; padding: 4px 12px; font-size: 12px; }
  .meta { margin: 12px 2px; font-size: 13px; color: #666; display: flex; justify-content: space-between; }
  table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 10px; overflow: hidden;
          box-shadow: 0 1px 4px rgba(0,0,0,.06); }
  th, td { padding: 9px 10px; text-align: left; font-size: 13px; border-bottom: 1px solid #f0f1f3; vertical-align: middle; }
  th { background: #fafbfc; color: #555; font-weight: 600; white-space: nowrap; position: sticky; top: 0; }
  td.img img { width: 64px; height: 64px; object-fit: cover; border-radius: 6px; background: #f0f0f0; display: block; }
  td.title a { color: #1a4b8f; text-decoration: none; line-height: 1.45; display: block; max-width: 360px; }
  td.title a:hover { color: #ff6600; }
  td.title .id { color: #aaa; font-size: 12px; }
  .price { color: #ff4400; font-weight: 700; white-space: nowrap; }
  .consign { color: #c47a00; white-space: nowrap; }
  td.muted { color: #888; white-space: nowrap; }
  .pager { display: flex; gap: 8px; align-items: center; justify-content: center; margin: 16px 0; }
  .pager button { background: #fff; color: #333; border: 1px solid #d9dce1; padding: 6px 16px; }
  .pager button:disabled { color: #bbb; background: #fff; cursor: default; }
  .pager button:not(:disabled):hover { border-color: #ff6600; color: #ff6600; }
  #msg { text-align: center; padding: 50px 20px; color: #999; font-size: 14px; }
  #msg.err { color: #d33; }
  td.op .ai { background:#4b6bfb; font-size:12px; padding:5px 10px; border-radius:6px; white-space:nowrap; }
  td.op .ai:hover { background:#3a57e0; }
  td.op .sku { background:#0e9f6e; font-size:12px; padding:5px 10px; border-radius:6px; white-space:nowrap; }
  td.op .sku:hover { background:#0b7f57; }
  .skutab { width:100%; border-collapse:collapse; margin:10px 0; }
  .skutab th, .skutab td { border:1px solid #e5e7eb; padding:6px 8px; font-size:12.5px; }
  .skutab th { background:#f8f9fb; color:#555; }
  .skutab img { width:32px; height:32px; object-fit:cover; border-radius:4px; vertical-align:middle; }
  .kv { display:grid; grid-template-columns:auto 1fr; gap:4px 12px; font-size:13px; margin:8px 0; }
  .kv .k { color:#888; }
  .drawer-mask { position:fixed; inset:0; background:rgba(0,0,0,.35); display:none; z-index:50; }
  .drawer { position:fixed; top:0; right:-540px; width:520px; max-width:95vw; height:100vh; background:#fff;
            box-shadow:-4px 0 20px rgba(0,0,0,.15); z-index:51; transition:right .25s; display:flex; flex-direction:column; }
  .drawer.open { right:0; }
  .drawer .dhead { padding:13px 16px; border-bottom:1px solid #eee; display:flex; justify-content:space-between; align-items:center; gap:8px; }
  .drawer .dhead h3 { font-size:14px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:600; }
  .drawer .dbody { padding:16px; overflow-y:auto; flex:1; font-size:13.5px; line-height:1.75; }
  .dclose { border:0; background:none; font-size:22px; color:#999; cursor:pointer; padding:0 4px; }
  .score-row { display:flex; align-items:center; margin-bottom:6px; }
  .score-big { font-size:36px; font-weight:800; color:#ff6600; line-height:1; }
  .score-max { color:#bbb; font-size:13px; margin-left:3px; }
  .verdict { display:inline-block; background:#fff1e8; color:#ff6600; font-weight:700; border-radius:6px; padding:3px 10px; font-size:13px; margin-left:10px; }
  .dimbar { margin:10px 0; }
  .dimbar .dt { display:flex; justify-content:space-between; font-size:12.5px; color:#444; margin-bottom:3px; }
  .dimbar .dn { color:#999; font-size:11.5px; margin-top:2px; }
  .dimbar .track { height:8px; background:#f0f1f3; border-radius:4px; overflow:hidden; }
  .dimbar .fill { height:100%; background:linear-gradient(90deg,#ffb26b,#ff6600); border-radius:4px; }
  .chips { margin:8px 0 2px; }
  .chip { display:inline-block; background:#eef3ff; color:#3a57e0; border-radius:5px; padding:2px 8px; font-size:12px; margin:2px 4px 2px 0; }
  .chip.gray { background:#f3f4f6; color:#888; }
  .rpt { border-top:1px dashed #e5e7eb; margin-top:14px; padding-top:4px; }
  .rpt h3 { font-size:14.5px; margin:12px 0 5px; color:#1a1a1a; }
  .rpt b { color:#ff4400; }
  .dnote { font-size:12px; color:#999; margin-top:12px; border-top:1px solid #f0f1f3; padding-top:8px; }
  .dloading { text-align:center; padding:70px 20px; color:#666; }
  .dloading b { color:#ff6600; font-size:17px; }
  .derr { color:#d33; padding:30px 10px; text-align:center; }
  #jserr { display:none; position:fixed; bottom:0; left:0; right:0; background:#d33030; color:#fff;
           padding:8px 12px; font-size:12px; z-index:99; white-space:pre-wrap; }
  th.sorted { background:#fff3e9 !important; color:#ff6600; }
  td.sorted { background:#fffaf4; }
  /* ---- v11 视觉优化 ---- */
  body { background:linear-gradient(180deg,#f3f5f9 0%,#eef1f6 100%); }
  aside { border-right-color:#e6e9ef; }
  .bar { border:1px solid #eceef2; box-shadow:0 2px 12px rgba(31,41,55,.08); }
  #go { background:linear-gradient(135deg,#ff8a3d,#ff5400); box-shadow:0 2px 10px rgba(255,102,0,.35); padding:8px 30px; font-weight:600; }
  #go:hover { background:linear-gradient(135deg,#ff7a2d,#e85400); box-shadow:0 3px 12px rgba(255,102,0,.45); }
  /* 采购条件 / 候选 / 收藏 */
  .adv { margin-top:8px; font-size:12.5px; background:#fff; border:1px solid var(--line); border-radius:8px; padding:6px 12px; }
  .adv summary { cursor:pointer; color:#666; font-size:12.5px; }
  /* ---- 筛选卡: 类目/列显示药丸 ---- */
  .filtercard { margin-top:10px; background:#FDFCF8; border:1px solid #E7E3D7; border-radius:12px;
                padding:8px 12px; display:flex; flex-direction:column; gap:6px; box-shadow:0 1px 5px rgba(74,56,44,.05); }
  .frow { display:flex; gap:10px; align-items:flex-start; }
  .frow + .frow { border-top:1px dashed #EDEAE0; padding-top:6px; }
  .flabel { flex-shrink:0; font-size:11px; color:#A6A296; padding:3px 9px; background:#F3F0E7; border-radius:6px; margin-top:1px; }
  .fchips { display:flex; flex-wrap:wrap; gap:4px 5px; }
  .fchips label { border:1px solid #E4E0D4; border-radius:13px; padding:2px 10px; font-size:12px; color:#8F8B7E;
                  background:#fff; cursor:pointer; user-select:none; transition:all .12s; }
  .fchips label:hover { border-color:#D9B8A2; }
  .fchips label:has(input:checked) { border-color:#E0A986; background:#F9EFE7; color:#B0522C; font-weight:500; }
  .fchips input { display:none; }
  .fchips label .n { opacity:.5; font-size:10.5px; margin-left:1px; }
  details.fcolmore summary { cursor:pointer; font-size:11.5px; color:#A6A296; list-style:none; padding:2px 9px;
                             border-radius:6px; background:#F3F0E7; }
  details.fcolmore summary:hover { color:#B0522F; }
  details.fcolmore[open] summary { margin-bottom:6px; }
  details.fcolmore .fchips { margin-top:6px; }
  #banner .bann { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-top:8px;
                  background:#FBF7EC; border:1px dashed #E2D5B4; color:#8A7B52; font-size:12px;
                  padding:6px 12px; border-radius:9px; }
  #research { margin-left:auto; background:#fff; border:1px solid #D9B8A2; color:#B0522C; border-radius:14px;
              padding:2px 12px; font-size:12px; cursor:pointer; white-space:nowrap; }
  #research:hover { background:#F6EAE2; border-color:#C96442; }
  .advrow { display:flex; flex-wrap:wrap; gap:8px 16px; margin-top:8px; align-items:center; }
  .advrow select { border:1px solid #d9dce1; border-radius:6px; padding:5px 8px; font-size:12.5px; }
  .advrow label { display:flex; align-items:center; gap:3px; font-size:12.5px; white-space:nowrap; }
  #pickbar { position:fixed; left:50%; transform:translateX(-50%); bottom:16px; background:#26241F; color:#fff;
             border-radius:24px; padding:9px 20px; display:none; gap:12px; align-items:center; z-index:40;
             font-size:13px; box-shadow:0 4px 18px rgba(0,0,0,.28); }
  #pickbar.show { display:flex; }
  #pickbar button { background:transparent; color:#ffd9c7; border:1px solid #6b675c; border-radius:14px;
                    padding:3px 12px; cursor:pointer; font-size:12px; }
  #pickbar button:hover { border-color:#ff9d6b; color:#fff; }
  #pickbar #pickN { color:#ffb26b; }
  td.sel, th.sel { text-align:center; width:34px; }
  .star { user-select:none; }
  /* AI对话抽屉(Claude风) */
  .chatpanel { position:fixed; top:0; right:0; width:680px; max-width:96vw; height:100vh; background:#F5F3EC;
               z-index:60; transition:transform .25s; transform:translateX(105%); display:flex; flex-direction:column; box-shadow:-6px 0 26px rgba(60,50,30,.16); }
  .chatpanel.open { transform:none; }
  .cp-resize { position:absolute; left:-3px; top:0; width:7px; height:100%; cursor:ew-resize; z-index:5; }
  .cp-resize:hover { background:rgba(201,100,66,.18); }
  .cp-head { padding:13px 18px; display:flex; justify-content:space-between; align-items:center; gap:10px;
             border-bottom:1px solid #E7E3D7; background:#FDFCF8;
             box-shadow:0 1px 0 rgba(201,100,66,.08), 0 2px 10px rgba(74,56,44,.05); }
  .cp-head .t { font-size:15px; font-weight:700; font-family:Georgia,"SimSun",serif; color:#3D2E22;
                display:flex; align-items:center; gap:8px; }
  .cp-head .t::before { content:''; width:8px; height:8px; border-radius:50%;
                        background:linear-gradient(135deg,#D97B57,#C96442); box-shadow:0 0 0 3px rgba(201,100,66,.15); }
  .cp-head .d { font-size:11px; color:#8F8B7E; margin-top:1px; }
  .cp-head .btns { display:flex; align-items:center; gap:8px; }
  .cp-close { border:0; background:none; font-size:20px; color:#8F8B7E; cursor:pointer; width:30px; height:30px; border-radius:8px; line-height:1; }
  .cp-close:hover { background:#F0EBDF; color:#B0522F; }
  .cp-log { flex:1; overflow-y:auto; padding:16px 18px; background:linear-gradient(180deg,#F5F3EC 0%,#F1EEE5 100%); }
  .cp-log::-webkit-scrollbar, .cp-side-list::-webkit-scrollbar { width:6px; }
  .cp-log::-webkit-scrollbar-thumb, .cp-side-list::-webkit-scrollbar-thumb { background:#D9D4C5; border-radius:3px; }
  .cp-msg { margin:10px 0; font-size:13.5px; line-height:1.8; }
  .cp-msg.user { background:linear-gradient(135deg,#F9EFE7,#F5E7DC); border:1px solid #EBD5C8; border-radius:14px 14px 4px 14px;
                 padding:8px 14px; color:#4A382C; width:fit-content; max-width:82%; margin-left:auto;
                 box-shadow:0 1px 3px rgba(74,56,44,.07); word-break:break-word; }
  .cp-msg.bot { background:#FDFCF8; border:1px solid #E7E3D7; border-radius:4px 14px 14px 14px; padding:11px 15px;
                box-shadow:0 1px 4px rgba(74,56,44,.06); }
  .cp-msg.bot b { color:#B0522F; }
  .cp-msg.tblwrap { padding:12px; overflow-x:auto; background:#fff; }
  .cp-msg table { border-collapse:collapse; width:100%; font-size:12px; margin:2px 0; }
  .cp-msg th, .cp-msg td { border-bottom:1px solid #F1EEE4; padding:6px 8px; text-align:left; }
  .cp-msg th { color:#8F8B7E; font-size:11px; font-weight:600; background:#FAF8F2; }
  .cp-msg tbody tr:hover { background:#FAF6EF; }
  .cp-msg td a { color:#B0522F; text-decoration:none; border-bottom:1px dotted #D8B7A5; }
  .cp-msg td a:hover { color:#C96442; border-bottom-style:solid; }
  .cp-sys { text-align:center; color:#A6A296; font-size:11.5px; margin:8px 0; }
  .cp-foot { padding:12px 14px; background:#FDFCF8; border-top:1px solid #E7E3D7; display:flex; gap:8px; }
  #cpInp { flex:1; border:1px solid #D9D4C5; border-radius:12px; padding:9px 14px; font-size:13.5px; outline:0; background:#fff;
           transition:border-color .15s, box-shadow .15s; }
  #cpInp:focus { border-color:#C96442; box-shadow:0 0 0 3px rgba(201,100,66,.13); }
  #cpSend { background:linear-gradient(135deg,#D97B57,#C96442); color:#FFF7F0; border:0; border-radius:12px; padding:9px 20px;
            cursor:pointer; font-size:13px; font-weight:600; box-shadow:0 2px 6px rgba(201,100,66,.3); transition:all .15s; }
  #cpSend:hover { background:linear-gradient(135deg,#C96442,#B0522F); box-shadow:0 3px 10px rgba(201,100,66,.4); }
  #cpSend:disabled { background:#D9D4C5; box-shadow:none; cursor:default; }
  .cp-confirm { background:linear-gradient(135deg,#D97B57,#C96442); color:#FFF7F0; border:0; border-radius:18px;
                padding:6px 16px; cursor:pointer; font-size:12.5px; font-weight:600; margin:4px 0;
                box-shadow:0 2px 6px rgba(201,100,66,.28); transition:all .15s; }
  .cp-confirm:hover { box-shadow:0 3px 10px rgba(201,100,66,.42); transform:translateY(-1px); }
  .cp-confirm:disabled { background:#D9D4C5; box-shadow:none; transform:none; cursor:default; }
  .cp-export { background:none; border:1px solid #DDD8CA; color:#8F8B7E; border-radius:8px; padding:4px 11px; cursor:pointer;
               font-size:11.5px; transition:all .15s; }
  .cp-export:hover { border-color:#C96442; color:#B0522F; background:#FAF4EE; }
  .cp-op { background:#fff; border:1px solid #DDD8CA; border-radius:6px; cursor:pointer; font-size:12px; padding:2px 7px; transition:all .12s; }
  .cp-op.cp-ai:hover { border-color:#5b7cfa; background:#f0f3ff; }
  .cp-op.cp-sku:hover { border-color:#0e9f6e; background:#eefaf5; }
  /* 对话会话历史(面板内左侧栏,常驻) */
  .cp-body { flex:1; display:flex; min-height:0; }
  .cp-side { width:216px; flex-shrink:0; overflow:hidden; background:#EFECE2; border-right:1px solid #E2DED1;
             display:flex; flex-direction:column; }
  .cp-side-head { padding:12px 10px 8px; }
  .cp-new { width:100%; background:#FDFCF8; border:1px solid #DDA68C; color:#B0522F; border-radius:9px; padding:7px 0;
            cursor:pointer; font-size:12.5px; font-weight:600; transition:all .15s; }
  .cp-new:hover { background:#F6EAE2; border-color:#C96442; box-shadow:0 1px 4px rgba(201,100,66,.15); }
  .cp-side-list { flex:1; overflow-y:auto; padding:4px 8px 10px; }
  .cp-sess { padding:8px 10px; border-radius:9px; cursor:pointer; margin-bottom:4px; position:relative; transition:background .12s; }
  .cp-sess:hover { background:#E7E3D6; }
  .cp-sess.active { background:#F6EAE2; box-shadow:inset 3px 0 0 #C96442; }
  .cp-sess .t { font-size:12.5px; color:#4A382C; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:500; }
  .cp-sess.active .t { color:#B0522F; }
  .cp-sess .s { font-size:10.5px; color:#A6A296; margin-top:2px; }
  .cp-msg.cp-trace { background:none; border:0; color:#A6A296; font-size:11.5px; padding:3px 10px; font-style:italic;
                     white-space:pre-wrap; border-left:2px solid #E0DACA; margin-left:10px; }
  .cp-think { margin:10px 0 4px; }
  .cp-think details { background:#F0EDE3; border:1px solid #E2DED1; border-radius:10px; overflow:hidden; }
  .cp-think summary { list-style:none; cursor:pointer; padding:7px 12px; font-size:12px; color:#8F8B7E;
                      user-select:none; display:flex; align-items:center; gap:6px; }
  .cp-think summary::-webkit-details-marker { display:none; }
  .cp-think summary:hover { color:#B0522F; }
  .cp-think .cp-think-hint { font-size:10.5px; color:#B9B5A6; }
  .cp-think-body { padding:4px 14px 10px; font-size:11.5px; color:#989487; line-height:1.7;
                   white-space:pre-wrap; max-height:220px; overflow-y:auto; border-top:1px dashed #E2DED1; }
  .cp-waitdots { animation:cpwait 1.2s infinite; color:#C96442; letter-spacing:5px; font-size:9px; }
  @keyframes cpwait { 0%,100%{opacity:.25} 50%{opacity:1} }
  #chatOpen { background:linear-gradient(135deg,#5b7cfa,#3a57e0); border:0; cursor:pointer; }
  #chatOpen:hover { background:linear-gradient(135deg,#4a6bef,#2f49d0); box-shadow:0 3px 14px rgba(58,87,224,.45); }
  /* 移动端/窄屏适配 */
  @media (max-width: 860px) {
    .app { flex-direction: column; }
    aside { width: auto; border-right: 0; border-bottom: 1px solid #e8eaee; max-height: 34vh; overflow-y: auto; }
    main { padding: 12px; }
    .chatpanel { width: 100vw !important; max-width: 100vw; }
    .cp-resize { display: none; }
    .cp-side { display: none; }
    .drawer { width: 100vw; right: -100vw; }
    table { font-size: 12px; }
    .cp-msg table { font-size: 11px; }
  }
  table { box-shadow:0 2px 12px rgba(31,41,55,.07); }
  tbody tr:nth-child(even) { background:#fafbfd; }
  tbody tr:hover { background:#f4f8ff; }
  th { box-shadow:inset 0 -1px 0 #eef0f3; }
  th.sorted { box-shadow:inset 0 -2px 0 #ff6600; }
  .ai-entry { background:linear-gradient(135deg,#5b7cfa,#3a57e0); color:#fff; text-decoration:none;
              padding:9px 18px; border-radius:8px; font-size:14px; font-weight:600; white-space:nowrap;
              box-shadow:0 2px 10px rgba(58,87,224,.3); }
  .ai-entry:hover { background:linear-gradient(135deg,#4a6bef,#2f49d0); box-shadow:0 3px 14px rgba(58,87,224,.45); }
  td.price, td.consign, td.orders, td.qty, td.amount { font-variant-numeric:tabular-nums; }
  td.op .ai { background:linear-gradient(135deg,#5b7cfa,#3a57e0); }
  td.op .sku { background:linear-gradient(135deg,#12b981,#0e9f6e); }
  .rpt h3 { border-left:3px solid #ff6600; padding-left:8px; margin:14px 0 6px; }
  .drawer .dhead { background:linear-gradient(90deg,#fff8f3,#fff); }
  #msg.wait b { color: #ff6600; font-size: 18px; }
</style>
</head>
<body>
<div class="app">
  <aside>
    <h2>🕘 搜索历史 <span class="hint">结果已缓存到本地,点击免费回看,不消耗credits</span></h2>
    <div id="hlist"><div class="hempty">暂无记录</div></div>
  </aside>
  <main>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;gap:12px;flex-wrap:wrap">
      <h1 style="margin-bottom:0">🔍 1688 商品搜索 <span class="sub">数据源: Nexscope API · 界面 v15 · 搜索12cr · SKU/详情2cr · AI生成免费</span></h1>
      <button class="ai-entry" id="chatOpen" title="打开AI采购助手对话面板:用自然语言搜索筛选,数据在页内直接看">💬 AI 采购助手</button>
    </div>
    <div class="bar">
      <input id="kw" placeholder="输入关键词,如: 保温杯" value="保温杯">
      <select id="match">
        <option value="1">模糊匹配</option>
        <option value="3">精确匹配</option>
      </select>
      <select id="sort">
        <option value="">默认排序</option>
        <option value="orderCount30d:desc">近30天订单数 ↓</option>
        <option value="saleCount30d:desc">近30天销量件数 ↓</option>
        <option value="saleVolume30d:desc">近30天预估销售额 ↓</option>
        <option value="price:asc">批发价 ↑</option>
        <option value="price:desc">批发价 ↓</option>
        <option value="consignPrice:asc">代发价 ↑</option>
        <option value="offerCreateTime:desc">最新上架 ↓</option>
      </select>
      <label style="font-size:13px;display:flex;align-items:center;gap:4px;white-space:nowrap" title="过滤标题里只含'保温'等局部词的不相关商品">
        <input type="checkbox" id="relfilter" checked>标题须含完整关键词
      </label>
      <label style="font-size:13px;display:flex;align-items:center;gap:4px;white-space:nowrap" title="只显示点过★收藏的商品">
        <input type="checkbox" id="staronly">只看收藏
      </label>
      <input class="num" id="pmin" type="number" placeholder="价格≥">
      <input class="num" id="pmax" type="number" placeholder="价格≤">
      <select id="size"><option>20</option><option>10</option><option>50</option><option>100</option></select>
      <button id="go">搜 索</button>
    </div>
    <details class="adv">
      <summary>采购条件(工厂直营 / 支持定制 / 一件代发 / 先采后付 / 诚信通 · 修改后需重新搜索)</summary>
      <div class="advrow">
        <select id="companyType"><option value="">供应商:全部</option><option value="2">仅工厂</option><option value="1">仅门店</option></select>
        <select id="offerType"><option value="">商品:全部</option><option value="2">新品</option><option value="3">1688严选</option><option value="4">跨境</option><option value="5">支持定制</option></select>
        <select id="sendTime"><option value="">发货时效:全部</option><option value="24">24小时</option><option value="48">48小时</option><option value="72">72小时</option></select>
        <label style="display:flex;align-items:center;gap:3px"><input type="checkbox" id="fDrop">一件代发</label>
        <label style="display:flex;align-items:center;gap:3px"><input type="checkbox" id="fCod">先采后付</label>
        <label style="display:flex;align-items:center;gap:3px"><input type="checkbox" id="fTp">诚信通</label>
        <label style="display:flex;align-items:center;gap:3px"><input type="checkbox" id="fSf">超级工厂</label>
      </div>
    </details>
    <div class="filtercard">
      <div class="frow"><span class="flabel">类目</span><div class="fchips" id="catbar"></div></div>
      <details class="fcolmore"><summary>▸ 列显示(点击展开/收起,当前显示 <span id="coln">-</span> 列)</summary><div class="fchips" id="colbar"></div></details>
    </div>
    <div id="banner"></div>
    <div class="meta"><span id="stat"></span><span id="pageinfo"></span></div>
    <div id="result"><div id="msg">输入关键词开始搜索</div></div>
    <div class="pager">
      <button id="prev">← 上一页</button>
      <span id="ptext" style="font-size:13px;color:#666"></span>
      <button id="next">下一页 →</button>
    </div>
    <div id="pickbar">已选 <b id="pickN">0</b> 个候选 <button id="pickCompare">⚖️ 对比</button><button id="pickCsv">📥 导出CSV</button><button id="pickClear">清空</button></div>
  </main>
</div>
<div class="drawer-mask" id="mask"></div>
<div class="drawer" id="drawer">
  <div class="dhead"><h3 id="dtitle">🤖 AI 深度测评</h3><button class="dclose" id="dclose" title="关闭">×</button></div>
  <div class="dbody" id="dbody"></div>
</div>
<div id="jserr"></div>
<div class="chatpanel" id="chatpanel">
  <div class="cp-resize" id="cpResize" title="拖动调整宽度"></div>
  <div class="cp-head"><div><div class="t">AI 采购助手</div><div class="d">自然语言筛选 · 数据仓复用免费 · 精查前先报价 · 左缘可拖宽</div></div><div class="btns"><button class="cp-export" id="cpExport" title="把本次对话导出为Markdown,可直接贴进采购报告">⬇ 导出</button><button class="cp-close" id="cpClose" title="关闭">×</button></div></div>
  <div class="cp-body">
    <div class="cp-side" id="cpSide">
      <div class="cp-side-head"><button class="cp-new" id="cpNew">＋ 新对话</button></div>
      <div class="cp-side-list" id="cpSessList"></div>
    </div>
    <div style="flex:1;display:flex;flex-direction:column;min-width:0">
      <div class="cp-log" id="cpLog"><div class="cp-sys">直接说人话,例:"只看广东产的,价格低于20,按销量排"。数据仓已有的关键词不重复扣费。</div></div>
      <div class="cp-foot"><input id="cpInp" placeholder="问点什么…"><button id="cpSend">发送</button></div>
    </div>
  </div>
</div>
<script>
function showJsErr(t) { const d = document.getElementById('jserr'); if (d) { d.style.display = 'block'; d.textContent = '⚠️ 页面脚本错误(把这句话发给AI): ' + t; } }
window.addEventListener('error', (e) => showJsErr((e.message || '未知错误') + ' @第' + e.lineno + '行'));
window.addEventListener('unhandledrejection', (e) => showJsErr('Promise拒绝: ' + ((e.reason && e.reason.message) || e.reason)));
console.log('1688 UI v15');
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let page = 1, mode = 'live', curParams = null, curHistoryId = null, waitTimer = null, curList = [], fullList = [], mutedCats = new Set(), catList = [];
const picked = new Map();
const starSet = new Set(JSON.parse(localStorage.getItem('star1688') || '[]'));
let noteMap = {};
try { noteMap = JSON.parse(localStorage.getItem('note1688') || '{}'); } catch (_) { noteMap = {}; }

function fmtPrice(v) { return (v === null || v === undefined || v === '') ? '—' : '¥' + v; }
function fmtTime(iso) {
  const d = new Date(iso), p = (n) => String(n).padStart(2, '0');
  return (d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
function qp(q) {
  // 上游有时返回JSON字符串而非数组,先归一化
  if (typeof q === 'string' && q.trim().startsWith('[')) { try { q = JSON.parse(q); } catch (_) {} }
  if (Array.isArray(q) && q.length) {
    return q.map((r) => {
      const raw = r.quantity ?? null;
      const qty = raw == null ? '≥' + (r.beginQuantity ?? '?') : (String(raw).includes(':') ? raw : raw + '件');
      return qty + ' ¥' + (r.value ?? r.price ?? '?');
    }).join('<br>');
  }
  return (q && !Array.isArray(q)) ? esc(q) : '—';
}
const COLS = [
  { k:'sel',      label:'选' },
  { k:'img',      label:'图片' },
  { k:'title',    label:'商品标题' },
  { k:'price',    label:'批发价', sort:'price' },
  { k:'consign',  label:'代发价', sort:'consignPrice' },
  { k:'qr',       label:'价格区间' },
  { k:'moq',      label:'起订量' },
  { k:'orders',   label:'近30天订单', sort:'orderCount30d' },
  { k:'qty',      label:'近30天销量(件)', sort:'saleCount30d' },
  { k:'amount',   label:'预估月销额', sort:'saleVolume30d' },
  { k:'cat',      label:'类目' },
  { k:'company',  label:'供应商' },
  { k:'delivery', label:'发货时效' },
  { k:'listed',   label:'上架时间', sort:'offerCreateTime' },
  { k:'dtype',    label:'数据口径' },
  { k:'ops',      label:'操作' },
];
const ALL_KEYS = COLS.map((c) => c.k);
function getVisCols() {
  try {
    const v = JSON.parse(localStorage.getItem('cols1688') || 'null');
    if (Array.isArray(v)) return ALL_KEYS.filter((k) => v.includes(k));
  } catch (_) {}
  return ALL_KEYS.slice();
}
function isSortedCol(c) { return !!(curParams && curParams.sortField && c.sort && c.sort === curParams.sortField); }
function soTd(k2) { return isSortedCol(COLS.find((x) => x.k === k2)) ? ' class="sorted"' : ''; }
function cellHtml(p, k, i) {
  const oid = String(p.offerId ?? '');
  switch (k) {
    case 'sel': return '<td class="sel" style="text-align:center"><input type="checkbox" class="picksel" data-id="' + esc(oid) + '"' + (picked.has(oid) ? ' checked' : '') + '></td>';
    case 'img': return '<td class="img">' + (p.imageUrl ? '<img src="' + esc(p.imageUrl) + '" referrerpolicy="no-referrer" loading="lazy">' : '<div style="width:64px;height:64px"></div>') + '</td>';
    case 'title': { const url = p.asinUrl || (p.offerId ? 'https://detail.1688.com/offer/' + p.offerId + '.html' : '#');
      const st = starSet.has(oid);
      const note = noteMap[oid] ? '<span class="notemark" title="' + esc(noteMap[oid]) + '">📝</span> ' : '';
      return '<td class="title"><span class="star" data-id="' + esc(oid) + '" style="cursor:pointer;color:' + (st ? '#F5A623' : '#C8C4B8') + '" title="收藏/取消收藏(采购候选)">★</span> <a href="' + esc(url) + '" target="_blank" rel="noopener">' + esc(p.title || '(无标题)') + '</a><span class="id">ID: ' + esc(p.offerId) + '</span>' + (note ? '<div style="font-size:12px">' + note + esc(noteMap[oid]) + '</div>' : '') + '</td>'; }
    case 'price': return '<td class="price' + (isSortedCol(COLS.find((x) => x.k === 'price')) ? ' sorted' : '') + '">' + fmtPrice(p.price) + '</td>';
    case 'consign': return '<td class="consign' + (isSortedCol(COLS.find((x) => x.k === 'consign')) ? ' sorted' : '') + '">' + fmtPrice(p.consignPrice) + '</td>';
    case 'qr': return '<td>' + qp(p.quantityPrices) + '</td>';
    case 'moq': return '<td>' + (p.quantityBegin != null ? esc(String(p.quantityBegin)) + ' ' + esc(p.unit || '') : '—') + '</td>';
    case 'orders': return '<td' + soTd('orders') + '>' + (p.salesOrderCount ?? '—') + '</td>';
    case 'qty': return '<td' + soTd('qty') + '>' + (p.salesQuantity ?? '—') + '</td>';
    case 'amount': { const a = p.estimatedSalesAmount; return '<td' + soTd('amount') + '>' + (a == null ? '—' : '¥' + Number(a).toLocaleString()) + '</td>'; }
    case 'cat': return '<td class="muted">' + esc(p.levelName || '—') + '</td>';
    case 'company': return '<td class="muted">' + (p.shopUrl ? '<a href="' + esc(p.shopUrl) + '" target="_blank" rel="noopener" title="打开1688店铺,可看公司详情、联系方式、经营资质" style="color:#555;text-decoration:none;border-bottom:1px dotted #bbb">' + esc(p.company || '查看店铺') + '</a>' : esc(p.company || '—')) + '</td>';
    case 'delivery': return '<td class="muted">' + (p.deliveryTime ? esc(String(p.deliveryTime)) + '小时' : '—') + '</td>';
    case 'listed': return '<td class="muted">' + esc((p.availableDate || '—').slice(0, 16)) + '</td>';
    case 'dtype': { const dt = p.dataType; return '<td class="muted">' + (dt === 'weeklyData' ? '周数据' : dt === 'monthlyData' ? '月数据' : '—') + '</td>'; }
    case 'ops': return '<td class="op"><div style="display:flex;flex-direction:column;gap:4px">' +
      '<button class="ai" data-idx="' + i + '" title="商品详情增强(2credits)+AI生成商品与公司采购测评(GLM免费)">🤖 AI测评</button>' +
      '<button class="sku" data-idx="' + i + '" title="查看每个规格的价格/代发价/库存(2credits,10分钟内重复免费)">📋 SKU</button></div></td>';
    default: return '<td>—</td>';
  }
}
function renderTable(list) {
  curList = list;
  if (!list.length) { $('result').innerHTML = '<div id="msg">本页没有商品数据</div>'; return; }
  const vis = getVisCols();
  const head = vis.map((k) => { const c = COLS.find((x) => x.k === k); if (!c) return ''; const so = isSortedCol(c);
    return '<th class="' + (so ? 'sorted' : '') + '">' + c.label + (so ? (curParams.sortType === 'asc' ? ' ↑' : ' ↓') : '') + '</th>'; }).join('');
  const rows = list.map((p, i) => '<tr>' + vis.map((k) => cellHtml(p, k, i)).join('') + '</tr>').join('');
  $('result').innerHTML = '<table><thead><tr>' + head + '</tr></thead><tbody>' + rows + '</tbody></table>';
}
function renderColBar() {
  const vis = getVisCols();
  const n = document.getElementById('coln');
  if (n) n.textContent = vis.length + '/' + COLS.length;
  $('colbar').innerHTML = COLS.map((c) =>
    '<label><input type="checkbox" data-k="' + c.k + '"' + (vis.includes(c.k) ? ' checked' : '') + '>' + c.label + '</label>').join('');
}
function setPager(listLen, pageSize) {
  // 上游不返回真实总数(totalPage=null),用"整页返回则可能还有下一页"的开放翻页策略
  $('prev').disabled = page <= 1;
  $('next').disabled = !(listLen >= pageSize);
  $('ptext').textContent = '第 ' + page + ' 页';
  $('pageinfo').textContent = '第 ' + page + ' 页 · 已抓取 ' + listLen + ' 条';
}

/* ---- 本地操作: 排序/筛选只作用于已抓取数据,零credits ---- */
function cmpBy(field, dir) {
  const mul = dir === 'asc' ? 1 : -1;
  const val = (x) => {
    switch (field) {
      case 'price': return Number(x.price);
      case 'consignPrice': return Number(x.consignPrice);
      case 'orderCount30d': return Number(x.salesOrderCount ?? -1);
      case 'saleCount30d': return Number(x.salesQuantity ?? -1);
      case 'saleVolume30d': return Number(x.estimatedSalesAmount ?? -1);
      case 'offerCreateTime': return String(x.availableDate || '');
      default: return null;
    }
  };
  return (a, b) => {
    const va = val(a), vb = val(b);
    if (typeof va === 'string' || typeof vb === 'string') {
      const sa = String(va), sb = String(vb);
      return sa < sb ? -mul : sa > sb ? mul : 0;
    }
    const na = isNaN(va) ? -Infinity : va, nb = isNaN(vb) ? -Infinity : vb;
    return (na - nb) * mul;
  };
}
function applyLocalOps() {
  let list = fullList.slice();
  const kw = ($('relfilter').checked && curParams && curParams.keyWord) ? curParams.keyWord : '';
  if (kw) list = list.filter((x) => String(x.title || '').includes(kw));
  if ($('staronly').checked) list = list.filter((x) => starSet.has(String(x.offerId)));
  const pmin = parseFloat($('pmin').value), pmax = parseFloat($('pmax').value);
  if (!isNaN(pmin)) list = list.filter((x) => Number(x.price) >= pmin);
  if (!isNaN(pmax)) list = list.filter((x) => Number(x.price) <= pmax);
  if (mutedCats.size) list = list.filter((x) => !mutedCats.has(leafOf(x.levelName)));
  const sv = $('sort').value;
  if (sv) {
    const parts = sv.split(':'), f = parts[0], t = parts[1] || 'desc';
    list.sort(cmpBy(f, t));
    curParams = Object.assign({}, curParams || {}, { sortField: f, sortType: t });
  } else if (curParams) {
    curParams = Object.assign({}, curParams, { sortField: null });
  }
  curList = list;
  renderTable(list);
  setPager(fullList.length, (curParams && curParams.pageSize) || 20);
  return list;
}
function leafOf(ln) {
  const parts = String(ln || '').split(/[>,]/).map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '未分类';
}
function buildCatBar() {
  const counts = {};
  fullList.forEach((p) => { const c = leafOf(p.levelName); counts[c] = (counts[c] || 0) + 1; });
  catList = Object.entries(counts).sort((a, b) => b[1] - a[1]).map((e) => e[0]);
  const countsMap = counts;
  $('catbar').innerHTML = (catList.length ? catList.map((c, idx) =>
    '<label><input type="checkbox" data-i="' + idx + '"' + (mutedCats.has(c) ? '' : ' checked') + '>' + esc(c) + '<span class="n">×' + countsMap[c] + '</span></label>').join('') : '<span style="color:#bbb">无类目数据</span>');
}

/* ---- 搜索(实时,消耗credits) ---- */
async function search(over) {
  const params = Object.assign(
    { searchType: +$('match').value, keyWord: $('kw').value.trim(), pageIndex: page, pageSize: +$('size').value },
    over || {});
  if (!params.keyWord) { showMsg('请输入关键词', true); return; }
  const [f, t] = $('sort').value.split(':');
  if (f) { params.sortField = f; params.sortType = t || 'desc'; }
  if ($('companyType').value) params.companyType = +$('companyType').value;
  if ($('offerType').value) params.offerType = +$('offerType').value;
  if ($('sendTime').value) params.sendTime = $('sendTime').value;
  const pr = []; if ($('fDrop').checked) pr.push('4360897'); if ($('fCod').checked) pr.push('449154');
  if (pr.length) params.proxyRights = pr.join(',');
  const shi = []; if ($('fTp').checked) shi.push('TrustPass'); if ($('fSf').checked) shi.push('superFactory');
  if (shi.length) params.shiLiType = shi.join(',');

  mode = 'live'; curParams = params; curHistoryId = null;
  $('go').disabled = true; $('go').textContent = '搜索中…';
  $('banner').innerHTML = '';
  const t0 = Date.now();
  clearInterval(waitTimer);
  $('result').innerHTML = '<div id="msg" class="wait">正在搜索,已等待 <b>0</b> 秒…<br><span style="font-size:12px;color:#bbb">一般4~10秒出结果,最长等待45秒</span></div>';
  waitTimer = setInterval(() => { const b = $('result').querySelector('b'); if (b) b.textContent = Math.round((Date.now() - t0) / 1000); }, 500);

  const ctrl = new AbortController();
  const killer = setTimeout(() => ctrl.abort(), 50000);
  try {
    const r = await fetch('/api/search', { method: 'POST', headers: {'Content-Type': 'application/json'},
                                           body: JSON.stringify(params), signal: ctrl.signal });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
    clearTimeout(killer);
    fullList = d.products || [];
    curParams = params;
    mutedCats = new Set();
    buildCatBar();
    curHistoryId = d.historyId;
    history.replaceState(null, '', '#h=' + d.historyId);
    const shown = applyLocalOps();
    $('stat').textContent = '搜索耗时 ' + ((d.elapsedMs || Date.now() - t0) / 1000).toFixed(1) + ' 秒 · 抓取' + fullList.length +
      '条,本地筛选后显示' + shown.length + '条 · 之后改排序/筛选都不再消耗credits';
    loadHistoryList(d.historyId);
  } catch (e) {
    clearTimeout(killer);
    const reason = e.name === 'AbortError' ? '等待超过50秒已中止:上游服务繁忙或网络异常,请稍后重试' : e.message;
    $('result').innerHTML = '<div id="msg" class="err">❌ 搜索失败: ' + esc(reason) + '<br>' +
      '<span style="font-size:12px;color:#999">失败一般不扣或少量扣credits;稍等片刻再点一次「搜索」即可</span></div>';
    $('stat').textContent = ''; $('ptext').textContent = '';
    $('prev').disabled = true; $('next').disabled = true;
  } finally {
    clearInterval(waitTimer);
    $('go').disabled = false; $('go').textContent = '搜 索';
  }
}

/* ---- 历史(本地缓存,免费) ---- */
async function loadHistoryList(activeId) {
  try {
    const r = await fetch('/api/history');
    const list = await r.json();
    $('hlist').innerHTML = list.length ? list.map((h) =>
      '<div class="hitem' + (h.id === activeId ? ' active' : '') + '" data-id="' + h.id + '" title="' + esc(h.keyword) + '">' +
        '<div style="min-width:0"><div class="k">' + esc(h.keyword) + '</div>' +
        '<div class="t">' + fmtTime(h.time) + ' · <span class="n">' + h.count + '个</span></div></div>' +
        '<button class="hdel" data-id="' + h.id + '" title="删除">×</button></div>').join('')
      : '<div class="hempty">暂无记录</div>';
  } catch (_) {}
}

async function viewHistory(id) {
  clearInterval(waitTimer);
  $('go').disabled = false; $('go').textContent = '搜 索';
  try {
    const r = await fetch('/api/history?id=' + id);
    if (!r.ok) throw new Error('记录不存在(可能已被删除)');
    const h = await r.json();
    mode = 'history'; page = h.params.pageIndex || 1;
    $('kw').value = h.params.keyWord;
    $('match').value = h.params.searchType;
    $('sort').value = h.params.sortField ? h.params.sortField + ':' + (h.params.sortType || 'desc') : '';
    $('pmin').value = h.params.beginPrice || '';
    $('pmax').value = h.params.endPrice || '';
    $('size').value = h.params.pageSize;
    curHistoryId = id; curParams = h.params; fullList = h.products;
    mutedCats = new Set();
    buildCatBar();
    history.replaceState(null, '', '#h=' + id);
    applyLocalOps();
    $('stat').textContent = '历史缓存 · 搜索于 ' + fmtTime(h.time) + ' · 共' + h.products.length + '条 · 改排序/筛选均免费';
    $('banner').innerHTML = '<div class="bann"><span>🕘 正在查看本地缓存的历史结果(免费) · 想要最新数据请重新搜索</span>' +
      '<button id="research">按此条件重新搜索</button></div>';
    $('research').onclick = () => { page = 1; search(Object.assign({}, h.params, { pageIndex: 1 })); };
    document.querySelectorAll('.hitem').forEach((el) => el.classList.toggle('active', el.dataset.id === id));
  } catch (e) { showMsg('读取历史失败: ' + e.message, true); }
}

function showMsg(text, isErr) {
  $('result').innerHTML = '<div id="msg"' + (isErr ? ' class="err"' : '') + '>' + esc(text) + '</div>';
  $('stat').textContent = ''; $('ptext').textContent = '';
  $('prev').disabled = true; $('next').disabled = true;
}

/* ---- 事件 ---- */
$('go').onclick = () => { page = 1; search(); };
$('kw').addEventListener('keydown', (e) => { if (e.key === 'Enter') { page = 1; search(); } });
/* 本地操作: 改排序/价格/关键词过滤都只作用于已抓取数据,零credits */
$('sort').addEventListener('change', () => { if (fullList.length) applyLocalOps(); });
$('pmin').addEventListener('input', () => { if (fullList.length) applyLocalOps(); });
$('pmax').addEventListener('input', () => { if (fullList.length) applyLocalOps(); });
$('relfilter').addEventListener('change', () => { if (fullList.length) applyLocalOps(); });
$('prev').title = '请求上一页数据(消耗约12credits)';
$('next').title = '请求下一页数据(消耗约12credits)';
$('prev').onclick = () => {
  if (page <= 1) return;
  page--;
  if (mode === 'history' && curParams) search(Object.assign({}, curParams, { pageIndex: page }));
  else search();
};
$('next').onclick = () => {
  page++;
  if (mode === 'history' && curParams) search(Object.assign({}, curParams, { pageIndex: page }));
  else search();
};
$('hlist').addEventListener('click', (e) => {
  const del = e.target.closest('.hdel');
  if (del) { e.stopPropagation(); fetch('/api/history?id=' + del.dataset.id, { method: 'DELETE' }).then(() => loadHistoryList()); return; }
  const item = e.target.closest('.hitem');
  if (item) viewHistory(item.dataset.id);
});

/* ---- AI深度测评 ---- */
function mdToHtml(md) {
  return esc(md).split(/\r?\n/).map((line) => {
    if (/^#{1,6}\s/.test(line)) return '<h3>' + line.replace(/^#{1,6}\s/, '') + '</h3>';
    if (line.startsWith('【')) return '<h3>' + line + '</h3>';
    let t = line.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener" style="color:#1a4b8f">$1</a>');
    if (t.startsWith('- ')) t = '• ' + t.slice(2);
    return t;
  }).join('<br>').replace(/<\/h3><br>/g, '</h3>');
}
function openDrawer(title) { $('dtitle').textContent = title; $('drawer').classList.add('open'); $('mask').style.display = 'block'; }
function closeDrawer() { $('drawer').classList.remove('open'); $('mask').style.display = 'none'; }

async function openAnalyze(p, force) {
  openDrawer('🤖 AI 测评: ' + (p.title || '').slice(0, 40));
  $('dbody').innerHTML = '<div class="dloading">正在准备分析…<div style="margin-top:10px;font-size:12.5px;line-height:2">' +
    '① 获取商品详情数据(2credits)<br>② 多维评分计算<br>③ 调用 GLM 生成测评<br>' +
    '<b id="dt">0</b> 秒</div></div>';
  const t0 = Date.now();
  const tm = setInterval(() => { const b = document.getElementById('dt'); if (b) b.textContent = Math.round((Date.now() - t0) / 1000); }, 500);
  const ctrl = new AbortController();
  const killer = setTimeout(() => ctrl.abort(), 140000);
  try {
    const r = await fetch('/api/analyze', { method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ product: p, enrich: true, force: !!force }), signal: ctrl.signal });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
    renderReport(d, p);
  } catch (e) {
    const msg = e.name === 'AbortError' ? '等待超过140秒已中止,请稍后重试' : e.message;
    $('dbody').innerHTML = '<div class="derr">❌ 分析失败: ' + esc(msg) + '</div>';
  } finally { clearInterval(tm); clearTimeout(killer); }
}

function renderReport(d, p) {
  const s = d.scores || {};
  const sup = d.supplier || {};
  const enr = d.enrich || {};
  const sdi = enr.sdi || {};
  const pct1 = (v) => (v == null ? null : (Number(v) * 100).toFixed(1) + '%');
  let h = '';
  if (d.cached) h += '<div class="dnote" style="border:0;padding:0;margin:0 0 10px">📋 已缓存结果(分析于 ' + fmtTime(d.time) + '),免费回看。' +
    '<button class="ai" id="regen" style="margin-left:8px;padding:3px 10px;font-size:12px">🔄 按新文风重新生成(2cr)</button></div>';
  h += '<div class="score-row"><span class="score-big">' + (s.total ?? '—') + '</span><span class="score-max">/100</span>' +
       '<span class="verdict">' + esc(s.verdict || '') + '</span></div>';
  (s.dims || []).forEach((dim) => {
    h += '<div class="dimbar"><div class="dt"><span>' + esc(dim.name) + '</span><span><b>' + dim.score + '</b>/' + dim.max + '</span></div>' +
         '<div class="track"><div class="fill" style="width:' + Math.round(dim.score / dim.max * 100) + '%"></div></div>' +
         '<div class="dn">' + esc(dim.note || '') + '</div></div>';
  });
  const chips = [];
  if (enr.skuCount) chips.push(enr.skuCount + '个SKU');
  if (enr.totalStock != null) chips.push('总可售 ' + enr.totalStock);
  if (enr.onePieceFreePostage) chips.push('一件代发包邮');
  if (enr.hasInvoice) chips.push('可开发票');
  if (enr.certificatesCount) chips.push('资质证书' + enr.certificatesCount + '项');
  if (sdi.collect30DayWithin48HPercent != null) chips.push('48h发货率 ' + pct1(sdi.collect30DayWithin48HPercent));
  if (sdi.qualityRefundWithin30Day != null) chips.push('质量退款率 ' + pct1(sdi.qualityRefundWithin30Day));
  if (sdi.repeatPurchasePercent != null) chips.push('回购率 ' + pct1(sdi.repeatPurchasePercent));
  const ml = sdi.tradeMedalLevel ?? enr.tradeMedalLevel;
  if (ml) chips.push('交易勋章' + ml + '级');
  if (sup.sellerIdentities) String(sup.sellerIdentities).split(/[,，]/).forEach((t) => { if (t.trim()) chips.push(t.trim()); });
  if (sup.isJxhy) chips.push('精选货源');
  if (sup.isPatentProduct) chips.push('专利产品');
  if (sup.sendGoodsAddressText) chips.push('📍' + sup.sendGoodsAddressText);
  if (chips.length) h += '<div class="chips">' + chips.map((c) => '<span class="chip">' + esc(c) + '</span>').join('') + '</div>';
  h += '<div class="rpt">';
  if (d.aiReport) h += mdToHtml(d.aiReport);
  else if (!d.aiAvailable) h += '<div class="dnote">⚠️ 尚未配置AI:在 .env 中设置 AI_API_KEY(智谱 glm-4-flash 免费)并重启服务,即可生成AI深度点评。以上为规则评分结果。</div>';
  else h += '<div class="derr">AI报告生成失败: ' + esc(d.enrichNote || '未知原因') + '</div>';
  h += '</div>';
  h += '<div class="dnote">ℹ️ 1688平台不开放买家评价数据,本报告不含评价分析;销量为平台口径估算。商品: <a href="' +
       esc(p.asinUrl || '#') + '" target="_blank" rel="noopener">查看原页</a> · 店铺: <a href="' +
       esc(p.shopUrl || '#') + '" target="_blank" rel="noopener">进入店铺</a></div>';
  $('dbody').innerHTML = h;
  const regen = document.getElementById('regen');
  if (regen) regen.onclick = () => { page = 1; openAnalyze(p, true); };
}

$('result').addEventListener('click', (e) => {
  const ai = e.target.closest('button.ai');
  if (ai && curList[+ai.dataset.idx]) { openAnalyze(curList[+ai.dataset.idx]); return; }
  const sk = e.target.closest('button.sku');
  if (sk && curList[+sk.dataset.idx]) openSku(curList[+sk.dataset.idx]);
});

/* ---- SKU明细(2credits,10分钟缓存) ---- */
async function openSku(p) {
  openDrawer('📋 SKU明细: ' + (p.title || '').slice(0, 40));
  $('dbody').innerHTML = '<div class="dloading">正在获取SKU数据(2 credits)…</div>';
  try {
    const r = await fetch('/api/sku?offerId=' + encodeURIComponent(p.offerId));
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
    renderSku(d, p);
  } catch (e) {
    $('dbody').innerHTML = '<div class="derr">❌ 获取失败: ' + esc(e.message) + '</div>';
  }
}
function renderSku(d, p) {
  const pct1 = (v) => (v == null || v === '' ? '—' : (Number(v) * 100).toFixed(1) + '%');
  let h = '';
  if (d.cached) h += '<div class="dnote" style="border:0;padding:0;margin:0 0 8px">📋 10分钟内缓存结果,本次免费</div>';
  const pr = (d.priceRanges || []).map((r) => '≥' + r.startQuantity + '件 ¥' + r.price).join(' , ') || '—';
  h += '<div class="kv">' +
    '<span class="k">公司</span><span>' + esc(d.companyName || '—') + '</span>' +
    '<span class="k">价格阶梯</span><span class="price">' + esc(pr) + '</span>' +
    '<span class="k">起订量</span><span>' + (d.minOrderQuantity ?? '—') + ' ' + esc(d.unit || '件') + '</span>' +
    '<span class="k">总可售</span><span>' + (d.totalStock ?? '—') + ' ' + esc(d.unit || '件') + '</span>' +
    '<span class="k">一件代发</span><span>' + (d.onePieceFreePostage ? '✅ 支持且包邮' : '不支持/不包邮') + '</span>' +
    '<span class="k">发票 / 证书</span><span>' + (d.hasInvoice ? '可开发票' : '无发票信息') + ' / ' + (d.certificatesCount || 0) + '项资质证书</span>' +
    '</div>';
  if (!(d.skus || []).length) { h += '<div class="derr">无SKU数据</div>'; }
  else {
    h += '<table class="skutab"><thead><tr><th>#</th><th>规格</th><th>批发价</th><th>代发价</th><th>一件代发</th><th>可售库存</th></tr></thead><tbody>';
    d.skus.forEach((s, i) => {
      h += '<tr><td>' + (i + 1) + '</td><td>' + esc(s.spec) + '</td><td class="price">¥' + esc(s.price ?? '—') + '</td>' +
        '<td>' + (s.consignPrice ? '¥' + esc(s.consignPrice) : '—') + '</td>' +
        '<td>' + (s.onePiece ? '¥' + esc(s.onePiece) : '—') + '</td>' +
        '<td>' + (s.stock ?? '—') + '</td></tr>';
    });
    h += '</tbody></table>';
    const total = d.skus.reduce((a, s) => a + (Number(s.stock) || 0), 0);
    h += '<div class="dnote">共 ' + d.skus.length + ' 个SKU,合计可售约 ' + total + ' 件 · 商品: <a href="' +
      esc(p.asinUrl || '#') + '" target="_blank" rel="noopener">查看原页</a> · 数据2 credits/次,10分钟内重复查看免费</div>';
  }
  $('dbody').innerHTML = h;
}
$('dclose').onclick = closeDrawer;
$('mask').onclick = closeDrawer;
$('colbar').addEventListener('change', (e) => {
  const k = e.target.dataset && e.target.dataset.k;
  if (!k) return;
  let vis = getVisCols();
  if (e.target.checked) { if (!vis.includes(k)) vis.push(k); }
  else vis = vis.filter((x) => x !== k);
  localStorage.setItem('cols1688', JSON.stringify(vis));
  if (curList.length) renderTable(curList); else renderColBar();
});
$('catbar').addEventListener('change', (e) => {
  const idx = e.target.dataset && e.target.dataset.i;
  if (idx === undefined || catList[+idx] === undefined) return;
  const c = catList[+idx];
  if (e.target.checked) mutedCats.delete(c); else mutedCats.add(c);
  if (fullList.length) applyLocalOps();
});

/* ---- 候选勾选 / 对比 / 导出CSV / 收藏备注 (采购工作流) ---- */
function updatePickBar() {
  $('pickN').textContent = picked.size;
  $('pickbar').classList.toggle('show', picked.size > 0);
}
$('result').addEventListener('change', (e) => {
  const pk = e.target.closest && e.target.closest('.picksel');
  if (!pk) return;
  const id = String(pk.dataset.id);
  const prod = curList.find((x) => String(x.offerId) === id);
  if (pk.checked && prod) picked.set(id, prod); else picked.delete(id);
  updatePickBar();
});
$('result').addEventListener('click', (e) => {
  const st = e.target.closest && e.target.closest('.star');
  if (!st) return;
  const id = String(st.dataset.id);
  if (starSet.has(id)) starSet.delete(id); else starSet.add(id);
  localStorage.setItem('star1688', JSON.stringify(Array.from(starSet)));
  if (curList.length) renderTable(curList);
});
$('pickCompare').onclick = () => {
  const arr = Array.from(picked.values()).slice(0, 4);
  if (arr.length < 2) { alert('至少勾选2个候选再对比'); return; }
  openDrawer('⚖️ 候选对比(' + arr.length + '个)');
  const rowsDef = [
    ['批发价', (p) => '<span class="price">' + fmtPrice(p.price) + '</span>'],
    ['代发价', (p) => '<span class="consign">' + fmtPrice(p.consignPrice) + '</span>'],
    ['价格区间', (p) => qp(p.quantityPrices)],
    ['起订量', (p) => (p.quantityBegin != null ? esc(String(p.quantityBegin)) + ' ' + esc(p.unit || '') : '—')],
    ['近30天订单', (p) => (p.salesOrderCount ?? '—')],
    ['近30天销量(件)', (p) => (p.salesQuantity ?? '—')],
    ['预估月销额', (p) => (p.estimatedSalesAmount == null ? '—' : '¥' + Number(p.estimatedSalesAmount).toLocaleString())],
    ['类目', (p) => esc(p.levelName || '—')],
    ['供应商', (p) => esc(p.company || '—')],
    ['发货时效', (p) => (p.deliveryTime ? esc(String(p.deliveryTime)) + '小时' : '—')],
    ['上架时间', (p) => esc((p.availableDate || '—').slice(0, 16))],
    ['商品链接', (p) => '<a href="' + esc(p.asinUrl || '#') + '" target="_blank" rel="noopener">1688页面</a>'],
  ];
  let h = '<table style="border-collapse:collapse;width:100%;font-size:13px">';
  h += '<tr><th style="text-align:left"></th>' + arr.map((p) => '<th style="max-width:150px">' + esc(String(p.title || '').slice(0, 14)) + '</th>').join('') + '</tr>';
  rowsDef.forEach((pair) => {
    h += '<tr><th style="text-align:left;white-space:nowrap;color:#79766B;font-size:12px">' + pair[0] + '</th>' +
      arr.map((p) => '<td>' + pair[1](p) + '</td>').join('') + '</tr>';
  });
  h += '</table><div class="dnote">最多同时对比4个 · 提示: 先对候选点"AI测评"补充履约硬指标后对比更全面 · 若需发领导审批,用表格下方的"导出CSV"</div>';
  $('dbody').innerHTML = h;
};
$('pickCsv').onclick = () => {
  const rows = picked.size ? Array.from(picked.values()) : curList;
  if (!rows.length) { alert('没有可导出的数据'); return; }
  const q = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const head = ['标题','商品ID','商品链接','批发价','代发价','价格区间','起订量','单位','近30天订单','销量(件)','预估月销额','类目','供应商','店铺链接','发货时效','上架时间','收藏','备注','导出时间'];
  const lines = [head.map(q).join(',')];
  rows.forEach((p) => {
    lines.push([q(p.title), q(p.offerId), q(p.asinUrl || ''), q(p.price), q(p.consignPrice),
      q(typeof p.quantityPrices === 'string' ? p.quantityPrices : ''), q(p.quantityBegin), q(p.unit),
      q(p.salesOrderCount), q(p.salesQuantity), q(p.estimatedSalesAmount), q(p.levelName), q(p.company), q(p.shopUrl),
      q(p.deliveryTime ? p.deliveryTime + '小时' : ''), q(p.availableDate),
      q(starSet.has(String(p.offerId)) ? '★' : ''), q(noteMap[String(p.offerId)] || ''),
      q(new Date().toLocaleString('zh-CN'))].join(','));
  });
  lines.push(q('说明: 销量/销售额为平台口径估算值,非精确交易数据;导出时间: ' + new Date().toLocaleString('zh-CN')));
  const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = '1688采购比价表_' + new Date().toISOString().slice(0, 10) + '.csv';
  a.click();
};
$('pickClear').onclick = () => { picked.clear(); updatePickBar(); if (curList.length) renderTable(curList); };
updatePickBar();

/* ---- 页内AI助手对话(3001 LangGraph大脑; 流式输出/对话历史/内嵌表格/可拖宽) ---- */
var cpSid = 'webtool', cpBusy = false, cpLastRows = [];
/* 轻量Markdown渲染(加粗/标题/列表/代码),先esc防注入 */
function cpMD(t) {
  var s = esc(String(t || ''));
  var lines = s.split('\n'), out = [], inUl = false, inOl = false;
  function closeLists() { if (inUl) { out.push('</ul>'); inUl = false; } if (inOl) { out.push('</ol>'); inOl = false; } }
  function inline(x) {
    return String(x)
      .replace(/\*\*([^*]+)\*\*/g, '<b style="color:#3d2e22">$1</b>')
      .replace(new RegExp('\u0060([^\u0060]+)\u0060', 'g'), '<code style="background:#f1eee4;border-radius:4px;padding:0 4px;font-size:12px">$1</code>');
  }
  function splitRow(l) { return l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(function(x){ return x.trim(); }); }
  var i = 0;
  while (i < lines.length) {
    var ln = lines[i];
    // Markdown表格: 本行为|...|且下一行是|---|分隔行 → 渲染成真表格
    if (/^\s*\|.+\|\s*$/.test(ln) && i + 1 < lines.length && /^\s*\|[\s:|-]*\|\s*$/.test(lines[i + 1])) {
      closeLists();
      var hdr = splitRow(ln); i += 2;
      var body = [];
      while (i < lines.length && /^\s*\|.+\|\s*$/.test(lines[i])) { body.push(splitRow(lines[i])); i++; }
      var th = '<div style="overflow-x:auto;margin:6px 0"><table><thead><tr>' +
        hdr.map(function(c){ return '<th>' + inline(c) + '</th>'; }).join('') + '</tr></thead><tbody>';
      body.forEach(function(r) {
        th += '<tr>' + hdr.map(function(_, ci){ return '<td>' + inline(r[ci] || '') + '</td>'; }).join('') + '</tr>';
      });
      out.push(th + '</tbody></table></div>');
      continue;
    }
    var hh = ln.match(/^\s*#{1,4}\s+(.*)/);
    if (hh) {
      closeLists();
      var big = hh[1].length <= 2;
      out.push('<div style="font-weight:700;font-size:' + (big ? '14px' : '13px') + ';color:#B0522F;margin:10px 0 5px;border-left:3px solid #C96442;padding-left:8px;line-height:1.5">' + inline(hh[2]) + '</div>');
      i++; continue;
    }
    if (/^\s*([-*_]\s*){3,}$/.test(ln)) { closeLists(); out.push('<hr style="border:0;border-top:1px solid #E7E3D7;margin:8px 0">'); i++; continue; }
    var uli = ln.match(/^\s*[-*]\s+(.*)/);
    if (uli) {
      if (inOl) { out.push('</ol>'); inOl = false; }
      if (!inUl) { out.push('<ul style="margin:4px 0 4px 18px;padding:0">'); inUl = true; }
      out.push('<li style="margin:3px 0">' + inline(uli[1]) + '</li>');
      i++; continue;
    }
    var oli = ln.match(/^\s*\d+[.、)]\s+(.*)/);
    if (oli) {
      if (inUl) { out.push('</ul>'); inUl = false; }
      if (!inOl) { out.push('<ol style="margin:4px 0 4px 20px;padding:0">'); inOl = true; }
      out.push('<li style="margin:3px 0">' + inline(oli[1]) + '</li>');
      i++; continue;
    }
    closeLists();
    if (ln.trim() === '') { out.push('<div style="height:6px"></div>'); i++; continue; }
    out.push('<div>' + inline(ln) + '</div>');
    i++;
  }
  closeLists();
  return out.join('');
}
function cpAdd(cls, html) {
  var d = document.createElement('div'); d.className = 'cp-msg ' + cls; d.innerHTML = html;
  var lg = document.getElementById('cpLog'); lg.appendChild(d); lg.scrollTop = lg.scrollHeight; return d;
}
function aiLoadRows(rows) {
  fullList = rows.slice();
  curParams = Object.assign({}, curParams || {}, { keyWord: null, sortField: null });
  mutedCats = new Set(); buildCatBar();
  $('sort').value = ''; $('pmin').value = ''; $('pmax').value = ''; $('staronly').checked = false;
  const shown = applyLocalOps();
  $('stat').textContent = '🤖 AI助手已加载 ' + fullList.length + ' 条结果到主表格 · 本地筛选后显示 ' + shown.length + ' 条 · 后续排序/筛选依然免费';
}
function cpTable(rows, msgId) {
  if (!rows || !rows.length) return '';
  var h = '<div style="margin:2px 0 6px"><button class="cp-confirm" data-load="1" data-mid="' + msgId + '">📊 加载这' + rows.length + '条到主表格(免费)</button></div>';
  h += '<table><thead><tr><th>#</th><th>商品</th><th>批发价</th><th>代发价</th><th>近30天订单</th><th>销量(件)</th><th>月销额</th><th>公司</th><th>产地</th><th>操作</th></tr></thead><tbody>';
  rows.slice(0, 20).forEach(function(r, i) {
    var t = String(r.title || '').slice(0, 42);
    h += '<tr><td>' + (i + 1) + '</td>' +
      '<td><a href="' + esc(r.url || '#') + '" target="_blank" rel="noopener">' + esc(t) + '</a></td>' +
      '<td>' + (r.price != null ? '¥' + r.price : '—') + '</td>' +
      '<td>' + (r.consignPrice != null ? '¥' + r.consignPrice : '—') + '</td>' +
      '<td>' + (r.orders != null ? Number(r.orders).toLocaleString() : '—') + '</td>' +
      '<td>' + (r.qty != null ? Number(r.qty).toLocaleString() : '—') + '</td>' +
      '<td>' + (r.amount != null ? '¥' + Number(r.amount).toLocaleString() : '—') + '</td>' +
      '<td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + esc(r.company || '') + '">' + esc(String(r.company || '—').slice(0, 18)) + '</td>' +
      '<td>' + esc(r.province || '—') + '</td>' +
      '<td style="white-space:nowrap"><button class="cp-op cp-ai" data-offer="' + esc(r.offerId || '') + '" data-i="' + i + '" data-mid="' + msgId + '" title="商品详情+AI采购测评(2cr,结果缓存免费复用)">🤖</button> ' +
      '<button class="cp-op cp-sku" data-offer="' + esc(r.offerId || '') + '" data-i="' + i + '" data-mid="' + msgId + '" title="SKU规格明细(2cr,10分钟内重复免费)">📋</button></td></tr>';
  });
  return h + '</tbody></table>';
}
function cpTable(rows) {
  if (!rows || !rows.length) return '';
  var h = '<table><thead><tr><th>#</th><th>商品</th><th>批发价</th><th>代发价</th><th>近30天订单</th><th>公司</th><th>产地</th></tr></thead><tbody>';
  rows.slice(0, 20).forEach(function(r, i) {
    var t = String(r.title || '').slice(0, 42);
    h += '<tr><td>' + (i + 1) + '</td>' +
      '<td><a href="' + esc(r.url || '#') + '" target="_blank" rel="noopener">' + esc(t) + '</a></td>' +
      '<td>' + (r.price != null ? '¥' + r.price : '—') + '</td>' +
      '<td>' + (r.consignPrice != null ? '¥' + r.consignPrice : '—') + '</td>' +
      '<td>' + (r.orders != null ? Number(r.orders).toLocaleString() : '—') + '</td>' +
      '<td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(String(r.company || '—').slice(0, 20)) + '</td>' +
      '<td>' + esc(r.province || '—') + '</td></tr>';
  });
  return h + '</tbody></table>';
}
var cpMsgSeq = 0, cpMsgRows = {};
function cpFinish(msg, d) {
  msg.innerHTML = cpMD(msg.textContent);
  var mid = 'm' + (++cpMsgSeq);
  cpMsgRows[mid] = d.rows || [];
  if (d.rows && d.rows.length) cpAdd('bot tblwrap', cpTable(d.rows, mid));
  if (d.needsConfirm) {
    var b = document.createElement('button'); b.className = 'cp-confirm';
    b.textContent = '✅ 确认执行,约 ' + (d.estimate || 0) + ' credits';
    b.onclick = function() { b.disabled = true; cpSend(null, true); };
    var lg = document.getElementById('cpLog'); lg.appendChild(b); lg.scrollTop = lg.scrollHeight;
  }
  return msg;
}
/* 对话内表格按钮: 加载到主表格 / 行内测评 / 行内SKU */
document.getElementById('cpLog').addEventListener('click', function(e) {
  var load = e.target.closest && e.target.closest('button[data-load]');
  if (load) {
    var rows = cpMsgRows[load.dataset.mid] || [];
    if (rows.length) { aiLoadRows(rows); load.textContent = '✅ 已加载到主表格'; load.disabled = true; }
    return;
  }
  var ai = e.target.closest && e.target.closest('.cp-ai');
  if (ai) {
    var r1 = (cpMsgRows[ai.dataset.mid] || [])[+ai.dataset.i];
    if (r1) openAnalyze({ offerId: r1.offerId, title: r1.title, price: r1.price, consignPrice: r1.consignPrice, company: r1.company });
    return;
  }
  var sk = e.target.closest && e.target.closest('.cp-sku');
  if (sk) {
    var r2 = (cpMsgRows[sk.dataset.mid] || [])[+sk.dataset.i];
    if (r2) openSku({ offerId: r2.offerId, title: r2.title });
  }
});
function cpSend(text, confirm) {
  if (cpBusy) return;
  cpBusy = true;
  if (!confirm && text) cpAdd('user', esc(text));
  var w = cpAdd('sys', confirm ? '正在执行…' : 'AI思考中…');
  var bot = null, acc = '', thinkBox = null, thinkBody = null, thinkOpen = false, thinkBuf = '', traceLines = [];
  var ensureBot = function() { if (!bot) { w.remove(); bot = cpAdd('bot', ''); } return bot; };
  var lgScroll = function() { var lg = document.getElementById('cpLog'); lg.scrollTop = lg.scrollHeight; };
  var ensureThink = function() {
    if (!thinkBox) {
      thinkBox = document.createElement('div');
      thinkBox.className = 'cp-think';
      thinkBox.innerHTML = '<details open><summary>💭 思考中…<span class="cp-think-hint">(点击收起)</span></summary><div class="cp-think-body"></div></details>';
      var lg = document.getElementById('cpLog'); lg.appendChild(thinkBox);
      thinkBody = thinkBox.querySelector('.cp-think-body');
      thinkBody.innerHTML = '<span class="cp-waitdots">● ● ●</span>';
      thinkOpen = true;
    }
    return thinkBody;
  };
  // 思考token是逐字小块: 缓冲拼接成一段连续文字,不逐块加换行;工具调用单独成行
  var renderThink = function() {
    ensureThink();
    var txt = thinkBuf;
    if (traceLines.length) txt += (txt ? '\n' : '') + traceLines.join('\n');
    thinkBody.textContent = txt;
    thinkBody.scrollTop = thinkBody.scrollHeight;
    lgScroll();
  };
  var addThink = function(t) {
    if (w.parentNode) { w.remove(); }
    thinkBuf += t;
    renderThink();
  };
  var addTraceLine = function(t) {
    if (w.parentNode) { w.remove(); }
    traceLines.push('🔧 ' + t);
    renderThink();
  };
  ensureThink();
  fetch('/ai/stream', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify(confirm ? { sessionId: cpSid, resume: true } : { sessionId: cpSid, question: text }) })
  .then(function(r) {
    if (!r.ok || !r.body) return r.json().then(function(d) {
      w.remove();
      cpFinish(cpAdd('bot', '❌ ' + esc(d.error || ('HTTP ' + r.status))), d);
    });
    var reader = r.body.getReader(), dec = new TextDecoder(), buf = '', doneData = null;
    function pump() {
      return reader.read().then(function(res) {
        if (res.done) {
          w.remove();
          if (!bot && doneData) cpFinish(cpAdd('bot', esc(doneData.answer || '')), doneData);
          if (!bot && !doneData) cpAdd('bot', '(空回复)');
          return;
        }
        buf += dec.decode(res.value, { stream: true });
        var parts = buf.split('\n\n'); buf = parts.pop();
        parts.forEach(function(blk) {
          if (blk.slice(0, 6) !== 'data: ') return;
          var ev; try { ev = JSON.parse(blk.slice(6)); } catch (_) { return; }
          if (ev.type === 'think') { addThink(ev.text); }
          else if (ev.type === 'trace') { addTraceLine(ev.text); }
          else if (ev.type === 'delta') {
            // 开始输出正文 → 思考框自动收起,摘要变为"思考过程"(主流AI习惯)
            if (thinkOpen && thinkBox) {
              thinkBox.querySelector('details').open = false; thinkOpen = false;
              thinkBox.querySelector('summary').childNodes[0].textContent = '💭 思考过程 ';
            }
            ensureBot().innerHTML = cpMD(acc += ev.text);   // 边流式边渲染,不裸奔原始markdown
          }
          else if (ev.type === 'replace') { acc = ev.text; ensureBot().innerHTML = cpMD(acc); }
          else if (ev.type === 'error') { ensureBot().textContent = (acc ? acc + '\n' : '') + '❌ ' + ev.error; }
          else if (ev.type === 'done') {
            doneData = ev;
            if (thinkBox && thinkOpen) {
              thinkBox.querySelector('details').open = false; thinkOpen = false;
              thinkBox.querySelector('summary').childNodes[0].textContent = '💭 思考过程 ';
            }
            if (bot) cpFinish(bot, ev);
          }
        });
        var lg = document.getElementById('cpLog'); lg.scrollTop = lg.scrollHeight;
        return pump();
      });
    }
    return pump();
  })
  .catch(function(e){ w.remove(); cpAdd('bot', '❌ ' + esc(e.message)); })
  .finally(function(){ cpBusy = false; });
}
/* 对话会话历史: 左侧列表/切换/新建,当前会话记在localStorage */
function cpClearLog() {
  var lg = document.getElementById('cpLog');
  lg.innerHTML = '';
}
function cpRestore(sid) {
  fetch('/ai/history?sid=' + encodeURIComponent(sid)).then(function(r){ return r.json(); }).then(function(d) {
    (d.messages || []).forEach(function(m) {
      if (m.role === 'user') cpAdd('user', esc(m.text));
      else cpFinish(cpAdd('bot', esc(m.text || '')), m);
    });
    var lg = document.getElementById('cpLog');
    lg.appendChild(Object.assign(document.createElement('div'), { className: 'cp-sys', textContent: '— 已恢复会话"' + sid + '",共 ' + (d.messages || []).length + ' 条 —' }));
    lg.scrollTop = lg.scrollHeight;
  }).catch(function(){});
}
function fmtCpTime(t) {
  if (!t) return '';
  var d = new Date(t), now = new Date();
  var sameDay = d.toDateString() === now.toDateString();
  return sameDay ? ('今天 ' + d.toTimeString().slice(0, 5)) : ((d.getMonth() + 1) + '-' + d.getDate() + ' ' + d.toTimeString().slice(0, 5));
}
function loadCpSessions() {
  fetch('/ai/sessions').then(function(r){ return r.json(); }).then(function(d) {
    var list = d.sessions || [];
    $('cpSessList').innerHTML = list.length ? list.map(function(s) {
      return '<div class="cp-sess' + (s.sid === cpSid ? ' active' : '') + '" data-sid="' + esc(s.sid) + '">' +
        '<div class="t">' + esc(s.title) + '</div><div class="s">' + fmtCpTime(s.time) + ' · ' + s.count + '条</div></div>';
    }).join('') : '<div class="cp-sys">暂无其他对话</div>';
  }).catch(function(){ $('cpSessList').innerHTML = '<div class="cp-sys">加载失败</div>'; });
}
function switchCpSession(sid) {
  cpSid = sid;
  localStorage.setItem('cpSid1688', sid);
  cpClearLog();
  cpRestore(sid);
  loadCpSessions();
}
$('cpNew').onclick = function() {
  cpSid = 'c' + Date.now().toString(36);
  localStorage.setItem('cpSid1688', cpSid);
  cpClearLog();
  cpAdd('sys', '新对话已建立。数据仓是共享的,已有关键词的筛选依然免费。');
  loadCpSessions();
};
$('cpSessList').addEventListener('click', function(e) {
  var it = e.target.closest && e.target.closest('.cp-sess');
  if (it && it.dataset.sid !== cpSid) switchCpSession(it.dataset.sid);
});
/* 面板拖宽: 左缘拖动,记忆到localStorage */
(function() {
  var panel = document.getElementById('chatpanel'), h = document.getElementById('cpResize');
  var saved = parseInt(localStorage.getItem('cpw1688') || '', 10);
  if (saved >= 400 && saved <= window.innerWidth * 0.95) panel.style.width = saved + 'px';
  h.addEventListener('mousedown', function(e) {
    e.preventDefault();
    var startX = e.clientX, w0 = panel.getBoundingClientRect().width;
    function mv(ev) {
      var w = Math.min(Math.max(w0 + (startX - ev.clientX), 400), window.innerWidth * 0.95);
      panel.style.width = w + 'px';
    }
    function up() {
      document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up);
      localStorage.setItem('cpw1688', String(Math.round(panel.getBoundingClientRect().width)));
    }
    document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
  });
})();
/* 导出对话为Markdown */
$('cpExport').onclick = function() {
  var lines = ['# 1688 AI采购助手对话记录', '', '- 导出时间: ' + new Date().toLocaleString(), ''];
  document.querySelectorAll('#cpLog .cp-msg').forEach(function(m) {
    var isUser = m.classList.contains('user');
    if (m.classList.contains('tblwrap') || m.querySelector('table')) {
      var mid = m.querySelector('table button[data-mid]');
      var rows = mid ? (cpMsgRows[mid.dataset.mid] || []) : [];
      if (rows.length) {
        lines.push('| # | 商品 | 批发价 | 代发价 | 近30天订单 | 销量(件) | 月销额 | 公司 |');
        lines.push('|---|------|--------|--------|-----------|---------|--------|------|');
        rows.slice(0, 20).forEach(function(r, i) {
          lines.push('| ' + (i + 1) + ' | [' + String(r.title || '').slice(0, 40) + '](' + (r.url || '#') + ') | ' + (r.price != null ? '¥' + r.price : '—') + ' | ' + (r.consignPrice != null ? '¥' + r.consignPrice : '—') + ' | ' + (r.orders ?? '—') + ' | ' + (r.qty ?? '—') + ' | ' + (r.amount != null ? '¥' + Number(r.amount).toLocaleString() : '—') + ' | ' + (r.company || '—') + ' |');
        });
        lines.push('');
      }
      return;
    }
    var txt = m.textContent.trim();
    if (txt) lines.push(isUser ? '**我:** ' + txt : '**AI:** ' + txt, '');
  });
  lines.push('---', '*数据来源: 1688(Nexscope API)。销量为平台预估周/月数据,下单前请与供应商核实。*', '');
  var blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'AI采购对话_' + new Date().toISOString().slice(0, 10) + '.md';
  a.click(); URL.revokeObjectURL(a.href);
};
$('chatOpen').onclick = () => { $('chatpanel').classList.add('open'); $('cpInp').focus(); loadCpSessions(); };
$('cpClose').onclick = () => { $('chatpanel').classList.remove('open'); };
$('cpSend').onclick = () => { var i = $('cpInp'); var v = i.value.trim(); if (v) { i.value = ''; cpSend(v); } };
$('cpInp').addEventListener('keydown', (e) => { if (e.key === 'Enter') { var v = $('cpInp').value.trim(); if (v) { $('cpInp').value = ''; cpSend(v); } } });
cpSid = localStorage.getItem('cpSid1688') || 'webtool';
cpRestore(cpSid);

/* ---- 启动: 有#h=哈希则恢复上次查看的记录(刷新不丢) ---- */
renderColBar();
const m = location.hash.match(/h=([a-z0-9]+)/);
if (m) viewHistory(m[1]);
loadHistoryList(m && m[1]);
</script>
</body>
</html>`;

/* ---------------- AI分析引擎 ---------------- */
const ANALYSES_FILE = path.join(__dirname, '1688_analyses.json');
const ENV_MAP = (() => {
  try {
    const o = {};
    fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/).forEach((l) => {
      const m = l.match(/^([A-Z_]+)=(.*)$/);
      if (m) o[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    });
    return o;
  } catch (_) { return {}; }
})();
const AI_KEY = process.env.AI_API_KEY || ENV_MAP.AI_API_KEY || '';
const AI_BASE = (process.env.AI_BASE_URL || ENV_MAP.AI_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4').replace(/\/+$/, '');
const AI_MODEL = process.env.AI_MODEL || ENV_MAP.AI_MODEL || 'glm-4-flash';

function loadAnalyses() { try { return JSON.parse(fs.readFileSync(ANALYSES_FILE, 'utf8')); } catch (_) { return {}; } }
function saveAnalyses(o) { fs.writeFileSync(ANALYSES_FILE, JSON.stringify(o)); }

// OpenAI兼容接口(GLM/DeepSeek/Kimi等)
function callLLM(messages, maxTokens) {
  return new Promise((resolve, reject) => {
    if (!AI_KEY) return reject(new Error('未配置AI_API_KEY'));
    const payload = JSON.stringify({ model: AI_MODEL, messages, temperature: 0.4, max_tokens: maxTokens || 2000 });
    const u = new URL(AI_BASE + '/chat/completions');
    const r = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
      headers: { 'Authorization': `Bearer ${AI_KEY}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: 90000 }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (res.statusCode === 200 && j.choices && j.choices[0]) resolve(j.choices[0].message.content);
          else reject(new Error(`AI接口 HTTP ${res.statusCode}: ${(j.error && j.error.message) || data.slice(0, 200)}`));
        } catch (_) { reject(new Error('AI响应解析失败: ' + data.slice(0, 200))); }
      });
    });
    r.on('timeout', () => r.destroy(new Error('AI请求超时(90秒)')));
    r.on('error', reject);
    r.write(payload); r.end();
  });
}

// 以图搜图接口,补齐厂家深度字段(6 credits/次)
function callImageSearch(imageUrl) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ imageUrl, pageSize: 20 });
    const req = https.request({
      hostname: API_HOST, path: '/api/skill-api/v1/skills/1688-search-by-image/run', method: 'POST',
      headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: 45000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (_) {}
        if (res.statusCode === 200 && json && json.errcode === 200) resolve(json);
        else reject(new Error(`图搜 HTTP ${res.statusCode} errcode=${json && (json.errcode ?? json.code)}: ${(json && (json.msg || json.errmsg)) || data.slice(0, 200)}`));
      });
    });
    req.on('timeout', () => req.destroy(new Error('图搜超时(45秒)')));
    req.on('error', reject);
    req.write(payload); req.end();
  });
}

// 商品详情接口(2 credits/次): SKU价格/库存、厂家履约硬指标、证书、发票
function callProductDetail(offerId) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ offerId: String(offerId) });
    const req = https.request({
      hostname: API_HOST, path: '/api/skill-api/v1/skills/1688-product-detail/run', method: 'POST',
      headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: 45000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (_) {}
        if (res.statusCode === 200 && json && json.product) resolve(json);
        else reject(new Error(`商品详情 HTTP ${res.statusCode}: ${(json && (json.msg || json.errmsg)) || data.slice(0, 200)}`));
      });
    });
    req.on('timeout', () => req.destroy(new Error('商品详情超时(45秒)')));
    req.on('error', reject);
    req.write(payload); req.end();
  });
}

// 规则化四维打分(enr=商品详情接口增强数据, sup=旧图搜增强数据, 兼容历史缓存)
function computeScores(p, enr, sup) {
  const dims = [];
  const oc = Number(p.salesOrderCount) || 0;
  const s1 = oc >= 10000 ? 30 : oc >= 5000 ? 27 : oc >= 2000 ? 24 : oc >= 1000 ? 21 : oc >= 500 ? 18 : oc >= 200 ? 14 : oc >= 100 ? 10 : oc >= 50 ? 7 : 4;
  dims.push({ name: '销量表现', score: s1, max: 30, note: `近30天订单 ${oc} 单` + (p.salesQuantity ? ` / 销量 ${p.salesQuantity} 件` : '') + (p.estimatedSalesAmount ? ` / 预估月销售额 ¥${p.estimatedSalesAmount}` : '') });

  const cp = Number(p.consignPrice), pr = Number(p.price);
  let s2, note2;
  if (cp > 0 && pr > 0 && cp >= pr) {
    const r = (cp - pr) / cp;
    s2 = r >= 0.5 ? 25 : r >= 0.3 ? 22 : r >= 0.2 ? 18 : r >= 0.1 ? 14 : 10;
    note2 = `批发 ¥${pr} / 代发 ¥${cp} · 代发毛利空间 ${Math.round(r * 100)}%`;
  } else {
    s2 = pr > 0 && pr <= 10 ? 16 : 12;
    note2 = `批发 ¥${pr || '?'}` + (cp > 0 ? ` / 代发 ¥${cp}` : '(无代发价)');
  }
  dims.push({ name: '价格与代发空间', score: s2, max: 25, note: note2 });

  const sdi = (enr && enr.sdi) || {};
  let s3 = 4; const tags3 = [];
  const ml = Number((enr && enr.tradeMedalLevel) ?? sdi.tradeMedalLevel);
  if (ml >= 5) { s3 += 8; tags3.push('交易勋章5级'); }
  else if (ml >= 4) { s3 += 6; tags3.push('交易勋章4级'); }
  else if (ml >= 3) { s3 += 4; tags3.push('交易勋章3级'); }
  const csScore = Number(sdi.compositeServiceScore);
  if (csScore > 0) { s3 += Math.round(csScore / 5 * 8); tags3.push('综合服务' + csScore); }
  if (enr && enr.certificatesCount > 0) { s3 += 4; tags3.push('资质证书' + enr.certificatesCount + '项'); }
  if (enr && enr.hasInvoice) { s3 += 3; tags3.push('可开发票'); }
  if (sup && sup.sellerIdentities) tags3.push(String(sup.sellerIdentities));
  s3 = Math.round(Math.min(25, s3));
  dims.push({ name: '厂家资质', score: s3, max: 25, note: tags3.length ? '身份与资质: ' + tags3.join(' / ') : '未获取厂家深度数据' });

  const dl = String(p.deliveryTime || '');
  let s4 = dl === '24' ? 2 : dl === '48' ? 1 : 0;
  const parts4 = [`发货时效 ${dl ? dl + '小时' : '未知'}`];
  const c48 = Number(sdi.collect30DayWithin48HPercent);
  if (sdi.collect30DayWithin48HPercent != null && !isNaN(c48)) {
    s4 += c48 >= 0.95 ? 8 : c48 >= 0.8 ? 6 : c48 >= 0.6 ? 3 : 1;
    parts4.push(`48h内发货率 ${(c48 * 100).toFixed(1)}%`);
  }
  const qr = Number(sdi.qualityRefundWithin30Day);
  if (sdi.qualityRefundWithin30Day != null && !isNaN(qr)) {
    s4 += qr <= 0.005 ? 6 : qr <= 0.02 ? 4 : qr <= 0.05 ? 2 : 0;
    parts4.push(`30天质量退款率 ${(qr * 100).toFixed(2)}%`);
  }
  const rp = Number(sdi.repeatPurchasePercent);
  if (sdi.repeatPurchasePercent != null && !isNaN(rp)) {
    s4 += rp >= 0.3 ? 4 : rp >= 0.15 ? 3 : rp >= 0.05 ? 1 : 0;
    parts4.push(`回购率 ${(rp * 100).toFixed(0)}%`);
  }
  s4 = Math.min(20, s4);
  dims.push({ name: '履约与复购', score: s4, max: 20, note: parts4.join(' · ') });

  const total = dims.reduce((a, d) => a + d.score, 0);
  const verdict = total >= 80 ? '强烈推荐' : total >= 65 ? '值得洽谈' : total >= 50 ? '可观察对比' : '谨慎观察';
  return { dims, total, verdict };
}

function buildPrompt(p, enr, sup) {
  const sdi = (enr && enr.sdi) || {};
  const pct = (v) => (v == null ? null : (Number(v) * 100).toFixed(1) + '%');
  const data = {
    商品: { 标题: p.title, 类目: p.levelName, 批发价: p.price, 一件代发价: p.consignPrice, 价格区间: p.quantityPrices, 起订量: p.quantityBegin, 单位: p.unit, 近30天订单数: p.salesOrderCount, 销量件数: p.salesQuantity, 预估月销售额: p.estimatedSalesAmount, 上架时间: p.availableDate, 发货时效小时: p.deliveryTime, 商品链接: p.asinUrl },
    详情增强: enr ? {
      SKU数量: enr.skuCount, 总可售库存: enr.totalStock, 价格阶梯: enr.priceRanges, 起订量: enr.minOrderQuantity,
      一件代发包邮: enr.onePieceFreePostage, 可开发票: enr.hasInvoice, 资质证书数量: enr.certificatesCount,
      售罄状态: enr.soldOut, 商品状态: enr.status,
    } : '未获取',
    公司履约硬指标: (enr && sdi) ? {
      '48小时内发货率': pct(sdi.collect30DayWithin48HPercent), '30天质量退款率': pct(sdi.qualityRefundWithin30Day),
      回购率: pct(sdi.repeatPurchasePercent), 交易勋章等级: sdi.tradeMedalLevel ?? enr.tradeMedalLevel,
      综合服务评分: sdi.compositeServiceScore, 纠纷投诉评分: sdi.disputeComplaintScore, 物流体验评分: sdi.logisticsExperienceScore,
      售后体验评分: sdi.afterSalesExperienceScore, 咨询体验评分: sdi.consultingExperienceScore,
    } : { 旧版标签: sup && sup.sellerIdentities, 回购率: sup && sup.repurchaseRate },
    公司: { 名称: p.company, 店铺: p.shopUrl },
    数据说明: '1688平台不开放买家评价数据,本报告无法包含用户评价分析;销量为平台口径估算值。',
  };
  return {
    system: '你是一名有十年1688采购经验的资深采购经理,正在给采购部同事写一份内部选品评审意见。文风像人写的内部邮件,绝对不要AI清单体;只依据给定数据,绝不编造;数据缺失就别提那一项。全程简体中文。',
    user: '基于下面的JSON数据写一份商品与供应商的采购评审,硬性要求:\n' +
      '1. 全文纯文本:禁止#号、禁止**加粗、禁止"-"列表符\n' +
      '2. 分三节,节标题单独占一行,依次是:【商品测评】【公司测评】【采购结论】\n' +
      '3. 每节2到3个自然段,把关键数字自然地写进句子里(比如"近30天走了2210单,月销额大概2.4万"),禁止"字段名:数值"式的逐行罗列\n' +
      '4. 【采购结论】必须包含:综合评分X/100、一句话总评、值不值得谈、谈判时可以压价的点、主要风险\n' +
      '5. 语气像老采购带新人的内部沟通,直接、口语化一点,但判断要有数据支撑\n\n' +
      '数据JSON:\n' + JSON.stringify(data),
  };
}

// SKU明细: 内存缓存10分钟,重复点击不重复扣费
const skuCache = new Map();
async function handleSku(res, offerId) {
  if (!offerId || !/^\d+$/.test(String(offerId))) {
    return send(res, 400, 'application/json', JSON.stringify({ error: 'offerId 必须是数字ID' }));
  }
  const hit = skuCache.get(offerId);
  if (hit && Date.now() - hit.time < 10 * 60 * 1000) {
    log(`SKU明细命中缓存 offerId=${offerId}`);
    return send(res, 200, 'application/json', JSON.stringify(Object.assign({}, hit.data, { cached: true })));
  }
  log(`SKU明细: 调用商品详情 offerId=${offerId} (消耗2 credits)`);
  try {
    const d = await callProductDetail(offerId);
    const prod = d.product || {};
    const skus = (prod.skuList || []).map((s) => ({
      spec: (s.attributes || []).map((a) => a.value).join(' / ') || (s.skuId || '规格'),
      price: s.price,
      consignPrice: s.consignPrice,
      onePiece: s.fenxiaoPriceInfo && s.fenxiaoPriceInfo.onePiecePrice,
      stock: s.amountOnSale,
      image: s.skuImageUrl,
    }));
    const sale = prod.saleInfo || {};
    const data = {
      offerId, time: new Date().toISOString(),
      subject: prod.subject, companyName: prod.companyName, status: prod.status,
      priceRanges: sale.priceRanges || [],
      totalStock: sale.amountOnSale ?? null,
      minOrderQuantity: prod.minOrderQuantity,
      unit: (sale.unitInfo && sale.unitInfo.unit) || '件',
      onePieceFreePostage: !!(sale.fenxiaoSaleInfo && sale.fenxiaoSaleInfo.onePieceFreePostage),
      certificatesCount: (prod.certificates || []).length,
      hasInvoice: !!(prod.invoiceInfo && Object.keys(prod.invoiceInfo).length > 0),
      skus,
    };
    skuCache.set(offerId, { time: Date.now(), data });
    log(`SKU明细完成 "${String(prod.subject || '').slice(0, 20)}" ${skus.length}个SKU`);
    send(res, 200, 'application/json', JSON.stringify(Object.assign({}, data, { cached: false })));
  } catch (e) {
    log(`SKU明细失败 offerId=${offerId}: ${e.message}`);
    send(res, 502, 'application/json', JSON.stringify({ error: e.message }));
  }
}

async function handleAnalyze(req, res) {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', async () => {
    let body;
    try { body = JSON.parse(raw || '{}'); } catch (_) { return send(res, 400, 'application/json', JSON.stringify({ error: '请求体不是合法JSON' })); }
    const p = body.product;
    if (!p || !p.offerId) return send(res, 400, 'application/json', JSON.stringify({ error: '缺少商品数据(product.offerId)' }));

    const cache = loadAnalyses();
    if (cache[p.offerId] && !body.force) {
      log(`AI分析命中缓存 offerId=${p.offerId}`);
      return send(res, 200, 'application/json', JSON.stringify(Object.assign({ offerId: p.offerId }, cache[p.offerId], { cached: true, aiAvailable: !!AI_KEY })));
    }

    let enr = null, sup = null, enrichNote = '';
    if (body.enrich !== false) {
      try {
        log(`AI分析: 商品详情增强 offerId=${p.offerId} (消耗2 credits)`);
        const d = await callProductDetail(p.offerId);
        const prod = d.product || {};
        const skuList = prod.skuList || [];
        enr = {
          source: 'product-detail',
          companyName: prod.companyName,
          status: prod.status, soldOut: prod.soldOut,
          minOrderQuantity: prod.minOrderQuantity,
          skuCount: skuList.length,
          totalStock: (prod.saleInfo && prod.saleInfo.amountOnSale) ?? null,
          priceRanges: (prod.saleInfo && prod.saleInfo.priceRanges) || [],
          onePieceFreePostage: !!(prod.saleInfo && prod.saleInfo.fenxiaoSaleInfo && prod.saleInfo.fenxiaoSaleInfo.onePieceFreePostage),
          hasInvoice: !!(prod.invoiceInfo && Object.keys(prod.invoiceInfo).length > 0),
          certificatesCount: (prod.certificates || []).length,
          tradeMedalLevel: (prod.sellerDataInfo && prod.sellerDataInfo.tradeMedalLevel) ?? null,
          sdi: prod.sellerDataInfo || {},
        };
        enrichNote = '已通过商品详情接口获取厂家履约硬指标(2 credits)';
      } catch (e) { enrichNote = '详情增强失败: ' + e.message; }
    }

    const scores = computeScores(p, enr, sup);
    let aiReport = null;
    if (AI_KEY) {
      try {
        const pr = buildPrompt(p, enr, sup);
        log(`AI分析: 调用 ${AI_MODEL} 生成报告 offerId=${p.offerId}`);
        aiReport = await callLLM([{ role: 'system', content: pr.system }, { role: 'user', content: pr.user }], 2000);
      } catch (e) { enrichNote += ' | AI生成失败: ' + e.message; }
    }

    const record = { time: new Date().toISOString(), productTitle: p.title, scores, enrich: enr, supplier: sup, aiReport, enrichNote };
    cache[p.offerId] = record;
    saveAnalyses(cache);
    log(`AI分析完成 "${String(p.title || '').slice(0, 25)}" 总分${scores.total} AI报告=${aiReport ? 'OK' : '无'}`);
    send(res, 200, 'application/json', JSON.stringify(Object.assign({ offerId: p.offerId }, record, { cached: false, aiAvailable: !!AI_KEY })));
  });
}

/* ---------------- HTTP服务 ---------------- */
function send(res, code, type, body) {
  res.writeHead(code, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  log(`${req.method} ${u.pathname}${u.search} ← ${req.socket.remoteAddress}`);
  if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index')) {
    return send(res, 200, 'text/html', HTML);
  }

  if (req.method === 'POST' && u.pathname === '/api/search') {
    if (!API_KEY) return send(res, 500, 'application/json', JSON.stringify({ error: '未配置 API Key。请设置 NEXSCOPE_API_KEY 或在 server_1688.js 同目录创建 .env 文件。' }));
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      let params;
      try { params = JSON.parse(raw || '{}'); } catch (_) { return send(res, 400, 'application/json', JSON.stringify({ error: '请求体不是合法JSON' })); }
      if (!params.keyWord) return send(res, 400, 'application/json', JSON.stringify({ error: '缺少 keyWord 参数' }));
      const t0 = Date.now();
      log(`搜索开始 "${params.keyWord}" 页码=${params.pageIndex} 每页=${params.pageSize}${params.sortField ? ' 排序=' + params.sortField + ':' + params.sortType : ''}`);
      try {
        const data = await callApi(params);
        const elapsed = Date.now() - t0;
        const products = data.products || [];
        const rec = upsertHistory(params, products, elapsed);
        log(`搜索成功 "${params.keyWord}" → ${products.length}条, ${elapsed}ms, 历史id=${rec.id}`);
        send(res, 200, 'application/json', JSON.stringify(Object.assign({}, data, { historyId: rec.id, elapsedMs: elapsed })));
      } catch (e) {
        log(`搜索失败 "${params.keyWord}" → ${e.message} (耗时${Date.now() - t0}ms)`);
        send(res, 502, 'application/json', JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.method === 'GET' && u.pathname === '/api/history') {
    const id = u.searchParams.get('id');
    const list = loadHistory();
    if (id) {
      const rec = list.find((r) => r.id === id);
      if (!rec) return send(res, 404, 'application/json', JSON.stringify({ error: '记录不存在' }));
      return send(res, 200, 'application/json', JSON.stringify(rec));
    }
    const brief = list.map((r) => ({ id: r.id, time: r.time, keyword: r.params.keyWord, count: r.products.length }));
    return send(res, 200, 'application/json', JSON.stringify(brief));
  }

  if (req.method === 'DELETE' && u.pathname === '/api/history') {
    const id = u.searchParams.get('id');
    saveHistory(loadHistory().filter((r) => r.id !== id));
    log(`删除历史 id=${id}`);
    return send(res, 200, 'application/json', JSON.stringify({ ok: true }));
  }

  if (req.method === 'POST' && u.pathname === '/api/analyze') return handleAnalyze(req, res);
  if (req.method === 'GET' && u.pathname === '/api/sku') return handleSku(res, u.searchParams.get('offerId'));

  // AI助手对话代理: 转发给3001的LangGraph服务(同机回环,无跨域问题)
  if (req.method === 'POST' && u.pathname === '/ai/ask') {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const fwd = http.request({ hostname: '127.0.0.1', port: 3001, path: '/ask', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) } }, (up) => {
        let data = '';
        up.on('data', (c) => (data += c));
        up.on('end', () => {
          res.writeHead(up.statusCode || 502, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(data);
        });
      });
      fwd.on('error', () => {
        res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'AI服务(3001端口)未启动。请在 ai-agent 目录运行: node agent.mjs' }));
      });
      fwd.write(raw); fwd.end();
    });
    return;
  }

  // AI助手流式对话代理: 原样透传3001的SSE字节流
  if (req.method === 'POST' && u.pathname === '/ai/stream') {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const fwd = http.request({ hostname: '127.0.0.1', port: 3001, path: '/ask/stream', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) } }, (up) => {
        res.writeHead(up.statusCode || 502, { 'Content-Type': up.headers['content-type'] || 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store' });
        up.pipe(res);
      });
      fwd.on('error', () => {
        res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'AI服务(3001端口)未启动。请在 ai-agent 目录运行: node agent.mjs' }));
      });
      fwd.write(raw); fwd.end();
    });
    return;
  }
  // AI对话历史代理
  if (req.method === 'GET' && u.pathname === '/ai/history') {
    const sid = u.searchParams.get('sid') || 'default';
    const fwd = http.request({ hostname: '127.0.0.1', port: 3001, path: '/chat/history?sid=' + encodeURIComponent(sid), method: 'GET' }, (up) => {
      let data = '';
      up.on('data', (c) => (data += c));
      up.on('end', () => {
        res.writeHead(up.statusCode || 502, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(data);
      });
    });
    fwd.on('error', () => {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'AI服务(3001端口)未启动' }));
    });
    fwd.end();
    return;
  }
  // AI对话会话列表代理
  if (req.method === 'GET' && u.pathname === '/ai/sessions') {
    const fwd = http.request({ hostname: '127.0.0.1', port: 3001, path: '/chat/sessions', method: 'GET' }, (up) => {
      let data = '';
      up.on('data', (c) => (data += c));
      up.on('end', () => {
        res.writeHead(up.statusCode || 502, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(data);
      });
    });
    fwd.on('error', () => {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'AI服务(3001端口)未启动' }));
    });
    fwd.end();
    return;
  }

  send(res, 404, 'text/plain', 'Not Found');
});

function listen(port) {
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE' && port < 3010) { log(`端口 ${port} 被占用,改用 ${port + 1}`); listen(port + 1); }
    else { console.error('启动失败:', e.message); process.exit(1); }
  });
  server.listen(port, () => {
    log(`✅ 服务已启动: http://localhost:${port}  (API Key ${API_KEY ? '已加载' : '⚠️ 未找到,搜索会报错'})`);
  });
}
listen(3000);

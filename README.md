# 1688 商品搜索 + AI 采购助手

基于 Nexscope 1688 API 的商品搜索工具，内置 LangGraph.js 驱动的 AI 采购助手（GLM）。

## 功能

**网页工具（localhost:3000）**
- 1688 商品搜索，全部字段一次性展示，16 列可勾选显隐，排序列高亮
- 搜索历史持久化：同搜索条件自动去重合并，点击免费回看，翻页商品按 offerId 累积
- 类目筛选 / 本地排序筛选 / 收藏备注 / 候选对比 / CSV 导出——全部本地操作零 credits
- SKU 明细（2cr，10 分钟缓存）、AI 商品+公司测评（2cr，结果缓存）

**AI 采购助手（LangGraph.js, localhost:3001）**
- 自然语言搜索筛选："只看广东产的，价格低于 20，按销量排"
- 对话记忆 + 指代消解（"他们有什么优劣势" 能接住上下文）
- ReAct 模式（官方 createReactAgent）：lookData / filterData 工具，本地操作零 credits
- 思考过程可折叠展示（GLM-4.5 thinking）
- 付费操作（新搜索 12cr / 详情精查）走 LangGraph 官方 interrupt 人工确认闸门
- 技能系统：`ai-agent/skills/*.md` 放文件即扩展（内置询价单生成、验厂清单、砍价话术）
- 对话历史多会话管理、导出 Markdown、面板可拖宽

## 快速开始

```bash
# 1. 配置密钥
cp .env.example .env   # 填入 Nexscope API Key 和智谱 API Key

# 2. 启动网页工具
node server_1688.js    # → http://localhost:3000

# 3. 启动 AI 助手
cd ai-agent
npm install
node agent.mjs         # → http://localhost:3001
```

## 消耗说明

| 操作 | Credits |
|------|---------|
| 商品搜索 | 12 |
| SKU / 商品详情 | 2 |
| AI 测评生成、本地筛选排序、AI 对话 | 免费 |

历史数据仓（1688_history.json）在网页与 AI 助手之间共享，已有数据复用不扣费；花 credits 前均会先报价确认。

## 技术栈

Node.js 原生 http（无 Web 框架）· LangGraph.js（StateGraph / interrupt / createReactAgent）· 智谱 GLM-4.5-flash · Nexscope 1688 REST API

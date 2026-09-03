---
name: 1688采购搜索
description: 当用户想要搜索1688商品、找货源、比价、对比商品、查询采购数据(如"帮我搜一下保温杯""蓝牙耳机哪个卖得好""对比第1和第3个")时使用此技能。通过调用1688采购分析服务器的MCP接口完成真实搜索(走Nexscope数据源)。
---

# 1688采购搜索技能

当用户提到搜索1688商品、找货源、比价、选品、对比商品时,使用本技能。

服务器地址(MCP接口,JSON-RPC 2.0):
```
https://1688-mcp.henryhuo.workers.dev/mcp
```

## 如何调用

用 curl 发 POST,Content-Type为application/json。

### 1. 搜索商品 search_1688

```bash
curl -s -X POST 'https://1688-mcp.henryhuo.workers.dev/mcp' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_1688","arguments":{"keyword":"保温杯","pageSize":30,"sortField":"orderCount30d","sortType":"desc"}}}'
```

参数说明:
- keyword(必填): 商品关键词
- priceMin/priceMax: 批发价区间
- sortField: orderCount30d(近30天订单)/saleCount30d(销量)/saleVolume30d(月销额)/price(批发价)
- sortType: asc/desc
- pageSize: 抓取条数,默认50,最大100
- withAI: 设false可跳过AI总结,更快返回

### 2. 数据仓问答 ask_dataset(零成本,用于追问)

```bash
curl -s -X POST 'https://1688-mcp.henryhuo.workers.dev/mcp' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ask_dataset","arguments":{"keyword":"保温杯","question":"价格低于20元的有哪几个"}}}'
```

### 3. 对比商品 compare_products

```bash
curl -s -X POST 'https://1688-mcp.henryhuo.workers.dev/mcp' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"compare_products","arguments":{"keyword":"保温杯","indexes":[1,3]}}}'
```

### 4. 查看已有数据 datastore_overview

```bash
curl -s -X POST 'https://1688-mcp.henryhuo.workers.dev/mcp' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"datastore_overview","arguments":{}}}'
```

## 返回结果格式

返回JSON-RPC,商品数据在 result.content[0].text 里:前几行是数据来源和过滤说明,后面是JSON数组,每条商品含:序号/标题/批发价/代发价/起订量/近30天订单/销量件数/月销额/类目/公司/链接/疑似噪音。

## 回答要求

1. 用Markdown表格展示商品(列: 序号/标题/批发价/近30天订单/月销额/公司),附上链接
2. 引用真实数字,不编造
3. "疑似噪音"为true的商品(价格低得反常)绝不推荐
4. 如果返回里出现"数据来源: 数据仓命中"说明是复用数据,实时搜索消耗credits(约12点/次),同一关键词优先用ask_dataset追问,不要重复search
5. 用户追问"第几个什么材质/多少钱"时,用compare_products或ask_dataset,不要重新search

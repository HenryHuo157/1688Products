#!/usr/bin/env bash
# Nexscope 1688 Product Search API 连接验证脚本
# 用法: NEXSCOPE_API_KEY=nk-xxx ./test_1688_api.sh [关键词]
# 注意: 每次调用消耗 credits,本脚本只发一次请求
# 已验证的注意点:
#   1. Windows Git Bash 下中文参数须经 UTF-8 文件传递(--data-binary @file),
#      直接写在命令行里会编码损坏,上游报 code 99001 参数错误
#   2. 成功响应特征: HTTP 200 且 errcode==200,products 数组有数据

set -euo pipefail

KEY="${NEXSCOPE_API_KEY:-}"
if [[ -z "$KEY" ]]; then
  if [[ -f "$(dirname "$0")/.env" ]]; then
    KEY=$(grep -E '^NEXSCOPE_API_KEY=' "$(dirname "$0")/.env" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
  fi
fi

if [[ -z "$KEY" ]]; then
  echo "错误: 未找到 API Key。请设置 NEXSCOPE_API_KEY 环境变量或在同目录创建 .env 文件。" >&2
  exit 2
fi

KEYWORD="${1:-保温杯}"
BODY_FILE=$(mktemp --suffix=.json)
RESP_FILE=$(mktemp --suffix=.json)
trap 'rm -f "$BODY_FILE" "$RESP_FILE"' EXIT
printf '{"searchType": 1, "keyWord": "%s", "pageSize": 10, "pageIndex": 1}' "$KEYWORD" > "$BODY_FILE"

HTTP_CODE=$(curl -s -o "$RESP_FILE" -w "%{http_code}" \
  -X POST "https://api.nexscope.ai/api/skill-api/v1/skills/1688-product-search/run" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  --data-binary @"$BODY_FILE")

echo "HTTP 状态码: $HTTP_CODE"

case "$HTTP_CODE" in
  200)
    ERRCode=$(jq -r '.errcode // .code // "null"' "$RESP_FILE")
    if [[ "$ERRCode" == "200" ]]; then
      echo "✅ 连接成功!"
      jq -r "\"  total=\(.total)  本页商品数=\(.products|length)\", (.products[:3][] | \"  - [\(.offerId)] \(.title[:40])  批发价:\(.price)  起订量:\(.quantityBegin)\")" "$RESP_FILE"
    else
      echo "❌ 上游返回业务错误 (errcode=$ERRCode):"
      jq -r '.msg // .errmsg // empty' "$RESP_FILE"
      exit 1
    fi
    ;;
  401) echo "❌ 认证失败 (401): API Key 缺失、无效或无法匹配用户。"; jq -r '.' "$RESP_FILE"; exit 1 ;;
  400) echo "❌ 请求无效 (400):"; jq -r '.' "$RESP_FILE"; exit 1 ;;
  *)   echo "❌ 请求失败 (HTTP $HTTP_CODE):"; head -c 2000 "$RESP_FILE"; exit 1 ;;
esac

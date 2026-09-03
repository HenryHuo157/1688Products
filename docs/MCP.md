# 1688Products MCP Server 使用说明

把整套 1688 采购分析流程（数据仓去重、类目真品校验、噪音标记、AI 测评）打包成 MCP 工具，任何支持 MCP 的 AI 客户端（Claude Desktop、Cursor、Kimi API 壳等）都能直接"接管"。

**安全模型：API Key 只存在 MCP Server 所在机器的环境变量/`.env`，AI 模型和最终用户都接触不到。**

## 提供的工具

| 工具 | 功能 | 消耗 |
|---|---|---|
| `search_1688` | 搜索商品（数据仓去重复用→类目真品校验→噪音标记→排序，可带AI总结） | 首次约12cr，复用免费 |
| `ask_dataset` | 对已有数据集本地问答/筛选（如"低于20元的有几个"） | 0 credits |
| `compare_products` | 按序号对比商品，AI出优劣势结论 | 0 credits |
| `datastore_overview` | 查看数据仓已有哪些数据集 | 0 credits |

## 接入 Claude Desktop / Cursor（最简单）

编辑配置文件（Claude Desktop: `claude_desktop_config.json`；Cursor: MCP 设置），加入：

```json
{
  "mcpServers": {
    "1688products": {
      "command": "node",
      "args": ["<本仓库绝对路径>/mcp-server.mjs"],
      "env": {
        "NEXSCOPE_API_KEY": "nk-你的key",
        "AI_API_KEY": "你的OpenRouter或智谱Key",
        "AI_BASE_URL": "https://openrouter.ai/api/v1",
        "AI_MODEL": "z-ai/glm-5.3-flash"
      }
    }
  }
}
```

重启客户端后即可对话："帮我搜保温杯，只要50块以下的，按销量排"——模型会自动调用 `search_1688` 并给出分析。

## 接入 Kimi（或任何 OpenAI 兼容模型的 API 壳）

Kimi 网页版暂不支持挂载 MCP，但 Kimi API 支持 function calling。自建一个轻量壳（约100行）：把 MCP 工具列表转成 Kimi 的 tools 参数，模型发起 tool_call 时转发给本 server（stdio 或后续可加 SSE transport）。需要的话可以在此基础上扩展。

## 前置要求

- Node.js ≥ 18
- `npm install`（只需 `@modelcontextprotocol/sdk`）
- 数据仓 `1688_history.json` 放本目录（与主系统共享则指向同一文件）

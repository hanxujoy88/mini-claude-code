# MCP 和 Web Search：把 Agent 的工具边界扩出去

一个 Coding Agent 如果只能读写本地文件，很快会遇到边界。

它可能需要：

- 查询当前外部信息
- 调用公司内部工具
- 连接数据库、浏览器、Issue 系统
- 复用别人已经写好的工具 server

Mini Claude Code 用两个能力扩展边界：

- Web Search
- MCP Integration

## 1. Web Search：当前信息不能靠模型记忆

模型有知识截止时间。问版本、价格、API 变更、最新文档时，不能只靠模型猜。

Mini Claude Code 加了：

```text
web_search
```

工具参数：

```json
{
  "query": "latest Node.js LTS",
  "max_results": 5
}
```

默认使用 DuckDuckGo Instant Answer，不需要 key，但覆盖面有限。

如果配置：

```bash
export BRAVE_SEARCH_API_KEY="..."
```

就会使用 Brave Search API。

实现位置：

```text
src/webSearch.js
src/tools.js
src/toolSchemas.js
```

这个实现刻意保持无运行时依赖，直接用 Node 20 的 `fetch`。

## 2. 为什么还需要 MCP

Web Search 解决的是“查外部信息”。

MCP 解决的是“接更多工具”。

MCP 的价值在于让 agent 不必把所有工具都内置进 CLI。只要有一个 MCP server，Mini Claude Code 就可以启动它、发现工具、把工具暴露给模型。

默认配置文件：

```text
.mini-claude-code/mcp.json
```

示例：

```json
{
  "servers": {
    "example": {
      "command": "node",
      "args": ["path/to/mcp-server.js"],
      "env": {},
      "timeout_ms": 30000
    }
  }
}
```

也可以指定：

```bash
npm start -- --mcp-config=./mcp.json
```

## 3. MCP 工具如何暴露给模型

启动时，Mini Claude Code 会：

1. spawn MCP server
2. 发送 `initialize`
3. 发送 `notifications/initialized`
4. 调用 `tools/list`
5. 把工具 schema 合并到主模型工具列表

为了避免命名冲突，MCP 工具名会变成：

```text
mcp__<server>__<tool>
```

例如：

```text
mcp__github__list_issues
```

模型调用这个工具时，Mini Claude Code 会转发：

```text
tools/call
```

然后把 MCP 返回内容重新塞回主工具循环。

实现位置：

```text
src/mcp.js
src/index.js
src/tools.js
```

## 4. list_mcp_tools

为了让模型或用户确认当前加载了哪些 MCP 工具，内置了：

```text
list_mcp_tools
```

没有配置时，banner 会显示：

```text
MCP: none
```

## 5. 取舍和限制

当前 MCP 实现只支持 stdio server。

还没做：

- MCP resources
- MCP prompts
- HTTP transport
- streaming tool result
- OAuth 或复杂认证 UI

但最关键的工具调用链路已经打通。

## 6. 这篇对应的能力

这一篇合并介绍：

- MCP Integration
- Web Search

它们的共同点是：让 agent 不再局限在本地代码目录里，而是能连接外部信息和外部工具。


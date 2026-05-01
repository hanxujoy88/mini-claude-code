# Provider 适配和 Token 统计：兼容 Anthropic、Kimi 与 OpenAI-compatible API

Mini Claude Code 一开始接的是 Anthropic Messages API。

后来为了支持 Kimi，又接入了 OpenAI-compatible Chat Completions。这个过程里最大的体会是：看起来都是“工具调用”，但消息结构差异很明显。

这一篇把 provider adapter 和 token usage feedback 合并讲。

## 1. 内部统一成 Anthropic-style block

项目内部使用一种统一格式：

```text
text
tool_use
tool_result
```

Anthropic 原生就是这种思路，所以发送时比较直接。

OpenAI-compatible 则要转换：

- tool schema -> `tools: [{ type: "function", function: ... }]`
- assistant `tool_use` -> `tool_calls`
- user `tool_result` -> `role: "tool"`
- returned `tool_calls` -> internal `tool_use`

实现位置：

```text
src/model.js
```

这样做的好处是：本地工具层不需要关心 provider。工具永远只处理 Mini Claude Code 自己的内部格式。

## 2. Kimi 适配里踩过的坑

OpenAI-compatible 不代表完全一样。

之前 Kimi 工具调用遇到过一个错误：

```text
thinking is enabled but reasoning_content is missing in assistant tool call message
```

原因是 assistant tool call message 里需要带 `reasoning_content` 字段，即使是空字符串。

所以转换 OpenAI-compatible assistant message 时，如果存在 tool calls，会补：

```js
convertedMessage.reasoning_content = message.reasoning_content || "";
```

这类细节是写 provider adapter 最容易踩的地方。

## 3. Streaming 也要分别适配

Anthropic streaming 是 SSE event：

```text
message_start
content_block_start
content_block_delta
content_block_stop
message_delta
```

OpenAI-compatible streaming 是 chunks：

```text
choices[].delta.content
choices[].delta.tool_calls
choices[].delta.reasoning_content
```

所以 `src/model.js` 里有两套 parser，但最终都收敛到同一个内部结构。

## 4. Token Usage Feedback

Coding Agent 很容易越聊越贵，所以每次模型调用结束都会打印 token 用量。

例如：

```text
[ok] Thinking - tokens 900 in, 120 out, 1,020 total | session 3,400 tokens
```

统计内容包括：

- 当前调用 input tokens
- 当前调用 output tokens
- 当前调用 total tokens
- 当前 session total tokens
- provider 返回时的 prompt cache create/read tokens

实现位置：

```text
src/model.js
src/index.js
src/session.js
```

## 5. 为什么 token total 要持久化

如果 session 可以恢复，但 token total 每次归零，就很难判断一个长任务到底消耗了多少。

所以 token totals 会保存在 session 文件里：

```text
.mini-claude-code/sessions/<session>.json
```

这不是计费系统，只是一个工程反馈信号。但对调试 agent 很有用。

## 6. 当前支持的 provider

配置 Anthropic：

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
npm start
```

配置 Kimi：

```bash
export MINI_CLAUDE_PROVIDER=moonshot
export MINI_CLAUDE_API_KEY="sk-..."
export MINI_CLAUDE_MODEL="kimi-k2.6"
npm start
```

配置自定义 OpenAI-compatible endpoint：

```bash
MINI_CLAUDE_PROVIDER=openai \
MINI_CLAUDE_BASE_URL="https://api.example.com/v1" \
MINI_CLAUDE_API_KEY="sk-..." \
MINI_CLAUDE_MODEL="your-model" \
npm start
```

## 7. 这篇对应的能力

这一篇合并介绍：

- Provider Adapter
- Streaming provider differences
- Token Usage Feedback
- Kimi/OpenAI-compatible compatibility details

这类能力不直接出现在用户感知里，但它决定了一个 coding agent 能不能换模型、能不能排查 token 消耗、能不能在真实环境里稳定跑。


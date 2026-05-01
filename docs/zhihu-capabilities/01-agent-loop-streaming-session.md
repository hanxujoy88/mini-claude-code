# 从工具调用循环到流式终端体验：一个 Coding Agent 的最小骨架

如果把 Claude Code、Codex CLI 这类工具拆开看，最核心的东西并不玄学。

它不是“模型会写代码”这么简单，而是一个稳定的循环：

```text
用户输入
  -> 模型思考
  -> 模型决定是否调用工具
  -> 本地执行工具
  -> 工具结果回填给模型
  -> 模型继续
  -> 直到返回最终文本
```

Mini Claude Code 的第一层能力就是围绕这个循环搭出来的。

## 1. 为什么工具调用循环是核心

普通聊天模型只能“说”。Coding Agent 需要“做”。

要让模型真正做事，至少需要三类信息：

1. 当前对话历史
2. 可用工具列表
3. 工具调用结果

在实现里，入口位于：

```text
src/index.js
```

主循环负责：

- 接收用户输入
- 维护 `messages`
- 调用模型
- 识别 `tool_use`
- 执行本地工具
- 把 `tool_result` 塞回历史

简化后大概是：

```js
async function runAssistantTurn(messages) {
  while (true) {
    const response = await callModel(messages);
    messages.push({ role: "assistant", content: response.content });

    const toolUses = response.content.filter((block) => block.type === "tool_use");
    if (toolUses.length === 0) return;

    const results = [];
    for (const toolUse of toolUses) {
      const result = await runToolWithFeedback(toolUse.name, toolUse.input || {});
      results.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: result.ok ? result.content : `ERROR: ${result.error}`,
        is_error: !result.ok
      });
    }

    messages.push({ role: "user", content: results });
  }
}
```

这个循环一旦稳定，后面的文件读写、命令执行、MCP、Web Search、多代理，本质上都是工具扩展。

## 2. 工具 Schema 是 Agent 的能力菜单

模型并不知道本地有什么能力。我们需要把工具描述成 schema 发给它。

比如 `read_file`、`write_file`、`run_command`、`web_search`，都在：

```text
src/toolSchemas.js
```

这些 schema 会随请求传给模型。模型看到以后，才知道可以调用哪些工具、每个工具需要哪些参数。

这个设计的好处是边界清楚：

- schema 负责告诉模型“能做什么”
- `src/tools.js` 负责真正执行
- `src/index.js` 负责串起对话和工具结果

## 3. 为什么要做 Streaming

如果非流式调用，用户看到的是：

```text
Thinking...
等十几秒
一次性输出完整答案
```

这和真实 Coding Agent 的体验差很多。

Mini Claude Code 后来加入了 streaming response：

- Anthropic 走 Server-Sent Events
- OpenAI-compatible 走 Chat Completions stream chunks
- 文本 delta 实时打印
- tool call 参数在后台累积完整后再执行

核心实现位于：

```text
src/model.js
```

流式输出不是简单 `console.log(chunk)`。因为模型可能一边输出文本，一边生成工具调用参数。尤其 OpenAI-compatible 的 `tool_calls` 会被拆成多个 delta，需要按 index 拼回完整 JSON 参数。

所以实现上有两个状态：

- `text` 或 `content`：累计自然语言文本
- `toolCalls`：累计工具调用 id、name、arguments

等流结束后，再把它们统一转换回内部消息格式。

## 4. 持久化会话

Coding Agent 如果每次重启都丢上下文，会很难用于真实工作。

所以 Mini Claude Code 加了本地 session：

```text
.mini-claude-code/sessions/default.json
```

保存内容包括：

- conversation messages
- active skills
- task plan
- token totals
- provider 和 model metadata

不保存 API key。

默认启动会恢复 `default` session，也可以指定：

```bash
npm start -- --session=my-feature
```

清空当前会话：

```text
/new
```

实现位置：

```text
src/session.js
src/index.js
```

## 5. 这篇对应的能力

这一篇合并介绍了三个基础能力：

- Interactive Tool Loop
- Streaming Responses
- Persistent Sessions

它们共同构成了 Mini Claude Code 的运行骨架。没有这三层，后面的 MCP、Skills、Web Search、Sandbox 都只是散落的函数，不能成为一个真正的 agent。


# 让 Agent 少花 Token：文件读取、Hash Cache、历史压缩和 Prompt Cache

写 Coding Agent 最容易低估的一件事是：不是模型不会写代码，而是上下文会越来越贵。

一开始 Mini Claude Code 的 `read_file` 很简单，模型要读什么文件，就把完整文件塞回去。很快就遇到两个问题：

1. 大文件一次性进入上下文，后续每一轮都要重复携带
2. 同一个文件被反复读取，内容没变却重复消耗 token

所以后来陆续加了四个能力：

- token-conscious file reads
- file hash cache
- automatic history compaction
- prompt cache

这四个能力放在一起看，本质都是为了同一个目标：让上下文增长可控。

## 1. Token-conscious file reads

`read_file` 不再默认无限制返回文件内容。

现在支持：

```json
{
  "path": "src/index.js",
  "start_line": 120,
  "end_line": 220,
  "max_chars": 8000
}
```

返回结果会包含：

- 文件路径
- 行号范围
- 总行数
- 最大字符数
- 是否截断
- 下一段读取提示

实现位置：

```text
src/tools.js
src/toolSchemas.js
```

默认字符上限来自：

```bash
MINI_CLAUDE_READ_MAX_CHARS=12000
```

这个设计非常朴素，但很有效。模型 review 一个大文件时，可以先读关键范围，再按需继续，而不是把整个项目吞进去。

## 2. File Hash Cache

只控制读取范围还不够。实际使用中，模型经常会重复读同一个文件。

比如：

```text
先读 package.json
跑 npm test
再读 package.json 确认脚本
修改一个无关文件
又读 package.json
```

如果文件没变，第二次以后完全没必要返回完整内容。

所以 `read_file` 现在会返回：

```text
Hash: sha256:<hash>
Cache: miss
```

后续模型可以带上：

```json
{
  "path": "package.json",
  "known_hash": "sha256:<previous-hash>"
}
```

如果文件没变，工具只返回：

```text
Cache: hit
Unchanged: yes
Contents omitted.
```

需要强制读取时：

```json
{
  "path": "package.json",
  "known_hash": "sha256:<previous-hash>",
  "force": true
}
```

这个不是复杂的全局缓存系统，而是一个轻量协议：工具告诉模型 hash，模型下次把 hash 带回来。

好处是实现简单，也不会让本地缓存和模型记忆产生隐式不一致。

## 3. 自动历史压缩

再往后，问题会从“某次工具结果太大”变成“整个 session 太长”。

Mini Claude Code 会估算当前 `messages` 的序列化长度。如果超过阈值，就触发自动压缩：

```bash
MINI_CLAUDE_HISTORY_COMPACT_AFTER_CHARS=80000
MINI_CLAUDE_HISTORY_COMPACT_KEEP_MESSAGES=12
```

压缩策略是：

- 旧消息交给模型总结
- 最近若干条消息原样保留
- 总结以隐藏上下文形式放回 messages 开头

实现位置：

```text
src/history.js
src/index.js
```

压缩提示会要求模型保留：

- 用户长期意图
- 仓库事实
- 已修改文件
- 执行过的命令
- 关键错误
- 未完成任务
- 重要约束

同时丢弃重复日志和临时措辞。

这里有个小坑：不能让压缩后的历史以 `tool_result` 开头。很多 provider 要求 tool result 必须跟在对应 assistant tool call 后面。所以实现里会调整 split 点，避免保留区第一条是 tool result。

禁用压缩：

```bash
MINI_CLAUDE_HISTORY_COMPACT_AFTER_CHARS=0
```

## 4. Prompt Cache

除了历史，另一个稳定的大块内容是：

- system prompt
- tool schema

它们每轮请求基本一样。Anthropic 支持给稳定内容加 ephemeral cache hint。

Mini Claude Code 在：

```bash
MINI_CLAUDE_PROMPT_CACHE=auto
```

时，会给 Anthropic 请求中的 system prompt 和最后一个 tool schema 加：

```json
{
  "cache_control": {
    "type": "ephemeral"
  }
}
```

实现位置：

```text
src/model.js
```

OpenAI-compatible provider 这里是 no-op，因为接口语义不同。但如果 provider 返回 cached token 统计，也会展示。

状态行会显示类似：

```text
tokens 900 in, 100 out, 1000 total, cache 1200 create, 800 read | session 5000 tokens
```

## 5. 这篇对应的能力

这一篇合并介绍：

- Token-Conscious File Reads
- File Hash Cache
- Automatic History Compaction
- Prompt Cache
- Token Usage Feedback 的缓存部分

它们共同解决的是 agent 工程里非常现实的问题：上下文不是免费的，必须让模型少读、少带、少重复。


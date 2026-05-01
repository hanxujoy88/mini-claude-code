# Mini Claude Code

A minimal Claude Code-style terminal assistant. It gives Claude a small set of local tools so it can inspect a project, edit files, and run commands while you stay in control.

This is intentionally tiny: a small set of Node.js modules, no runtime dependencies, and explicit confirmation before file writes or command execution.

This project is an independent learning implementation. It is not affiliated with Anthropic or the official Claude Code product.

## Features

- Interactive terminal chat
- Anthropic Messages API tool loop
- Streaming assistant responses
- Local tools:
  - `list_files`
  - `read_file`
  - `write_file`
  - `run_command`
  - `web_search`
  - `start_background_task`
  - `list_background_tasks`
  - `read_background_task`
  - `stop_background_task`
  - `create_plan`
  - `update_task`
  - `list_plan`
  - `delegate_agent`
  - `sandbox_status`
  - `list_mcp_tools`
- In-memory task planning
- Small multi-agent delegation system
- MCP stdio server integration
- Web search with optional Brave Search API support
- Background task manager for long-running commands
- Terminal feedback spinners while the model thinks and tools run
- Token usage in the `Thinking` status line after each model call, with session totals
- File hash cache for repeated `read_file` calls
- Automatic history compaction for long sessions
- Anthropic prompt cache hints for stable system prompts and tool schemas
- Persistent local sessions in `.mini-claude-code/sessions/`
- Auto-discovered skills from `skills/*/SKILL.md`
- Token-conscious `read_file` with line ranges and default truncation
- Workspace sandboxing to the current project directory
- macOS system sandbox for command execution
- Read-only sandbox mode
- Optional command allowlist
- Confirmation prompts before writes and commands
- `--yes` mode for trusted automation

## Requirements

- Node.js 20+
- `ANTHROPIC_API_KEY` or another supported provider key

## Usage

Anthropic:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
npm start
```

Moonshot / Kimi:

```bash
export MINI_CLAUDE_PROVIDER=moonshot
export MINI_CLAUDE_API_KEY="sk-..."
npm start
```

Or use the helper script:

```bash
cp .env.example .env.local
# edit .env.local and set MINI_CLAUDE_API_KEY
./scripts/start-kimi.sh
```

You can also pass the key for one run:

```bash
MINI_CLAUDE_API_KEY="sk-..." ./scripts/start-kimi.sh
```

Use a different model:

```bash
MINI_CLAUDE_MODEL="claude-3-5-sonnet-latest" npm start
```

Use a custom OpenAI-compatible endpoint:

```bash
MINI_CLAUDE_PROVIDER=openai \
MINI_CLAUDE_BASE_URL="https://api.example.com/v1" \
MINI_CLAUDE_API_KEY="sk-..." \
MINI_CLAUDE_MODEL="your-model" \
npm start
```

Run from another project:

```bash
cd /path/to/your/project
node /path/to/mini-claude-code/src/index.js
```

Auto-approve writes and commands:

```bash
npm start -- --yes
```

Run in read-only mode:

```bash
npm start -- --sandbox=read-only
```

Disable the macOS system command sandbox:

```bash
npm start -- --system-sandbox=off
```

Only allow selected command prefixes:

```bash
MINI_CLAUDE_ALLOWED_COMMANDS="npm,git,ls,pwd" npm start
```

Configure MCP servers with `.mini-claude-code/mcp.json`:

```json
{
  "servers": {
    "example": {
      "command": "node",
      "args": ["path/to/mcp-server.js"]
    }
  }
}
```

Use another MCP config file:

```bash
npm start -- --mcp-config=./mcp.json
```

For stronger web search results, set a Brave Search key:

```bash
export BRAVE_SEARCH_API_KEY="..."
```

Exit with `/exit` or `Ctrl+C`.

Start a fresh conversation while keeping the same terminal process:

```text
/new
```

Use a named persistent session:

```bash
npm start -- --session=my-feature
```

or:

```bash
MINI_CLAUDE_SESSION=my-feature npm start
```

## Safety Model

Mini Claude Code is deliberately conservative:

- Paths are resolved inside the current working directory.
- `--sandbox=read-only` disables file writes and command execution.
- Default sandbox mode is `workspace-write`.
- On macOS, `run_command` is executed through `/usr/bin/sandbox-exec` by default and cannot write outside the workspace or temp directories.
- `write_file` asks for confirmation unless `--yes` is used.
- `run_command` asks for confirmation unless `--yes` is used.
- `MINI_CLAUDE_SYSTEM_SANDBOX=off` disables the OS-level command sandbox; `on` requires it.
- `MINI_CLAUDE_ALLOWED_COMMANDS` can restrict command execution to comma-separated prefixes.
- A small denylist blocks obviously destructive shell snippets such as `rm -rf /`, `git reset --hard`, and fork bombs.

This is still a teaching implementation, but command execution now has an actual operating-system write boundary on macOS.

## Implementation Details

The CLI keeps a conversation history and sends it to Anthropic's Messages API or an OpenAI-compatible chat completions endpoint. Assistant text streams to the terminal as it arrives. When the model returns tool calls, the CLI executes the requested local tool, appends a tool result, and calls the model again until it returns normal text.

The main loop is:

1. Read a user message from stdin.
2. Send messages plus tool schemas to the configured provider.
3. Stream assistant text blocks.
4. Execute any tool calls.
5. Send tool results back to the model.
6. Repeat until no more tools are requested.

### Task Planning

The model can create and maintain an in-memory plan with:

- `create_plan`: replace the current task list
- `update_task`: mark a task as `pending`, `in_progress`, `completed`, or `blocked`
- `list_plan`: inspect the current plan

Plans are persisted with the active session and can be reset with `/new`.

### Persistent Sessions

By default, Mini Claude Code restores the `default` session from:

```text
.mini-claude-code/sessions/default.json
```

The session file stores conversation messages, active skill names, task plan state, and token totals. It does not store API keys. The `.mini-claude-code/` directory is ignored by Git.

### Multi-Agent Delegation

The `delegate_agent` tool asks a specialized model persona for advice. Available roles:

- `planner`
- `implementer`
- `reviewer`
- `tester`

Sub-agents cannot call tools or edit files. They return text back to the main assistant, which decides what to do next.

### Skills

Mini Claude Code auto-discovers skills from:

```text
skills/<skill-name>/SKILL.md
```

Each skill can include optional frontmatter:

```md
---
name: docs-writer
description: Use when writing README files, tutorials, changelogs, or technical explanations.
---

# Instructions
...
```

On each user request, the CLI scores the request against skill names and descriptions. Matching skills are injected as hidden context for that turn and shown in the terminal:

```text
[skills] docs-writer
```

Use `list_skills` from the assistant to inspect loaded skills.

The same skill is injected only once per session to avoid repeatedly paying for identical skill instructions.

### Token Controls

`read_file` returns line-numbered output and defaults to a maximum of 12,000 characters. For larger files, it tells the model which line range to request next.

The model can call:

```json
{
  "path": "src/index.js",
  "start_line": 120,
  "end_line": 220,
  "max_chars": 8000
}
```

Every `read_file` response includes a `sha256` hash. Later calls can pass that hash as `known_hash`; if the file is unchanged, Mini Claude Code returns only metadata and omits the file contents.

### History And Prompt Cache

Long sessions are compacted automatically once the serialized message history exceeds `MINI_CLAUDE_HISTORY_COMPACT_AFTER_CHARS`. Older messages are summarized with a no-tools model call, while the most recent messages stay verbatim.

When using Anthropic, `MINI_CLAUDE_PROMPT_CACHE=auto` marks stable system prompt and tool schema blocks with ephemeral prompt-cache hints. Cache create/read token counts are shown in the `Thinking` status line when the provider reports them.

See [IMPLEMENTATION.md](IMPLEMENTATION.md) for a more detailed breakdown.

## Environment Variables

| Name | Default | Description |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | required for Anthropic | Anthropic API key |
| `MINI_CLAUDE_API_KEY` | optional | Generic provider API key |
| `MINI_CLAUDE_PROVIDER` | `anthropic` | `anthropic`, `moonshot`, `kimi`, or `openai` |
| `MINI_CLAUDE_BASE_URL` | provider default | OpenAI-compatible base URL |
| `MINI_CLAUDE_MODEL` | provider default | Model name |
| `MINI_CLAUDE_MAX_TOKENS` | `4096` | Max output tokens per API call |
| `MINI_CLAUDE_TIMEOUT_MS` | `120000` | Model request timeout in milliseconds |
| `MINI_CLAUDE_READ_MAX_CHARS` | `12000` | Default max characters returned by `read_file` |
| `MINI_CLAUDE_SESSION` | `default` | Persistent session name |
| `MINI_CLAUDE_MCP_CONFIG` | `.mini-claude-code/mcp.json` | MCP server config path |
| `MINI_CLAUDE_WEB_SEARCH_TIMEOUT_MS` | `15000` | Web search request timeout |
| `MINI_CLAUDE_HISTORY_COMPACT_AFTER_CHARS` | `80000` | Serialized history size that triggers auto-compaction; `0` disables |
| `MINI_CLAUDE_HISTORY_COMPACT_KEEP_MESSAGES` | `12` | Recent messages kept verbatim during compaction |
| `MINI_CLAUDE_PROMPT_CACHE` | `auto` | `auto` or `off`; enables Anthropic prompt cache hints |
| `MINI_CLAUDE_SANDBOX` | `workspace-write` | Sandbox mode, e.g. `read-only` |
| `MINI_CLAUDE_SYSTEM_SANDBOX` | `auto` | `auto`, `on`, or `off`; wraps `run_command` with macOS `sandbox-exec` when enabled |
| `MINI_CLAUDE_ALLOWED_COMMANDS` | empty | Optional comma-separated command allowlist |

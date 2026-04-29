# Mini Claude Code

A minimal Claude Code-style terminal assistant. It gives Claude a small set of local tools so it can inspect a project, edit files, and run commands while you stay in control.

This is intentionally tiny: one Node.js file, no runtime dependencies, and explicit confirmation before file writes or command execution.

This project is an independent learning implementation. It is not affiliated with Anthropic or the official Claude Code product.

## Features

- Interactive terminal chat
- Anthropic Messages API tool loop
- Local tools:
  - `list_files`
  - `read_file`
  - `write_file`
  - `run_command`
  - `create_plan`
  - `update_task`
  - `list_plan`
  - `delegate_agent`
  - `sandbox_status`
- In-memory task planning
- Small multi-agent delegation system
- Terminal feedback spinners while the model thinks and tools run
- Workspace sandboxing to the current project directory
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

Only allow selected command prefixes:

```bash
MINI_CLAUDE_ALLOWED_COMMANDS="npm,git,ls,pwd" npm start
```

Exit with `/exit` or `Ctrl+C`.

## Safety Model

Mini Claude Code is deliberately conservative:

- Paths are resolved inside the current working directory.
- `--sandbox=read-only` disables file writes and command execution.
- Default sandbox mode is `workspace-write`.
- `write_file` asks for confirmation unless `--yes` is used.
- `run_command` asks for confirmation unless `--yes` is used.
- `MINI_CLAUDE_ALLOWED_COMMANDS` can restrict command execution to comma-separated prefixes.
- A small denylist blocks obviously destructive shell snippets such as `rm -rf /`, `git reset --hard`, and fork bombs.

This is not a security sandbox. It is a teaching implementation and a compact starting point for a coding agent.

## Implementation Details

The CLI keeps a conversation history and sends it to Anthropic's Messages API. When Claude returns `tool_use` blocks, the CLI executes the requested local tool, appends a `tool_result`, and calls the model again until Claude returns normal text.

The main loop is:

1. Read a user message from stdin.
2. Send messages plus tool schemas to Anthropic.
3. Print assistant text blocks.
4. Execute any tool calls.
5. Send tool results back to the model.
6. Repeat until no more tools are requested.

### Task Planning

The model can create and maintain an in-memory plan with:

- `create_plan`: replace the current task list
- `update_task`: mark a task as `pending`, `in_progress`, `completed`, or `blocked`
- `list_plan`: inspect the current plan

Plans are intentionally session-local and reset when the CLI exits.

### Multi-Agent Delegation

The `delegate_agent` tool asks a specialized model persona for advice. Available roles:

- `planner`
- `implementer`
- `reviewer`
- `tester`

Sub-agents cannot call tools or edit files. They return text back to the main assistant, which decides what to do next.

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
| `MINI_CLAUDE_SANDBOX` | `workspace-write` | Sandbox mode, e.g. `read-only` |
| `MINI_CLAUDE_ALLOWED_COMMANDS` | empty | Optional comma-separated command allowlist |

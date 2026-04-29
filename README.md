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
- Workspace sandboxing to the current project directory
- Confirmation prompts before writes and commands
- `--yes` mode for trusted automation

## Requirements

- Node.js 20+
- `ANTHROPIC_API_KEY`

## Usage

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
npm start
```

Use a different model:

```bash
MINI_CLAUDE_MODEL="claude-3-5-sonnet-latest" npm start
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

Exit with `/exit` or `Ctrl+C`.

## Safety Model

Mini Claude Code is deliberately conservative:

- Paths are resolved inside the current working directory.
- `write_file` asks for confirmation unless `--yes` is used.
- `run_command` asks for confirmation unless `--yes` is used.
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

See [IMPLEMENTATION.md](IMPLEMENTATION.md) for a more detailed breakdown.

## Environment Variables

| Name | Default | Description |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | required | Anthropic API key |
| `MINI_CLAUDE_MODEL` | `claude-3-5-sonnet-latest` | Model name |
| `MINI_CLAUDE_MAX_TOKENS` | `4096` | Max output tokens per API call |

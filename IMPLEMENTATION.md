# Implementation Details

Mini Claude Code is a compact reference implementation of a coding agent loop.

## Runtime

- Language: Node.js ESM
- Minimum Node version: 20
- Runtime dependencies: none
- API: Anthropic Messages API
- Entry point: `src/index.js`

## Conversation Loop

The CLI stores an in-memory `messages` array for the current session.

For each user prompt:

1. Push `{ role: "user", content: text }`.
2. Call `POST /v1/messages` with:
   - `system` prompt
   - prior messages
   - tool schemas
   - configured model
3. Print assistant `text` blocks.
4. Execute any assistant `tool_use` blocks locally.
5. Push one user message containing `tool_result` blocks.
6. Repeat until the assistant returns no tool calls.

There is no persistent memory yet. Restarting the CLI starts a new conversation.

## Tool Set

### `list_files`

Recursively lists files under a workspace directory.

Ignored directories:

- `.git`
- `node_modules`
- `dist`
- `build`

### `read_file`

Reads a UTF-8 file inside the workspace.

### `write_file`

Creates or overwrites a UTF-8 file inside the workspace.

By default it asks:

```text
Write path/to/file? [y/N]
```

Pass `--yes` to auto-approve writes.

### `run_command`

Runs a shell command in the workspace with a timeout.

By default it asks:

```text
Run command: npm test? [y/N]
```

Pass `--yes` to auto-approve commands.

## Workspace Boundary

All file paths go through `resolveInsideWorkspace`.

The function resolves a requested path against `process.cwd()` and rejects any path that escapes the workspace via `..` or an absolute path outside the root.

This protects the common case of accidental edits outside the current project. It is not a hardened OS sandbox.

## Command Safety

`run_command` uses a small denylist for obviously destructive commands, including:

- `rm -rf /`
- `git reset --hard`
- classic fork bomb shape
- `mkfs.*`
- direct block device overwrite patterns

The main safety control is still user confirmation.

## Configuration

Environment variables:

- `ANTHROPIC_API_KEY`: required
- `MINI_CLAUDE_MODEL`: defaults to `claude-3-5-sonnet-latest`
- `MINI_CLAUDE_MAX_TOKENS`: defaults to `4096`

CLI flags:

- `--yes` or `-y`: auto-approve writes and commands

## Deliberate Omissions

This project is intentionally minimal. It does not yet include:

- Streaming responses
- Persistent conversations
- Git-aware patch generation
- Multi-file diff preview
- Structured approvals
- True sandboxing
- MCP support
- Web search
- Background task management

Those are natural next steps if you want to evolve it from a teaching implementation into a practical coding assistant.

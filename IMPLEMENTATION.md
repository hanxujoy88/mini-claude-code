# Implementation Details

Mini Claude Code is a compact reference implementation of a coding agent loop.

## Runtime

- Language: Node.js ESM
- Minimum Node version: 20
- Runtime dependencies: none
- API: Anthropic Messages API or OpenAI-compatible chat completions
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

## Provider Adapter

Internally, Mini Claude Code keeps messages and tool calls in Anthropic-style blocks:

- `text`
- `tool_use`
- `tool_result`

For Anthropic, those blocks are sent directly to `/v1/messages`.

For OpenAI-compatible providers such as Moonshot / Kimi, the adapter converts:

- tool schemas to `tools: [{ type: "function", function: ... }]`
- assistant `tool_use` blocks to `tool_calls`
- user `tool_result` blocks to `role: "tool"` messages
- OpenAI-compatible `tool_calls` back into internal `tool_use` blocks

This keeps the agent loop provider-agnostic while preserving one implementation of local tools.

The adapter also normalizes token usage into `{ input, output, total }`. While the model call is in flight, the `Thinking` spinner shows accumulated session tokens. When the call finishes, the same status line shows the current call's token usage plus updated session totals.

## Task Planning

The current task plan is stored in memory as:

```js
{
  id: number,
  text: string,
  status: "pending" | "in_progress" | "completed" | "blocked",
  note: string
}
```

The assistant can manage it with:

- `create_plan`
- `update_task`
- `list_plan`

This gives the model enough structure to handle multi-step tasks without adding a database or background scheduler.

## Multi-Agent Delegation

The `delegate_agent` tool makes a second Anthropic call with a specialized system prompt and no tools.

Available roles:

- `planner`: breaks work into steps and highlights risk
- `implementer`: proposes concrete code edits and commands
- `reviewer`: looks for bugs, missing tests, and unsafe assumptions
- `tester`: proposes validation steps

Sub-agents are intentionally read-only advisers. They cannot inspect the filesystem themselves, so the main assistant must pass relevant snippets or logs as `context`.

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

### `create_plan`

Replaces the current in-memory task plan.

### `update_task`

Updates one task status and optional note.

### `list_plan`

Returns the current plan.

### `delegate_agent`

Calls a specialized sub-agent and returns its text response to the main assistant.

### `sandbox_status`

Reports current workspace, sandbox mode, auto-approval mode, and command policy.

## Workspace Boundary

All file paths go through `resolveInsideWorkspace`.

The function resolves a requested path against `process.cwd()` and rejects any path that escapes the workspace via `..` or an absolute path outside the root.

This protects the common case of accidental edits outside the current project. It is not a hardened OS sandbox.

## Sandbox Modes

Mini Claude Code now supports a small policy sandbox:

- `workspace-write` (default): files stay inside the workspace; writes and commands require confirmation unless `--yes` is set
- `read-only`: disables `write_file` and `run_command`

You can set the mode with either:

```bash
npm start -- --sandbox=read-only
```

or:

```bash
MINI_CLAUDE_SANDBOX=read-only npm start
```

## Command Safety

`run_command` uses a small denylist for obviously destructive commands, including:

- `rm -rf /`
- `git reset --hard`
- classic fork bomb shape
- `mkfs.*`
- direct block device overwrite patterns

The main safety control is still user confirmation.

If `MINI_CLAUDE_ALLOWED_COMMANDS` is set, commands must match one of the comma-separated prefixes:

```bash
MINI_CLAUDE_ALLOWED_COMMANDS="npm,git,ls,pwd" npm start
```

## Configuration

Environment variables:

- `ANTHROPIC_API_KEY`: required for Anthropic
- `MINI_CLAUDE_API_KEY`: generic provider key
- `MINI_CLAUDE_PROVIDER`: defaults to `anthropic`; supports `anthropic`, `moonshot`, `kimi`, and `openai`
- `MINI_CLAUDE_BASE_URL`: optional OpenAI-compatible base URL
- `MINI_CLAUDE_MODEL`: defaults by provider
- `MINI_CLAUDE_MAX_TOKENS`: defaults to `4096`
- `MINI_CLAUDE_SANDBOX`: defaults to `workspace-write`
- `MINI_CLAUDE_ALLOWED_COMMANDS`: optional command prefix allowlist

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

# Implementation Details

Mini Claude Code is a compact reference implementation of a coding agent loop.

## Runtime

- Language: Node.js ESM
- Minimum Node version: 20
- Runtime dependencies: none
- API: Anthropic Messages API or OpenAI-compatible chat completions
- Entry point: `src/index.js`

## Module Layout

- `src/index.js`: CLI bootstrapping, REPL loop, token accounting, and high-level orchestration
- `src/config.js`: environment variables, CLI flags, provider defaults, and workspace/session paths
- `src/model.js`: Anthropic and OpenAI-compatible provider adapters, streaming parsers, and token normalization
- `src/tools.js`: local tool implementations, task planning, sub-agent delegation, and command sandboxing
- `src/toolSchemas.js`: tool schemas sent to the model
- `src/session.js`: persistent session load/save and state restoration
- `src/skills.js`: skill discovery, matching, and hidden skill-context injection
- `src/ui.js`: terminal spinner helpers

## Conversation Loop

The CLI restores a persistent `messages` array for the active session, defaulting to `.mini-claude-code/sessions/default.json`.

For each user prompt:

1. Push `{ role: "user", content: text }`.
2. Save the session.
3. Call the configured provider with:
   - `system` prompt
   - prior messages
   - tool schemas
   - configured model
   - streaming enabled
4. Stream assistant `text` blocks to stdout as deltas arrive.
5. Save the completed assistant message.
6. Execute any assistant `tool_use` blocks locally.
7. Push one user message containing `tool_result` blocks.
8. Save the session and repeat until the assistant returns no tool calls.

Use `/new` to clear the active conversation, plan, skill state, and token totals.

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

The adapter also normalizes token usage into `{ input, output, total }`. During streaming calls, assistant text is printed as the provider emits deltas. When the call finishes, the `Thinking` status line shows the current call's token usage plus updated session totals when the provider reports usage. Model calls are aborted after `MINI_CLAUDE_TIMEOUT_MS` milliseconds, defaulting to 120 seconds.

### Streaming

Anthropic streaming is parsed from Server-Sent Events:

- `content_block_start` creates internal text or tool-use blocks
- `text_delta` is written directly to stdout and appended to the current text block
- `input_json_delta` is accumulated until the tool-use block closes
- `message_start` and `message_delta` provide token usage

OpenAI-compatible streaming is parsed from chat completion chunks:

- `delta.content` is written directly to stdout
- `delta.tool_calls` is accumulated by tool-call index
- `delta.reasoning_content` is preserved for providers such as Moonshot / Kimi
- `stream_options.include_usage` is requested, with a fallback retry for providers that reject it

Sub-agent calls intentionally remain non-streaming so internal adviser output does not appear directly in the main terminal transcript.

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

This gives the model enough structure to handle multi-step tasks without adding a database or background scheduler. The current plan is saved in the active session file.

## Multi-Agent Delegation

The `delegate_agent` tool makes a second Anthropic call with a specialized system prompt and no tools.

Available roles:

- `planner`: breaks work into steps and highlights risk
- `implementer`: proposes concrete code edits and commands
- `reviewer`: looks for bugs, missing tests, and unsafe assumptions
- `tester`: proposes validation steps

Sub-agents are intentionally read-only advisers. They cannot inspect the filesystem themselves, so the main assistant must pass relevant snippets or logs as `context`.

## Skills

Skills are loaded at startup from `skills/*/SKILL.md`.

The loader supports simple YAML-like frontmatter:

- `name`
- `description`

The body of the file is treated as instructions.

For each user prompt, the CLI tokenizes the prompt and scores it against each skill's name and description. Up to two matching skills are injected before the user message as hidden contextual guidance.

Each skill is injected at most once per session. This keeps recurring task prompts from repeatedly adding the same `SKILL.md` content to the conversation history.

This is a minimal approximation of a production skill system:

- No embeddings
- No remote marketplace
- No recursive asset loading
- No explicit enable/disable registry
- No long-term skill memory

It is enough for small project-local workflows and for demonstrating automatic skill routing.

## Persistent Sessions

Session files are JSON documents under:

```text
.mini-claude-code/sessions/<session>.json
```

The default session name is `default`. It can be changed with either:

```bash
npm start -- --session=my-feature
```

or:

```bash
MINI_CLAUDE_SESSION=my-feature npm start
```

The saved payload contains:

- provider and model metadata
- workspace path
- conversation messages
- active skill names
- current task plan
- token totals

API keys are never written to session files. The local `.mini-claude-code/` directory is listed in `.gitignore`.

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

The result is line-numbered and token-conscious:

- `start_line`: optional 1-based start line
- `end_line`: optional inclusive end line
- `max_chars`: optional output character cap

By default, `read_file` returns at most `MINI_CLAUDE_READ_MAX_CHARS` characters, defaulting to 12,000. Truncated results include a continuation hint with the next line range.

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

### `list_skills`

Lists loaded skills and their descriptions.

## Workspace Boundary

All file paths go through `resolveInsideWorkspace`.

The function resolves a requested path against `process.cwd()` and rejects any path that escapes the workspace via `..` or an absolute path outside the root.

This protects the common case of accidental edits outside the current project. Command execution also has an OS-level sandbox on macOS.

## Sandbox Modes

Mini Claude Code supports an application policy sandbox:

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

## System Command Sandbox

On macOS, `run_command` is wrapped with `/usr/bin/sandbox-exec` by default when `MINI_CLAUDE_SANDBOX=workspace-write`.

The generated profile allows normal process behavior, but denies file writes unless the target is:

- the current workspace
- `/private/tmp`
- `/tmp`
- `/private/var/folders`
- `/dev/null`

This means a command like `echo test > ../outside.txt` is blocked by the operating system even if the shell command itself starts successfully.

System sandbox behavior is controlled with:

```bash
MINI_CLAUDE_SYSTEM_SANDBOX=auto npm start
MINI_CLAUDE_SYSTEM_SANDBOX=on npm start
MINI_CLAUDE_SYSTEM_SANDBOX=off npm start
```

Modes:

- `auto` (default): enable `sandbox-exec` on macOS in `workspace-write` mode
- `on`: require the system sandbox and fail command execution on unsupported platforms
- `off`: use only the application-level checks

The system sandbox currently protects `run_command`. The `write_file` tool is implemented inside the Node process and continues to use strict workspace path resolution.

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
- `MINI_CLAUDE_SESSION`: defaults to `default`
- `MINI_CLAUDE_SANDBOX`: defaults to `workspace-write`
- `MINI_CLAUDE_SYSTEM_SANDBOX`: defaults to `auto`
- `MINI_CLAUDE_ALLOWED_COMMANDS`: optional command prefix allowlist
- `MINI_CLAUDE_READ_MAX_CHARS`: defaults to `12000`

CLI flags:

- `--yes` or `-y`: auto-approve writes and commands
- `--session <name>` or `--session=<name>`: choose a persistent session file
- `--system-sandbox <auto|on|off>` or `--system-sandbox=<auto|on|off>`: control OS-level command sandboxing

## Deliberate Omissions

This project is intentionally minimal. It does not yet include:

- Git-aware patch generation
- Multi-file diff preview
- Structured approvals
- MCP support
- Web search
- Background task management
- Skill asset loading and marketplace installation

Those are natural next steps if you want to evolve it from a teaching implementation into a practical coding assistant.

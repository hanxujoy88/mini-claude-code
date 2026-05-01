# Persistent Sessions

## Overview

Persistent sessions save conversation state to disk and restore it on startup.

## What It Enables

- Continue a prior conversation after restarting the CLI.
- Preserve active skills, task plan state, and token totals.
- Use named sessions for different workstreams.

## How To Use

Default session:

```bash
npm start
```

Named session:

```bash
npm start -- --session=my-feature
```

Clear the active session:

```text
/new
```

## Implementation

- Session store: `src/session.js`
- Session path config: `src/config.js`
- Restore and save calls: `src/index.js`

## Storage

Sessions are stored under:

```text
.mini-claude-code/sessions/<session>.json
```

API keys are not written into session files.


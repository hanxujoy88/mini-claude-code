# Automatic History Compaction

## Overview

Automatic history compaction summarizes older conversation messages once the serialized history grows beyond a configured threshold.

## What It Enables

- Longer sessions without unbounded context growth.
- Keeps recent messages verbatim while preserving older durable context as a summary.
- Avoids starting retained history with tool-result messages, which would break provider transcript shape.

## Configuration

```bash
MINI_CLAUDE_HISTORY_COMPACT_AFTER_CHARS=80000
MINI_CLAUDE_HISTORY_COMPACT_KEEP_MESSAGES=12
```

Disable compaction:

```bash
MINI_CLAUDE_HISTORY_COMPACT_AFTER_CHARS=0
```

## Implementation

- Compaction decision and summary rewrite: `src/history.js`
- Trigger points before model calls: `src/index.js`
- Summary model call: `src/history.js`

## Limits

Compaction uses a model call, so it costs tokens. Summary quality depends on the model.


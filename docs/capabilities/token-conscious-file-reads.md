# Token-Conscious File Reads

## Overview

`read_file` is designed to avoid dumping large files into context by default.

## What It Enables

- Read specific line ranges with `start_line` and `end_line`.
- Limit returned characters with `max_chars`.
- Receive line-numbered output.
- Get continuation hints when a result is truncated.

## Tool

```json
{
  "path": "src/index.js",
  "start_line": 120,
  "end_line": 220,
  "max_chars": 8000
}
```

## Implementation

- Tool schema: `src/toolSchemas.js`
- File formatting and truncation: `src/tools.js`
- Default limit: `MINI_CLAUDE_READ_MAX_CHARS` in `src/config.js`

## Limits

The tool reads UTF-8 text files. Binary files are not specially handled.


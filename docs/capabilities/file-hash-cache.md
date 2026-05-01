# File Hash Cache

## Overview

The file hash cache reduces repeated file-read token cost by letting the model prove it already has the latest file contents.

## What It Enables

- Every `read_file` response includes a `sha256` hash.
- Later reads can pass `known_hash`.
- If the file is unchanged, Mini Claude Code returns metadata only and omits file contents.

## Tool Example

First read:

```json
{
  "path": "package.json"
}
```

Later read:

```json
{
  "path": "package.json",
  "known_hash": "sha256:<previous-hash>"
}
```

Force content even when unchanged:

```json
{
  "path": "package.json",
  "known_hash": "sha256:<previous-hash>",
  "force": true
}
```

## Implementation

- Hash generation: `src/tools.js`
- Tool schema fields: `src/toolSchemas.js`
- System prompt hint: `src/index.js`

## Limits

This is a tool-level cache protocol, not a global file-content database. The model must pass the previous hash to benefit.


# Skills

## Overview

Skills are local instruction files that Mini Claude Code can auto-select for matching user requests.

## What It Enables

- Project-local workflows and style guidance.
- Reusable task instructions without hardcoding everything into the system prompt.
- Token-conscious injection: each skill is injected only once per session.

## How To Add A Skill

Create:

```text
skills/<skill-name>/SKILL.md
```

Optional frontmatter:

```md
---
name: docs-writer
description: Use when writing README files, tutorials, changelogs, or technical explanations.
---
```

## Implementation

- Skill loading: `src/skills.js`
- Skill matching: `src/skills.js`
- Injection into message history: `src/index.js`

## Limits

Matching is lexical and lightweight. There are no embeddings, marketplace installs, recursive asset loading, or remote skill registry.


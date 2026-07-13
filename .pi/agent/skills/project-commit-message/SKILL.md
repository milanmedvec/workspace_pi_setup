---
name: project-commit-message
description: Generates this project's short ticket-prefixed commit message from staged changes. Use when the user asks to create or suggest a commit message for a ticket.
---

# Project Commit Message

Generate a commit message that matches the recent project style.

## Required argument

The skill must be invoked with exactly one ticket id argument:

```bash
/skill:project-commit-message 25553
/skill:project-commit-message '#25553'
```

Normalize the argument to a leading-hash ticket id and output the final commit subject as:

```text
#<ticket_id> - <message>
```

## Staged diff hook

Before writing the message, run the hook from the repository root:

```bash
.pi/skills/project-commit-message/scripts/staged-diff-hook.sh <ticket_id>
```

The hook checks `git diff --staged` from the git root, excludes `src/__generated__/**`, validates the ticket id argument, and prints only relevant staged changes.

If the hook reports no relevant staged changes, do not invent a message; tell the user there are no non-generated staged changes to summarize.

## Recent commit style analysis

Last 10 commit subjects in this repository show this style:

- `sync with gql`
- `sync with gql`
- `#25553 - add settlement return for edit flow`
- `#25553 - add settlement return for edit flow`
- `#25553 - add settlement return for edit flow`
- `fix`
- `premium features hidden`
- `lint fix`
- `add handover measuring photo lightbox`
- `gql sync`

Use these conventions:

- Single-line subject only.
- Lowercase English.
- Short descriptive phrase, usually 3-8 words.
- No conventional-commit prefix (`feat:`, `fix:`, etc.).
- No trailing period.
- Prefer concise verbs used in the project: `add`, `fix`, `update`, `remove`, `hide`, `sync`.
- For this skill, always include the ticket prefix: `#<ticket_id> - ...`.
- Do not escape the `#` character.

## Output

Return only the final commit subject unless the user explicitly asks for alternatives or explanation.

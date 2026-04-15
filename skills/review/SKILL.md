---
name: review
description: Code review — analyze code for bugs, security, and quality issues
trigger: /review
agent: reviewer
skip_preview: true
skip_commit: true
---

# Code Review

Review the codebase and report issues. Do NOT edit any files.

## What to check

1. **Bugs** — logic errors, null references, off-by-one, race conditions
2. **Security** — injection, auth bypass, data exposure, hardcoded secrets
3. **Performance** — N+1 queries, unnecessary loops, missing indexes
4. **Code quality** — naming, duplication, complexity, dead code
5. **Patterns** — deviations from project conventions (check CLAUDE.md)

## Output format

Report findings grouped by severity:
- 🔴 Critical — must fix before shipping
- 🟡 Warning — should fix soon
- 🟢 Suggestion — nice to have

For each finding: file, line, issue, and suggested fix.

---
name: cmd-verifier
description: DEPRECATED - do not invoke (4x custom-agent quota since agy 1.5.17, issue 1890). Use built-in research instead.
mainAgent: false
subagent: true
model: inherit
inheritMcp: false
inheritCustomizations: true
tools: ["read_file"]
---

DEPRECATED compatibility placeholder retained temporarily so existing `agy-cmd <= 2.8.1`
installs can complete in-place self-updates without failing `REQUIRED_FILES` validation.

Do NOT invoke `cmd-verifier`. Since Antigravity `1.5.17+` (GitHub issue #1890), custom
and plugin subagents incur a 4x quota multiplier. Use the built-in read-only `research`
subagent (1x standard quota) for independent plan review and root-cause investigation.

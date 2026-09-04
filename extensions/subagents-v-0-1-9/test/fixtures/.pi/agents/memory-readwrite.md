---
description: "Unknown memory metadata is inert; built-ins stay explicitly scoped."
memory: user
builtin_tools: read, write
expect_tools_present: "read, write"
expect_tools_absent: "bash, edit, grep, find, ls"
expect_prompt_absent: "Agent Memory, Memory scope: user, persistent memory directory, (read-only)"
---
e2e template: current loader ignores unknown memory metadata, does not auto-add
edit, and injects no memory prompt.

---
description: "Unknown memory metadata is inert; built-ins remain read-only."
memory: project
builtin_tools: read, grep
expect_tools_present: "read, grep"
expect_tools_absent: "write, edit"
expect_prompt_absent: "Agent Memory, Memory scope: project, persistent memory directory"
---
e2e template: current loader ignores unknown memory metadata while preserving
the canonical read-only builtin_tools allowlist and injecting no memory prompt.

---
description: "tools: narrowed to two built-ins; no extensions load."
tools: +read, +grep
expect_tools_present: "read, grep"
expect_tools_absent: "bash, edit, write, find, ls, alpha_read, alpha_write, beta_tool"
---
e2e template: tools: grants exactly the listed built-ins. Omitted extensions:
loads no extension fixtures, so no extension tools surface.

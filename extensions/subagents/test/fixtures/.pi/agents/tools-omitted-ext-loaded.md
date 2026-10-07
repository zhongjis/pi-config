---
description: "Omitted tools: grants nothing, even with extensions loaded."
extensions: "+ext-alpha, +ext-beta"
expect_tools_absent: "read, bash, edit, write, grep, find, ls, alpha_read, alpha_write, beta_tool"
---
e2e template: loading an extension grants none of its tools; with tools:
omitted no built-in or extension tool is active.

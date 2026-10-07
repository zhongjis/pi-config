---
description: "isolated:true loads no extensions; granted built-ins only."
isolated: true
extensions: "+ext-alpha, +ext-beta"
tools: "+@builtin, +alpha_read, +alpha_write"
expect_tools_present: "read, bash, edit, write, grep, find, ls"
expect_tools_absent: "alpha_read, alpha_write, beta_tool"
---
e2e template: isolated:true loads no extensions even when extensions: and
tools: explicitly select alpha.

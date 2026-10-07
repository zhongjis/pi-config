---
description: "Removing @builtin leaves loaded extension tools active."
extensions: "+ext-alpha, +ext-beta"
tools: "+@all, -@builtin"
expect_tools_present: "alpha_read, alpha_write, beta_tool"
expect_tools_absent: "read, bash, edit, write, grep, find, ls"
---
e2e template: -@builtin removes every built-in while the loaded extensions'
tools stay granted.

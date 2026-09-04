---
description: "isolated:true forces built-ins only, overriding extension policy."
isolated: true
extensions: "./ext-alpha.mjs, ./ext-beta.mjs"
extension_tools: "alpha_read, alpha_write"
expect_tools_present: "read, bash, edit, write, grep, find, ls"
expect_tools_absent: "alpha_read, alpha_write, beta_tool"
---
e2e template: isolated:true disables extension tools even when extensions and
extension_tools explicitly select alpha.

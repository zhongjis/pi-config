---
description: "builtin_tools:none leaves loaded extension tools active."
extensions: "./ext-alpha.mjs, ./ext-beta.mjs"
builtin_tools: none
expect_tools_present: "alpha_read, alpha_write, beta_tool"
expect_tools_absent: "read, bash, edit, write, grep, find, ls"
---
e2e template: builtin_tools:none removes all built-ins while omitted
extension_tools allows every loaded extension tool.

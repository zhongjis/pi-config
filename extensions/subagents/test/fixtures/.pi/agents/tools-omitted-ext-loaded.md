---
description: "Omitted builtin_tools and extension_tools use both defaults."
extensions: "./ext-alpha.mjs, ./ext-beta.mjs"
expect_tools_present: "read, bash, edit, write, grep, find, ls, alpha_read, alpha_write, beta_tool"
---
e2e template: omitted builtin_tools yields all built-ins; omitted extension_tools
surfaces every tool from the explicitly loaded extensions.

---
description: "Omitted extension_tools surfaces all loaded extension tools."
extensions: "./ext-alpha.mjs, ./ext-beta.mjs"
expect_tools_present: "read, alpha_read, alpha_write, beta_tool"
---
e2e template: omitting extension_tools surfaces every loaded extension tool
alongside the default built-ins.

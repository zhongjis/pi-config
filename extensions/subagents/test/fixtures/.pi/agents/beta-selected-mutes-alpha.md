---
description: "Allows beta_tool; the loaded alpha extension is muted."
extensions: "./ext-alpha.mjs, ./ext-beta.mjs"
extension_tools: beta_tool
expect_tools_present: "read, beta_tool"
expect_tools_absent: "alpha_read, alpha_write"
---
e2e template: the extension_tools allowlist selects beta_tool and mutes the
other loaded extension's tools.

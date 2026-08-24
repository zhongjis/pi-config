---
description: "Allows alpha_read while excluding alpha_write and beta_tool."
extensions: "./ext-alpha.mjs, ./ext-beta.mjs"
extension_tools: alpha_read
expect_tools_present: "read, alpha_read"
expect_tools_absent: "alpha_write, beta_tool"
---
e2e template: an explicit extension_tools allowlist exposes alpha_read while
the other loaded extension tools remain muted.

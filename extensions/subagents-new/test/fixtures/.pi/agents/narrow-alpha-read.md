---
description: "Narrows loaded extension tools to alpha_read."
extensions: "./ext-alpha.mjs, ./ext-beta.mjs"
extension_tools: alpha_read
expect_tools_present: "read, alpha_read"
expect_tools_absent: "alpha_write, beta_tool"
---
e2e template: extension_tools narrows the loaded extension tools to alpha_read;
alpha_write and beta_tool remain muted.

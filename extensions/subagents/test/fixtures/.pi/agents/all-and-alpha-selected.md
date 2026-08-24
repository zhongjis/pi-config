---
description: "Loads alpha+beta, allows only alpha tools."
extensions: "./ext-alpha.mjs, ./ext-beta.mjs"
extension_tools: "alpha_read, alpha_write"
expect_tools_present: "read, bash, alpha_read, alpha_write"
expect_tools_absent: "beta_tool"
---
e2e template: extension_tools allows alpha's tools while beta remains loaded
but muted.

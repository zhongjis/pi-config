---
description: "An extension_tools entry cannot resurrect an excluded extension."
extensions: "./ext-alpha.mjs, ./ext-beta.mjs"
exclude_extensions: ext-beta.mjs
extension_tools: beta_tool
expect_tools_present: "read"
expect_tools_absent: "beta_tool, alpha_read, alpha_write"
---
e2e template: exclude_extensions prevents beta from loading, so its allowed
tool cannot surface. Alpha loads but remains muted by extension_tools.

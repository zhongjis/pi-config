---
description: "Loads alpha+beta, excludes beta via exclude_extensions."
extensions: "./ext-alpha.mjs, ./ext-beta.mjs"
exclude_extensions: ext-beta.mjs
expect_tools_present: "read, alpha_read, alpha_write"
expect_tools_absent: "beta_tool"
---
e2e template: exclude_extensions removes beta after the include set is computed;
alpha's tools surface because extension_tools is omitted.

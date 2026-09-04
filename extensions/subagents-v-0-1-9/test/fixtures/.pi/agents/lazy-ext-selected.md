---
description: "Allows a lazy extension's session_start tool."
extensions: "./ext-lazy.mjs, ./ext-alpha.mjs"
extension_tools: lazy_tool
expect_tools_present: "read, bash, lazy_tool"
expect_tools_absent: "alpha_read, alpha_write"
---
e2e template: lazy_tool is allowed before it exists, then scope is re-derived
when the extension registers it during session_start.

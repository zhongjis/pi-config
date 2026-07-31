---
description: "A lazy tool omitted from extension_tools stays muted."
extensions: "./ext-lazy.mjs, ./ext-alpha.mjs"
extension_tools: "alpha_read, alpha_write"
expect_tools_present: "read, bash, alpha_read, alpha_write"
expect_tools_absent: "lazy_tool"
---
e2e template: ext-lazy loads and registers lazy_tool during session_start, but
the extension_tools allowlist keeps it inactive.

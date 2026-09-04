---
description: "A tool registered at session_start reaches the subagent (#125)."
extensions: "./ext-lazy.mjs"
expect_tools_present: "read, bash, lazy_tool"
---
e2e template: with extension_tools omitted, lazy_tool registers during
session_start and reaches the active set.

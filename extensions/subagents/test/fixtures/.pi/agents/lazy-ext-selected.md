---
description: "Grants a lazy extension's session_start tool."
extensions: "+ext-lazy, +ext-alpha"
tools: "+read, +bash, +lazy_tool"
expect_tools_present: "read, bash, lazy_tool"
expect_tools_absent: "alpha_read, alpha_write"
---
e2e template: lazy_tool is granted before it exists, then scope is re-derived
when the extension registers it during session_start.

---
description: "A lazy tool missing from tools: stays muted."
extensions: "+ext-lazy, +ext-alpha"
tools: "+read, +bash, +alpha_read, +alpha_write"
expect_tools_present: "read, bash, alpha_read, alpha_write"
expect_tools_absent: "lazy_tool"
---
e2e template: ext-lazy loads and registers lazy_tool during session_start, but
the tools: rules keep it inactive.

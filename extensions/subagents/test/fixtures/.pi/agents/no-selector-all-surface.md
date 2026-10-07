---
description: "tools: +@all surfaces every loaded extension tool."
extensions: "+ext-alpha, +ext-beta"
tools: "+@all"
expect_tools_present: "read, alpha_read, alpha_write, beta_tool"
---
e2e template: tools: +@all surfaces every loaded extension tool alongside the
built-ins.

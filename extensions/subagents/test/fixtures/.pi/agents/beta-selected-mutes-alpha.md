---
description: "Grants beta_tool; the loaded alpha extension is muted."
extensions: "+ext-alpha, +ext-beta"
tools: "+@builtin, +beta_tool"
expect_tools_present: "read, beta_tool"
expect_tools_absent: "alpha_read, alpha_write"
---
e2e template: tools: grants beta_tool and mutes the other loaded extension's
tools.

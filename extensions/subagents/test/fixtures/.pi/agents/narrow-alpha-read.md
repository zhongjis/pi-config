---
description: "Narrows loaded extension tools to alpha_read."
extensions: "+ext-alpha, +ext-beta"
tools: "+read, +alpha_read"
expect_tools_present: "read, alpha_read"
expect_tools_absent: "alpha_write, beta_tool"
---
e2e template: tools: narrows the loaded extension tools to alpha_read;
alpha_write and beta_tool remain muted.

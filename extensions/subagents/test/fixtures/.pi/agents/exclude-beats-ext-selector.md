---
description: "A tools: grant cannot resurrect an extension that did not load."
extensions: "+ext-alpha, +ext-beta, -ext-beta"
tools: "+read, +beta_tool"
expect_tools_present: "read"
expect_tools_absent: "beta_tool, alpha_read, alpha_write"
---
e2e template: the later -ext-beta rule keeps beta from loading, so its granted
tool cannot surface. Alpha loads but grants nothing.

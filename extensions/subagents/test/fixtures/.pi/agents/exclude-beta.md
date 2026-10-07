---
description: "Loads alpha+beta, then removes beta with a later rule."
extensions: "+ext-alpha, +ext-beta, -ext-beta"
tools: "+@all"
expect_tools_present: "read, alpha_read, alpha_write"
expect_tools_absent: "beta_tool"
---
e2e template: the last matching extensions: rule wins, so beta does not load;
alpha's tools surface through tools: +@all.

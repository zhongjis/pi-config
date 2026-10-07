---
description: "Omitted extensions: — no extension tools at all."
tools: "+@all"
expect_tools_present: "read, bash, edit, write, grep, find, ls"
expect_tools_absent: "alpha_read, alpha_write, beta_tool"
---
e2e template: no extensions load, so tools: +@all activates only built-in tools.

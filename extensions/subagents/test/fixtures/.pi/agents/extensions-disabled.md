---
description: "extensions:false — no extension tools at all."
extensions: false
expect_tools_present: "read, bash, edit, write, grep, find, ls"
expect_tools_absent: "alpha_read, alpha_write, beta_tool"
---
e2e template: extensions are disabled, so only the default built-in tools are active.

---
description: "Loads alpha+beta, grants only alpha tools."
extensions: "+ext-alpha, +ext-beta"
tools: "+@builtin, +alpha_read, +alpha_write"
expect_tools_present: "read, bash, alpha_read, alpha_write"
expect_tools_absent: "beta_tool"
---
e2e template: tools: grants alpha's tools while beta remains loaded but
muted.

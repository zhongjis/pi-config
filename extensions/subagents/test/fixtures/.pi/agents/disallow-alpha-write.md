---
description: "Grants alpha's group minus alpha_write; beta stays muted."
extensions: "+ext-alpha, +ext-beta"
tools: "+@builtin, +@ext-alpha, -alpha_write"
expect_tools_present: "read, alpha_read"
expect_tools_absent: "alpha_write, beta_tool"
---
e2e template: an extension group grant followed by a single-tool removal
exposes alpha_read while alpha_write and beta_tool remain muted.

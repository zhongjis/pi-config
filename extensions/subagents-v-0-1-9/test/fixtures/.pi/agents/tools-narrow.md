---
description: "builtin_tools narrowed to two built-ins; extensions default true."
builtin_tools: read, grep
expect_tools_present: "read, grep"
expect_tools_absent: "bash, edit, write, find, ls, alpha_read, alpha_write, beta_tool"
---
e2e template: builtin_tools narrows to exactly the listed built-ins. No
extension fixtures are explicitly loaded, so no extension tools surface.

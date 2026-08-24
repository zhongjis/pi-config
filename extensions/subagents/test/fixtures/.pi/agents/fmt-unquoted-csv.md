---
description: "builtin_tools value format: unquoted CSV."
builtin_tools: read, grep, find
expect_tools_present: "read, grep, find"
expect_tools_absent: "bash, edit, write, ls"
---
e2e template (format check 1/3): unquoted CSV. Must be equivalent to the quoted
and array forms.

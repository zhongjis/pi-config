---
description: "builtin_tools value format: YAML flow array."
builtin_tools: [read, grep, find]
expect_tools_present: "read, grep, find"
expect_tools_absent: "bash, edit, write, ls"
---
e2e template (format check 3/3): YAML array coercion must yield the same active
built-in tool set as the CSV forms.

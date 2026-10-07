---
description: "Minimal agent — only description and body; every other field omitted."
expect_tools_absent: "read, bash, edit, write, grep, find, ls, alpha_read, alpha_write, beta_tool"
---
A minimal agent. Omitted `tools:` grants no tools and omitted `extensions:`
loads no extensions, so nothing is active. expect_* are test-harness
annotations and are ignored by the agent loader.

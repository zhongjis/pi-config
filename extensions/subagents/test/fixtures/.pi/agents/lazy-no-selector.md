---
description: "A tool registered at session_start reaches the subagent (#125)."
extensions: "+ext-lazy"
tools: "+read, +bash, +@ext-lazy"
expect_tools_present: "read, bash, lazy_tool"
---
e2e template: the @ext-lazy group grants lazy_tool, which registers during
session_start and reaches the active set.

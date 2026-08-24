---
description: "preload_skills injects a named skill into the system prompt."
preload_skills: probe-skill
expect_tools_present: "read"
expect_prompt_contains: "Preloaded Skill: probe-skill, SKILL_BODY_MARKER"
---
A skill-preloading agent. preload_skills injects the probe-skill fixture into
the real session's system prompt.

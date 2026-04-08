# Agent Modes / Plan Mode Follow-ups

- [x] Remove more of the old fallback logic from `extensions/plan-mode/` so shared `agent-modes` owns the restriction layer
- [x] Make `/agent-mode plan` the only entry for entering plan mode; keep `/plan` as the planner runner inside that mode
- [ ] Make the mode tab strip more explicit and compact
- [ ] Add direct per-mode shortcuts like `Ctrl+1`, `Ctrl+2`, `Ctrl+3`, etc.
- [x] Move more planning state behind the shared agent-mode API/events bridge

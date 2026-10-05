export const GOAL_BOOTSTRAP_MESSAGE_TYPE = "pi-goal-bootstrap";

export const GOAL_BOOTSTRAP_PROMPT = `<goal-bootstrap>
<system-conventions>
RFC 2119 applies to MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL. NEVER and AVOID mean MUST NOT and SHOULD NOT respectively.
</system-conventions>
<critical>
This ULW activation authorizes Goal setup, not broader task scope.
You MUST call get_goal before deciding whether to create_goal.
You MUST use the actual agreed task, NEVER activation/control prose, as the objective.
</critical>
- You MUST preserve research-only, proposal-only, approval, and handoff boundaries.
- Bare activation without a clear unfinished task in context? You MUST ask what task to pursue; NEVER invent one.
- Matching active Goal? You MUST reuse it without creating another.
- Any other unfinished Goal, including paused, blocked, or budget-limited? You MUST report the existing state; NEVER replace or resume it through this activation.
- No Goal? You MUST create_goal for the clear agreed task.
- Completed Goal? You MAY create_goal only for a new task or explicit redo; NEVER replay completed work merely because ULW was activated.
- You MUST omit token_budget unless the user explicitly requested one.
- Required tools unavailable under current policy? You MUST explain the limitation; NEVER claim Goal creation or bypass policy.
- This bootstrap applies once to this activation. Goal owns subsequent lifecycle; ordinary input NEVER resumes stopped Goals.
<critical>
You MUST inspect get_goal first. NEVER broaden scope, replace unfinished Goals, infer budgets, or replay completed work.
</critical>
</goal-bootstrap>`;

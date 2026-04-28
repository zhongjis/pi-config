# Autoresearch Ideas: better-bash-tool cwd optimization

## Completed
- **Fixed broken symlink**: `~/.pi/agent/extensions/better-bash-tool.ts` → stale file. After running `install.sh`, proper directory symlink created. This was the ROOT CAUSE — extension never loaded.
- **Strengthened promptGuidelines**: CRITICAL/NEVER framing, git-specific GOOD/BAD examples, MUST NOT in command description, ALWAYS in cwd description. → 100% cd-free across haiku/sonnet/opus.

## Future ideas
- **Runtime cd detection**: In `execute()`, detect `cd ` at start of command string and either warn, auto-rewrite (strip cd, set cwd), or reject. Would catch any remaining cd usage at runtime.
- **Metrics telemetry**: Log cwd vs cd usage to session metadata for ongoing monitoring across real sessions.
- **install.sh validation**: Add a check in install.sh that verifies symlinks point to valid targets after creation, catching the stale symlink class of bug.
- **Non-Anthropic model testing**: Gemini and GPT models didn't generate enough bash calls in the test scenarios. May need different prompt patterns or longer scenarios to properly test those models.
- **Subshell pattern**: Some commands like `(cd /path && make)` use subshells. The current regex might miss these. Add `\(cd ` pattern detection.
- **Integration test**: Write a pi-test-harness integration test that verifies the model uses cwd when given a directory-changing prompt. More deterministic than live sessions.

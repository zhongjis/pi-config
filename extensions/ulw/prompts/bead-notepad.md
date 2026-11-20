Read the assigned bead's notepad with `bd show "$ORCH_BEAD"` before starting or resuming. Use its notes field as one living document, about one page, with Plan, Now, and Findings (with file:line refs) sections. You are its single writer; replace the whole notes field at milestones.

Pass the complete Markdown literally through a quoted heredoc:

```sh
bd update "$ORCH_BEAD" --notes "$(cat <<'ULW_NOTEPAD_EOF'
## Plan
<plan>
## Now
<current work>
## Findings
<findings with file:line refs>
ULW_NOTEPAD_EOF
)"
```

Choose a delimiter that does not occur as a line in the notepad. Keep the delimiter quoted so backticks, dollar signs, and shell substitutions stay literal.

If context is lost, read the bead and resume. Keep event-like milestones in comments with `bd comments add "$ORCH_BEAD" 'event=report ...'`, not notes. Keep requested deliverables at their required destinations.

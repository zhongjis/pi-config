# write-tool-visual

Visual override for the built-in `write` tool with improved call and result rendering.

## What It Does

- Overrides the built-in `write` tool's rendering (execution logic is unchanged)
- Call header shows: filename in accent color + line count in dim
- Result rendering: "✓ Written" on success, error message on failure, "Writing..." during partial execution

## Tools

### `write`

Same as built-in write tool (file creation/overwrite). Only rendering is customized.

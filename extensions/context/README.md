# context

Interactive context usage dashboard showing token breakdown by category.

## What It Does

- Displays a visual context usage overview with a 5×10 block grid and detailed breakdown
- Estimates token allocation across categories: System Prompt, System Tools, Tool Calls, Tool Results, Messages, Summaries, Other, Available
- Shows model, session ID, context window size, and message/tool counts
- Color-coded usage: green (<70%), yellow (70-90%), red (>90%)
- Side-by-side grid + detail layout on wide terminals; stacked on narrow terminals
- Falls back to plain text output when no UI is available

## Commands

- `/context` — Show the context usage dashboard (press any key to dismiss)

# extensions/lib

Shared utilities for pi extensions. Import via `../lib/index.js`.

## Modules

| File | What |
|------|------|
| `model.ts` | Parse and resolve model spec strings (`provider/model:level,fallback`) |
| `thinking-level.ts` | `ThinkingLevel` type, validation, normalization |
| `clipboard.ts` | System clipboard read/write |
| `logger.ts` | Debug logging with `--debug` flag support |
| `status.ts` | Status bar helpers |
| `utils.ts` | `debounce`, `checkExec`, `notifyError`, `computeLineDiff` |
| `ux.ts` | UX helpers |

## Usage

```ts
import { initLib } from "../lib/index.js";
import { parseModelChain, resolveFirstAvailable } from "../lib/index.js";

export default function myExtension(pi: ExtensionAPI) {
  initLib(pi);  // wire debug logging (idempotent)

  // Parse "anthropic/claude-opus-4-7:high,openai/gpt-5:medium"
  const candidates = parseModelChain(modelStr);
  // → [{ model: "anthropic/claude-opus-4-7", thinkingLevel: "high" }, ...]

  const resolved = resolveFirstAvailable(candidates, ctx.modelRegistry);
  if (resolved) {
    await pi.setModel(resolved.model);
    if (resolved.thinkingLevel) pi.setThinkingLevel(resolved.thinkingLevel);
  }
}
```

## Conventions

- Flat files, no subdirectories (until lib grows large enough to warrant them).
- No extension-specific state — pure functions and types only.
- Re-export everything through `index.ts`.

# Quick Fixes

## Plannotator extension fails to load

**Error:**
```
Failed to load extension ".../plannotator/apps/pi-extension": Cannot find module './generated/checklist.js'
```

**Cause:** The `generated/` directory is `.gitignore`d and requires a build step (`vendor.sh`) that pi's git package installer never runs.

**Fix:**
```bash
cd ~/.pi/agent/git/github.com/backnotprop/plannotator/apps/pi-extension
bash vendor.sh
```

**Note:** This breaks again on every `pi package update`. Upstream fix needed — see [backnotprop/plannotator](https://github.com/backnotprop/plannotator).

## "Refine in Plannotator" fails after plan session

**Error:**
```
Plannotator review could not be started for plan "...". Returning to the post-plan menu.
```

**Cause:** `plannotator.html` and `review-editor.html` are missing from the pi-extension directory. These are built artifacts copied from `apps/hook/dist/` during `bun run build:pi`. Without them, `planHtmlContent` is empty and `startPlanReviewBrowserSession()` throws "unavailable". The `vendor.sh` fix above is necessary but not sufficient — it only vendors the `.ts` modules, not the HTML assets.

**Fix:**
```bash
cd ~/.pi/agent/git/github.com/backnotprop/plannotator
bun install
bun run build:pi
```

This builds the full chain (`review` → `hook` → `pi-extension`) and produces both HTML files. Restart pi afterward — the HTML is loaded once at import time.

**Note:** Same as above, this breaks on every `pi package update` that re-clones the repo.

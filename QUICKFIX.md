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

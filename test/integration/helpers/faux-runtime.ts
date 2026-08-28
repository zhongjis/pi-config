/**
 * Native Pi 0.83 faux model runtime for deterministic, auth-free integration
 * tests. Ported locally (do NOT import from extensions/subagents) so the
 * integration harness has no cross-extension test dependency.
 *
 * Each caller owns an isolated runtime and must call dispose().
 *
 * FAUX MUST BE THE ONLY AVAILABLE MODEL
 * -------------------------------------
 * pi 0.83 drives a turn through the session's ACTIVE model. The faux provider
 * only intercepts calls routed to the faux model, so any extension that swaps
 * the active model away from faux silently bypasses the scripted responses.
 * extensions/modes does exactly this: on session_start / before_agent_start it
 * runs `applyModelFromConfig` → `resolveFirstAvailable(chain, ctx.modelRegistry)`
 * → `pi.setModel(...)`. On a dev machine that model chain resolves (real
 * provider auth from `~/.pi/auth.json` or env vars like `OPENCODE_API_KEY`
 * expose a large catalog), so the session jumps onto a real model and the faux
 * queue is never consumed ("Consumed 0 of N").
 *
 * We make faux the ONLY available model two ways:
 *   1. `authPath`/`modelsStorePath` → hermetic empty files (ignore real creds).
 *   2. Filter `getAvailableSnapshot()` (what `ModelRegistry.getAvailable()`
 *      returns to extensions) down to the faux provider — env-based provider
 *      auth can't be silenced via `create()` options, so this is the reliable
 *      cut. With only faux "available", modes' `resolveFirstAvailable(realChain)`
 *      returns undefined and the session stays on faux.
 * Streaming is unaffected: it resolves the model via `getModel()`/`getProvider()`
 * (not the availability snapshot), and faux is still present in the filtered set.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type FauxProviderHandle,
	fauxProvider,
	type Model,
	type RegisterFauxProviderOptions,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

const FAUX_COMPAT_SEAM_KEY = Symbol.for("pi-config.integration-faux-compat-seam");

export interface FauxModelRuntime {
	faux: FauxProviderHandle;
	model: Model<string>;
	modelRuntime: ModelRuntime;
	dispose(): void;
}

export async function createFauxModelRuntime(
	options: RegisterFauxProviderOptions = {},
): Promise<FauxModelRuntime> {
	const faux = fauxProvider(options);
	Reflect.set(globalThis, FAUX_COMPAT_SEAM_KEY, { api: faux.api, provider: faux.provider });
	// Hermetic, empty credential + models store so no real provider auth leaks in.
	const authDir = mkdtempSync(join(tmpdir(), "pi-faux-auth-"));
	const modelRuntime = await ModelRuntime.create({
		modelsPath: null,
		allowModelNetwork: false,
		authPath: join(authDir, "auth.json"),
		modelsStorePath: join(authDir, "models-store.json"),
	});
	modelRuntime.registerNativeProvider(faux.provider);
	await modelRuntime.refresh({ allowNetwork: false });

	// Restrict the "available" snapshot to the faux provider so model-selecting
	// extensions cannot swap the session off faux (see file header).
	const fauxProviderId = faux.provider.id;
	const runtimeAny = modelRuntime as any;
	const originalSnapshot = runtimeAny.getAvailableSnapshot.bind(modelRuntime);
	runtimeAny.getAvailableSnapshot = () =>
		originalSnapshot().filter((m: Model<string>) => m.provider === fauxProviderId);

	return {
		faux,
		model: faux.getModel(),
		modelRuntime,
		dispose: () => {
			const activeSeam: unknown = Reflect.get(globalThis, FAUX_COMPAT_SEAM_KEY);
			if (typeof activeSeam === "object" && activeSeam !== null && Reflect.get(activeSeam, "api") === faux.api) {
				Reflect.deleteProperty(globalThis, FAUX_COMPAT_SEAM_KEY);
			}
			modelRuntime.unregisterProvider(faux.provider.id);
			rmSync(authDir, { recursive: true, force: true });
		},
	};
}

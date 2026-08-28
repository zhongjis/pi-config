import type { Provider } from "@earendil-works/pi-ai";
import { registerApiProvider, unregisterApiProviders } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const FAUX_COMPAT_SEAM_KEY = Symbol.for("pi-config.integration-faux-compat-seam");

interface FauxCompatSeam {
	api: string;
	provider: Provider;
}

export default function fauxCompatProvider(pi: ExtensionAPI): void {
	const seam = Reflect.get(globalThis, FAUX_COMPAT_SEAM_KEY) as FauxCompatSeam | undefined;
	if (!seam) return;
	const sourceId = `integration-${seam.api}`;
	registerApiProvider({
		api: seam.api,
		stream: seam.provider.stream,
		streamSimple: seam.provider.streamSimple,
	}, sourceId);
	pi.on("session_shutdown", () => unregisterApiProviders(sourceId));
}

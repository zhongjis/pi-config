/**
 * Native Pi 0.83 faux model runtime for deterministic, auth-free tests.
 * Each caller owns an isolated runtime and must call dispose().
 */
import {
  type FauxProviderHandle,
  fauxProvider,
  type Model,
  type RegisterFauxProviderOptions,
} from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";

export { getModel } from "@earendil-works/pi-ai/compat";

export interface FauxModelRuntime {
  faux: FauxProviderHandle;
  model: Model<string>;
  modelRegistry: ModelRegistry;
  modelRuntime: ModelRuntime;
  dispose(): void;
}

export async function createFauxModelRuntime(
  options: RegisterFauxProviderOptions = {},
): Promise<FauxModelRuntime> {
  const faux = fauxProvider(options);
  const modelRuntime = await ModelRuntime.create({
    modelsPath: null,
    allowModelNetwork: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  await modelRuntime.refresh({ allowNetwork: false });

  return {
    faux,
    model: faux.getModel(),
    modelRegistry: new ModelRegistry(modelRuntime),
    modelRuntime,
    dispose: () => modelRuntime.unregisterProvider(faux.provider.id),
  };
}

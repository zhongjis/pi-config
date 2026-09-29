import type { NodeInstance } from "../src/graph/graph-instance-id.js";

/** Maps host-facing instance ids back to the display binding published through `onNodeAdded`. */
export function instanceBindings() {
  const bindings = new Map<string, string>();
  return {
    onNodeAdded: (id: string, _node: unknown, metadata: { instance?: NodeInstance }): void => {
      if (metadata.instance) bindings.set(metadata.instance.instanceId, id);
    },
    binding: (instanceId: string): string => {
      const id = bindings.get(instanceId);
      if (id === undefined) throw new Error(`Unregistered instance ${instanceId}`);
      return id;
    },
  };
}

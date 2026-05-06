import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const baseDir = dirname(fileURLToPath(import.meta.url));

export default function superpowersExtension(pi: ExtensionAPI) {
  pi.on("resources_discover", () => ({
    skillPaths: [join(baseDir, "skills")],
  }));
}

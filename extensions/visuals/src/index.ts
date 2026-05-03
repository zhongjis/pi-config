import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { installFooterVisuals } from "./footer.js";
import { installWriteToolVisual } from "./write-tool.js";

export default function visuals(pi: ExtensionAPI): void {
  installFooterVisuals(pi);
  installWriteToolVisual(pi);
}

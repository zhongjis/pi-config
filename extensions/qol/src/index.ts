import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import installCopySessionId from "./copy-session-id.js";
import installExit from "./exit.js";
import installHeader from "./header.js";
import installPromptUrlWidget from "./prompt-url-widget.js";
import { installFooterVisuals } from "./footer.js";
import { installWriteToolVisual } from "./write-tool-renderer.js";

export default function qol(pi: ExtensionAPI): void {
  installCopySessionId(pi);
  installExit(pi);
  installHeader(pi);
  installPromptUrlWidget(pi);
  installFooterVisuals(pi);
  installWriteToolVisual(pi);
}

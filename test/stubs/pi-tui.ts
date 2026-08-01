const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

export type AutocompleteItem = {
  label?: string;
  value: string;
};
export type Component = any;
export type EditorTheme = any;
export type SettingItem = any;
export type TUI = any;

export const Key = {
  enter: "enter",
  escape: "escape",
  left: "left",
  right: "right",
  tab: "tab",
  up: "up",
  down: "down",
  space: "space",
  shift(key: string) {
    return `shift+${key}`;
  },
  ctrlShift(key: string) {
    return `ctrl+shift+${key}`;
  }
};

export class Box {
  children: unknown[];

  constructor(children: unknown[] = []) {
    this.children = children;
  }

  addChild(child: unknown): void {
    this.children.push(child);
  }
}

export class Container {
  children: unknown[];

  constructor(children: unknown[] = []) {
    this.children = children;
  }

  addChild(child: unknown): void {
    this.children.push(child);
  }

  render(width: number): string[] {
    const lines: string[] = [];
    for (const child of this.children) {
      const childLines = (child as { render(width: number): string[] }).render(width);
      for (const line of childLines) {
        lines.push(line);
      }
    }
    return lines;
  }

  invalidate(): void {
    for (const child of this.children) {
      (child as { invalidate?(): void }).invalidate?.();
    }
  }
}

export class Editor {
  constructor(..._args: unknown[]) {}

  focus(): void {}
}

// Minimal faithful port of @earendil-works/pi-tui/dist/components/input.js —
// single-line text input. Only the behaviour the stub consumers rely on
// (submit/escape routing, printable insertion, backspace) is implemented.
export class Input {
  private value = "";
  private cursor = 0;
  onSubmit?: (value: string) => void;
  onEscape?: () => void;
  focused = false;

  getValue(): string {
    return this.value;
  }

  setValue(value: string): void {
    this.value = value;
    this.cursor = Math.min(this.cursor, value.length);
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.onEscape?.();
      return;
    }
    if (matchesKey(data, "enter") || data === "\n") {
      this.onSubmit?.(this.value);
      return;
    }
    if (matchesKey(data, "backspace")) {
      if (this.cursor > 0) {
        this.value = this.value.slice(0, this.cursor - 1) + this.value.slice(this.cursor);
        this.cursor -= 1;
      }
      return;
    }
    // Reject control characters (C0/DEL/C1); insert printable text at the cursor.
    const hasControlChars = [...data].some((ch) => {
      const code = ch.charCodeAt(0);
      return code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
    });
    if (!hasControlChars) {
      this.value = this.value.slice(0, this.cursor) + data + this.value.slice(this.cursor);
      this.cursor += data.length;
    }
  }

  invalidate(): void {}

  render(width: number): string[] {
    const prompt = "> ";
    const availableWidth = width - prompt.length;
    if (availableWidth <= 0) return [prompt];
    return [prompt + this.value];
  }
}

export class Markdown {
  text: string;

  constructor(text = "") {
    this.text = text;
  }

  setText(text: string): void {
    this.text = text;
  }

  render(width: number): string[] {
    return renderTextLines(this.text, width);
  }

  invalidate(): void {}
}

export class SelectList {
  constructor(..._args: unknown[]) {}

  handleInput(_data: string): void {}
}

export class SettingsList {
  constructor(..._args: unknown[]) {}
}

export class Spacer {
  size: number;

  constructor(size = 1) {
    this.size = size;
  }
}

export class Text {
  text: string;

  constructor(text = "") {
    this.text = text;
  }

  setText(text: string): void {
    this.text = text;
  }

  render(width: number): string[] {
    return renderTextLines(this.text, width);
  }

  invalidate(): void {}
}

function renderTextLines(text: string, width: number): string[] {
  const safeWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  if (safeWidth === 0) return [];

  return text.split(/\r\n?|\n/).flatMap((line) =>
    visibleWidth(line) <= safeWidth ? [line] : wrapTextWithAnsi(line, safeWidth),
  );
}

// ── Ported key parsing from @earendil-works/pi-tui/dist/keys.js ──
// Kitty keyboard-protocol state (the stub never enables it, but the switch
// branches below mirror the real module so behaviour stays faithful).
let _kittyProtocolActive = false;

export function setKittyProtocolActive(active: boolean): void {
  _kittyProtocolActive = active;
}

export function isKittyProtocolActive(): boolean {
  return _kittyProtocolActive;
}

const SYMBOL_KEYS = new Set<string>([
  "`", "-", "=", "[", "]", "\\", ";", "'", ",", ".", "/", "!", "@", "#", "$", "%", "^", "&", "*",
  "(", ")", "_", "+", "|", "~", "{", "}", ":", "<", ">", "?",
]);

const MODIFIERS = { shift: 1, alt: 2, ctrl: 4, super: 8 };
const LOCK_MASK = 64 + 128; // Caps Lock + Num Lock

const CODEPOINTS = { escape: 27, tab: 9, enter: 13, space: 32, backspace: 127, kpEnter: 57414 };
const ARROW_CODEPOINTS = { up: -1, down: -2, right: -3, left: -4 };
const FUNCTIONAL_CODEPOINTS = { delete: -10, insert: -11, pageUp: -12, pageDown: -13, home: -14, end: -15 };

const KITTY_FUNCTIONAL_KEY_EQUIVALENTS = new Map<number, number>([
  [57399, 48], [57400, 49], [57401, 50], [57402, 51], [57403, 52], [57404, 53],
  [57405, 54], [57406, 55], [57407, 56], [57408, 57], [57409, 46], [57410, 47],
  [57411, 42], [57412, 45], [57413, 43], [57415, 61], [57416, 44],
  [57417, ARROW_CODEPOINTS.left], [57418, ARROW_CODEPOINTS.right],
  [57419, ARROW_CODEPOINTS.up], [57420, ARROW_CODEPOINTS.down],
  [57421, FUNCTIONAL_CODEPOINTS.pageUp], [57422, FUNCTIONAL_CODEPOINTS.pageDown],
  [57423, FUNCTIONAL_CODEPOINTS.home], [57424, FUNCTIONAL_CODEPOINTS.end],
  [57425, FUNCTIONAL_CODEPOINTS.insert], [57426, FUNCTIONAL_CODEPOINTS.delete],
]);

function normalizeKittyFunctionalCodepoint(codepoint: number): number {
  return KITTY_FUNCTIONAL_KEY_EQUIVALENTS.get(codepoint) ?? codepoint;
}

function normalizeShiftedLetterIdentityCodepoint(codepoint: number, modifier: number): number {
  const effectiveModifier = modifier & ~LOCK_MASK;
  if ((effectiveModifier & MODIFIERS.shift) !== 0 && codepoint >= 65 && codepoint <= 90) {
    return codepoint + 32;
  }
  return codepoint;
}

const LEGACY_KEY_SEQUENCES: Record<string, string[]> = {
  up: ["\x1b[A", "\x1bOA"],
  down: ["\x1b[B", "\x1bOB"],
  right: ["\x1b[C", "\x1bOC"],
  left: ["\x1b[D", "\x1bOD"],
  home: ["\x1b[H", "\x1bOH", "\x1b[1~", "\x1b[7~"],
  end: ["\x1b[F", "\x1bOF", "\x1b[4~", "\x1b[8~"],
  insert: ["\x1b[2~"],
  delete: ["\x1b[3~"],
  pageUp: ["\x1b[5~", "\x1b[[5~"],
  pageDown: ["\x1b[6~", "\x1b[[6~"],
  clear: ["\x1b[E", "\x1bOE"],
  f1: ["\x1bOP", "\x1b[11~", "\x1b[[A"],
  f2: ["\x1bOQ", "\x1b[12~", "\x1b[[B"],
  f3: ["\x1bOR", "\x1b[13~", "\x1b[[C"],
  f4: ["\x1bOS", "\x1b[14~", "\x1b[[D"],
  f5: ["\x1b[15~", "\x1b[[E"],
  f6: ["\x1b[17~"],
  f7: ["\x1b[18~"],
  f8: ["\x1b[19~"],
  f9: ["\x1b[20~"],
  f10: ["\x1b[21~"],
  f11: ["\x1b[23~"],
  f12: ["\x1b[24~"],
};

const LEGACY_SHIFT_SEQUENCES: Record<string, string[]> = {
  up: ["\x1b[a"],
  down: ["\x1b[b"],
  right: ["\x1b[c"],
  left: ["\x1b[d"],
  clear: ["\x1b[e"],
  insert: ["\x1b[2$"],
  delete: ["\x1b[3$"],
  pageUp: ["\x1b[5$"],
  pageDown: ["\x1b[6$"],
  home: ["\x1b[7$"],
  end: ["\x1b[8$"],
};

const LEGACY_CTRL_SEQUENCES: Record<string, string[]> = {
  up: ["\x1bOa"],
  down: ["\x1bOb"],
  right: ["\x1bOc"],
  left: ["\x1bOd"],
  clear: ["\x1bOe"],
  insert: ["\x1b[2^"],
  delete: ["\x1b[3^"],
  pageUp: ["\x1b[5^"],
  pageDown: ["\x1b[6^"],
  home: ["\x1b[7^"],
  end: ["\x1b[8^"],
};

const matchesLegacySequence = (data: string, sequences: string[] | undefined): boolean =>
  sequences?.includes(data) ?? false;

const matchesLegacyModifierSequence = (data: string, key: string, modifier: number): boolean => {
  if (modifier === MODIFIERS.shift) {
    return matchesLegacySequence(data, LEGACY_SHIFT_SEQUENCES[key]);
  }
  if (modifier === MODIFIERS.ctrl) {
    return matchesLegacySequence(data, LEGACY_CTRL_SEQUENCES[key]);
  }
  return false;
};

type ParsedKitty = { codepoint: number; shiftedKey?: number; baseLayoutKey?: number; modifier: number };

function parseKittySequence(data: string): ParsedKitty | null {
  const csiUMatch = data.match(/^\x1b\[(\d+)(?::(\d*))?(?::(\d+))?(?:;(\d+))?(?::(\d+))?u$/);
  if (csiUMatch) {
    const codepoint = parseInt(csiUMatch[1], 10);
    const shiftedKey = csiUMatch[2] && csiUMatch[2].length > 0 ? parseInt(csiUMatch[2], 10) : undefined;
    const baseLayoutKey = csiUMatch[3] ? parseInt(csiUMatch[3], 10) : undefined;
    const modValue = csiUMatch[4] ? parseInt(csiUMatch[4], 10) : 1;
    return { codepoint, shiftedKey, baseLayoutKey, modifier: modValue - 1 };
  }
  const arrowMatch = data.match(/^\x1b\[1;(\d+)(?::(\d+))?([ABCD])$/);
  if (arrowMatch) {
    const modValue = parseInt(arrowMatch[1], 10);
    const arrowCodes: Record<string, number> = { A: -1, B: -2, C: -3, D: -4 };
    return { codepoint: arrowCodes[arrowMatch[3]], modifier: modValue - 1 };
  }
  const funcMatch = data.match(/^\x1b\[(\d+)(?:;(\d+))?(?::(\d+))?~$/);
  if (funcMatch) {
    const keyNum = parseInt(funcMatch[1], 10);
    const modValue = funcMatch[2] ? parseInt(funcMatch[2], 10) : 1;
    const funcCodes: Record<number, number> = {
      2: FUNCTIONAL_CODEPOINTS.insert,
      3: FUNCTIONAL_CODEPOINTS.delete,
      5: FUNCTIONAL_CODEPOINTS.pageUp,
      6: FUNCTIONAL_CODEPOINTS.pageDown,
      7: FUNCTIONAL_CODEPOINTS.home,
      8: FUNCTIONAL_CODEPOINTS.end,
    };
    const codepoint = funcCodes[keyNum];
    if (codepoint !== undefined) {
      return { codepoint, modifier: modValue - 1 };
    }
  }
  const homeEndMatch = data.match(/^\x1b\[1;(\d+)(?::(\d+))?([HF])$/);
  if (homeEndMatch) {
    const modValue = parseInt(homeEndMatch[1], 10);
    const codepoint = homeEndMatch[3] === "H" ? FUNCTIONAL_CODEPOINTS.home : FUNCTIONAL_CODEPOINTS.end;
    return { codepoint, modifier: modValue - 1 };
  }
  return null;
}

function matchesKittySequence(data: string, expectedCodepoint: number, expectedModifier: number): boolean {
  const parsed = parseKittySequence(data);
  if (!parsed) return false;
  const actualMod = parsed.modifier & ~LOCK_MASK;
  const expectedMod = expectedModifier & ~LOCK_MASK;
  if (actualMod !== expectedMod) return false;
  const normalizedCodepoint = normalizeShiftedLetterIdentityCodepoint(
    normalizeKittyFunctionalCodepoint(parsed.codepoint),
    parsed.modifier,
  );
  const normalizedExpectedCodepoint = normalizeShiftedLetterIdentityCodepoint(
    normalizeKittyFunctionalCodepoint(expectedCodepoint),
    expectedModifier,
  );
  if (normalizedCodepoint === normalizedExpectedCodepoint) return true;
  if (parsed.baseLayoutKey !== undefined && parsed.baseLayoutKey === expectedCodepoint) {
    const cp = normalizedCodepoint;
    const isLatinLetter = cp >= 97 && cp <= 122;
    const isKnownSymbol = SYMBOL_KEYS.has(String.fromCharCode(cp));
    if (!isLatinLetter && !isKnownSymbol) return true;
  }
  return false;
}

function parseModifyOtherKeysSequence(data: string): { codepoint: number; modifier: number } | null {
  const match = data.match(/^\x1b\[27;(\d+);(\d+)~$/);
  if (!match) return null;
  const modValue = parseInt(match[1], 10);
  const codepoint = parseInt(match[2], 10);
  return { codepoint, modifier: modValue - 1 };
}

function matchesModifyOtherKeys(data: string, expectedKeycode: number, expectedModifier: number): boolean {
  const parsed = parseModifyOtherKeysSequence(data);
  if (!parsed) return false;
  return parsed.codepoint === expectedKeycode && parsed.modifier === expectedModifier;
}

function matchesPrintableModifyOtherKeys(data: string, expectedKeycode: number, expectedModifier: number): boolean {
  if (expectedModifier === 0) return false;
  const parsed = parseModifyOtherKeysSequence(data);
  if (!parsed || parsed.modifier !== expectedModifier) return false;
  return (
    normalizeShiftedLetterIdentityCodepoint(parsed.codepoint, parsed.modifier) ===
    normalizeShiftedLetterIdentityCodepoint(expectedKeycode, expectedModifier)
  );
}

function isWindowsTerminalSession(): boolean {
  return Boolean(process.env.WT_SESSION) && !process.env.SSH_CONNECTION && !process.env.SSH_CLIENT && !process.env.SSH_TTY;
}

function matchesRawBackspace(data: string, expectedModifier: number): boolean {
  if (data === "\x7f") return expectedModifier === 0;
  if (data !== "\x08") return false;
  return isWindowsTerminalSession() ? expectedModifier === MODIFIERS.ctrl : expectedModifier === 0;
}

function rawCtrlChar(key: string): string | null {
  const char = key.toLowerCase();
  const code = char.charCodeAt(0);
  if ((code >= 97 && code <= 122) || char === "[" || char === "\\" || char === "]" || char === "_") {
    return String.fromCharCode(code & 0x1f);
  }
  if (char === "-") {
    return String.fromCharCode(31);
  }
  return null;
}

function isDigitKey(key: string): boolean {
  return key >= "0" && key <= "9";
}

function parseKeyId(keyId: string): { key: string; ctrl: boolean; shift: boolean; alt: boolean; super: boolean } | null {
  const parts = keyId.toLowerCase().split("+");
  const key = parts[parts.length - 1];
  if (!key) return null;
  return {
    key,
    ctrl: parts.includes("ctrl"),
    shift: parts.includes("shift"),
    alt: parts.includes("alt"),
    super: parts.includes("super"),
  };
}

// Faithful port of matchesKey's string-sequence matcher.
function matchesKeySequence(data: string, keyId: string): boolean {
  const parsed = parseKeyId(keyId);
  if (!parsed) return false;
  const { key, ctrl, shift, alt, super: superModifier } = parsed;
  let modifier = 0;
  if (shift) modifier |= MODIFIERS.shift;
  if (alt) modifier |= MODIFIERS.alt;
  if (ctrl) modifier |= MODIFIERS.ctrl;
  if (superModifier) modifier |= MODIFIERS.super;
  switch (key) {
    case "escape":
    case "esc":
      if (modifier !== 0) return false;
      return (data === "\x1b" ||
        matchesKittySequence(data, CODEPOINTS.escape, 0) ||
        matchesModifyOtherKeys(data, CODEPOINTS.escape, 0));
    case "space":
      if (!_kittyProtocolActive) {
        if (modifier === MODIFIERS.ctrl && data === "\x00") return true;
        if (modifier === MODIFIERS.alt && data === "\x1b ") return true;
      }
      if (modifier === 0) {
        return (data === " " ||
          matchesKittySequence(data, CODEPOINTS.space, 0) ||
          matchesModifyOtherKeys(data, CODEPOINTS.space, 0));
      }
      return (matchesKittySequence(data, CODEPOINTS.space, modifier) ||
        matchesModifyOtherKeys(data, CODEPOINTS.space, modifier));
    case "tab":
      if (modifier === MODIFIERS.shift) {
        return (data === "\x1b[Z" ||
          matchesKittySequence(data, CODEPOINTS.tab, MODIFIERS.shift) ||
          matchesModifyOtherKeys(data, CODEPOINTS.tab, MODIFIERS.shift));
      }
      if (modifier === 0) {
        return data === "\t" || matchesKittySequence(data, CODEPOINTS.tab, 0);
      }
      return (matchesKittySequence(data, CODEPOINTS.tab, modifier) ||
        matchesModifyOtherKeys(data, CODEPOINTS.tab, modifier));
    case "enter":
    case "return":
      if (modifier === MODIFIERS.shift) {
        if (matchesKittySequence(data, CODEPOINTS.enter, MODIFIERS.shift) ||
          matchesKittySequence(data, CODEPOINTS.kpEnter, MODIFIERS.shift)) {
          return true;
        }
        if (matchesModifyOtherKeys(data, CODEPOINTS.enter, MODIFIERS.shift)) return true;
        if (_kittyProtocolActive) return data === "\x1b\r" || data === "\n";
        return false;
      }
      if (modifier === MODIFIERS.alt) {
        if (matchesKittySequence(data, CODEPOINTS.enter, MODIFIERS.alt) ||
          matchesKittySequence(data, CODEPOINTS.kpEnter, MODIFIERS.alt)) {
          return true;
        }
        if (matchesModifyOtherKeys(data, CODEPOINTS.enter, MODIFIERS.alt)) return true;
        if (!_kittyProtocolActive) return data === "\x1b\r";
        return false;
      }
      if (modifier === 0) {
        return (data === "\r" ||
          (!_kittyProtocolActive && data === "\n") ||
          data === "\x1bOM" ||
          matchesKittySequence(data, CODEPOINTS.enter, 0) ||
          matchesKittySequence(data, CODEPOINTS.kpEnter, 0));
      }
      return (matchesKittySequence(data, CODEPOINTS.enter, modifier) ||
        matchesKittySequence(data, CODEPOINTS.kpEnter, modifier) ||
        matchesModifyOtherKeys(data, CODEPOINTS.enter, modifier));
    case "backspace":
      if (modifier === MODIFIERS.alt) {
        if (data === "\x1b\x7f" || data === "\x1b\b") return true;
        return (matchesKittySequence(data, CODEPOINTS.backspace, MODIFIERS.alt) ||
          matchesModifyOtherKeys(data, CODEPOINTS.backspace, MODIFIERS.alt));
      }
      if (modifier === MODIFIERS.ctrl) {
        if (matchesRawBackspace(data, MODIFIERS.ctrl)) return true;
        return (matchesKittySequence(data, CODEPOINTS.backspace, MODIFIERS.ctrl) ||
          matchesModifyOtherKeys(data, CODEPOINTS.backspace, MODIFIERS.ctrl));
      }
      if (modifier === 0) {
        return (matchesRawBackspace(data, 0) ||
          matchesKittySequence(data, CODEPOINTS.backspace, 0) ||
          matchesModifyOtherKeys(data, CODEPOINTS.backspace, 0));
      }
      return (matchesKittySequence(data, CODEPOINTS.backspace, modifier) ||
        matchesModifyOtherKeys(data, CODEPOINTS.backspace, modifier));
    case "insert":
      if (modifier === 0) {
        return (matchesLegacySequence(data, LEGACY_KEY_SEQUENCES.insert) ||
          matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.insert, 0));
      }
      if (matchesLegacyModifierSequence(data, "insert", modifier)) return true;
      return matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.insert, modifier);
    case "delete":
      if (modifier === 0) {
        return (matchesLegacySequence(data, LEGACY_KEY_SEQUENCES.delete) ||
          matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.delete, 0));
      }
      if (matchesLegacyModifierSequence(data, "delete", modifier)) return true;
      return matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.delete, modifier);
    case "clear":
      if (modifier === 0) return matchesLegacySequence(data, LEGACY_KEY_SEQUENCES.clear);
      return matchesLegacyModifierSequence(data, "clear", modifier);
    case "home":
      if (modifier === 0) {
        return (matchesLegacySequence(data, LEGACY_KEY_SEQUENCES.home) ||
          matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.home, 0));
      }
      if (matchesLegacyModifierSequence(data, "home", modifier)) return true;
      return matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.home, modifier);
    case "end":
      if (modifier === 0) {
        return (matchesLegacySequence(data, LEGACY_KEY_SEQUENCES.end) ||
          matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.end, 0));
      }
      if (matchesLegacyModifierSequence(data, "end", modifier)) return true;
      return matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.end, modifier);
    case "pageup":
      if (modifier === 0) {
        return (matchesLegacySequence(data, LEGACY_KEY_SEQUENCES.pageUp) ||
          matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.pageUp, 0));
      }
      if (matchesLegacyModifierSequence(data, "pageUp", modifier)) return true;
      return matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.pageUp, modifier);
    case "pagedown":
      if (modifier === 0) {
        return (matchesLegacySequence(data, LEGACY_KEY_SEQUENCES.pageDown) ||
          matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.pageDown, 0));
      }
      if (matchesLegacyModifierSequence(data, "pageDown", modifier)) return true;
      return matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.pageDown, modifier);
    case "up":
      if (modifier === MODIFIERS.alt) {
        return data === "\x1bp" || matchesKittySequence(data, ARROW_CODEPOINTS.up, MODIFIERS.alt);
      }
      if (modifier === 0) {
        return (matchesLegacySequence(data, LEGACY_KEY_SEQUENCES.up) ||
          matchesKittySequence(data, ARROW_CODEPOINTS.up, 0));
      }
      if (matchesLegacyModifierSequence(data, "up", modifier)) return true;
      return matchesKittySequence(data, ARROW_CODEPOINTS.up, modifier);
    case "down":
      if (modifier === MODIFIERS.alt) {
        return data === "\x1bn" || matchesKittySequence(data, ARROW_CODEPOINTS.down, MODIFIERS.alt);
      }
      if (modifier === 0) {
        return (matchesLegacySequence(data, LEGACY_KEY_SEQUENCES.down) ||
          matchesKittySequence(data, ARROW_CODEPOINTS.down, 0));
      }
      if (matchesLegacyModifierSequence(data, "down", modifier)) return true;
      return matchesKittySequence(data, ARROW_CODEPOINTS.down, modifier);
    case "left":
      if (modifier === MODIFIERS.alt) {
        return (data === "\x1b[1;3D" ||
          (!_kittyProtocolActive && data === "\x1bB") ||
          data === "\x1bb" ||
          matchesKittySequence(data, ARROW_CODEPOINTS.left, MODIFIERS.alt));
      }
      if (modifier === MODIFIERS.ctrl) {
        return (data === "\x1b[1;5D" ||
          matchesLegacyModifierSequence(data, "left", MODIFIERS.ctrl) ||
          matchesKittySequence(data, ARROW_CODEPOINTS.left, MODIFIERS.ctrl));
      }
      if (modifier === 0) {
        return (matchesLegacySequence(data, LEGACY_KEY_SEQUENCES.left) ||
          matchesKittySequence(data, ARROW_CODEPOINTS.left, 0));
      }
      if (matchesLegacyModifierSequence(data, "left", modifier)) return true;
      return matchesKittySequence(data, ARROW_CODEPOINTS.left, modifier);
    case "right":
      if (modifier === MODIFIERS.alt) {
        return (data === "\x1b[1;3C" ||
          (!_kittyProtocolActive && data === "\x1bF") ||
          data === "\x1bf" ||
          matchesKittySequence(data, ARROW_CODEPOINTS.right, MODIFIERS.alt));
      }
      if (modifier === MODIFIERS.ctrl) {
        return (data === "\x1b[1;5C" ||
          matchesLegacyModifierSequence(data, "right", MODIFIERS.ctrl) ||
          matchesKittySequence(data, ARROW_CODEPOINTS.right, MODIFIERS.ctrl));
      }
      if (modifier === 0) {
        return (matchesLegacySequence(data, LEGACY_KEY_SEQUENCES.right) ||
          matchesKittySequence(data, ARROW_CODEPOINTS.right, 0));
      }
      if (matchesLegacyModifierSequence(data, "right", modifier)) return true;
      return matchesKittySequence(data, ARROW_CODEPOINTS.right, modifier);
    case "f1":
    case "f2":
    case "f3":
    case "f4":
    case "f5":
    case "f6":
    case "f7":
    case "f8":
    case "f9":
    case "f10":
    case "f11":
    case "f12": {
      if (modifier !== 0) return false;
      return matchesLegacySequence(data, LEGACY_KEY_SEQUENCES[key]);
    }
  }
  // Single letter/digit keys and symbols
  if (key.length === 1 && ((key >= "a" && key <= "z") || isDigitKey(key) || SYMBOL_KEYS.has(key))) {
    const codepoint = key.charCodeAt(0);
    const rawCtrl = rawCtrlChar(key);
    const isLetter = key >= "a" && key <= "z";
    const isDigit = isDigitKey(key);
    if (modifier === MODIFIERS.ctrl + MODIFIERS.alt && !_kittyProtocolActive && rawCtrl) {
      if (data === `\x1b${rawCtrl}`) return true;
    }
    if (modifier === MODIFIERS.alt && !_kittyProtocolActive && (isLetter || isDigit || SYMBOL_KEYS.has(key))) {
      if (data === `\x1b${key}`) return true;
    }
    if (modifier === MODIFIERS.ctrl) {
      if (rawCtrl && data === rawCtrl) return true;
      return (matchesKittySequence(data, codepoint, MODIFIERS.ctrl) ||
        matchesPrintableModifyOtherKeys(data, codepoint, MODIFIERS.ctrl));
    }
    if (modifier === MODIFIERS.shift + MODIFIERS.ctrl) {
      return (matchesKittySequence(data, codepoint, MODIFIERS.shift + MODIFIERS.ctrl) ||
        matchesPrintableModifyOtherKeys(data, codepoint, MODIFIERS.shift + MODIFIERS.ctrl));
    }
    if (modifier === MODIFIERS.shift) {
      if (isLetter && data === key.toUpperCase()) return true;
      return (matchesKittySequence(data, codepoint, MODIFIERS.shift) ||
        matchesPrintableModifyOtherKeys(data, codepoint, MODIFIERS.shift));
    }
    if (modifier !== 0) {
      return (matchesKittySequence(data, codepoint, modifier) ||
        matchesPrintableModifyOtherKeys(data, codepoint, modifier));
    }
    return data === key || matchesKittySequence(data, codepoint, 0);
  }
  return false;
}

export function matchesKey(candidate: unknown, expected: unknown): boolean {
  if (candidate === expected) return true;
  if (candidate && typeof candidate === "object" && "key" in (candidate as Record<string, unknown>)) {
    return (candidate as { key?: unknown }).key === expected;
  }
  if (typeof candidate === "string" && typeof expected === "string") {
    return matchesKeySequence(candidate, expected);
  }
  return false;
}

export function truncateToWidth(text: string, maxWidth: number, ellipsis = "...", pad = false): string {
  if (maxWidth <= 0) return "";
  const plain = stripAnsi(text);
  if (plain.length <= maxWidth) {
    return pad ? plain + " ".repeat(maxWidth - plain.length) : plain;
  }
  const ellipsisWidth = ellipsis.length;
  if (ellipsisWidth >= maxWidth) {
    return ellipsis.slice(0, maxWidth);
  }
  const truncated = plain.slice(0, maxWidth - ellipsisWidth) + ellipsis;
  return pad ? truncated + " ".repeat(Math.max(0, maxWidth - truncated.length)) : truncated;
}

export function visibleWidth(text: string): number {
  return stripAnsi(text).length;
}

export function wrapTextWithAnsi(text: string, width: number): string[] {
  const normalizedWidth = Math.max(1, width);
  const plain = stripAnsi(text);
  if (!plain) return [""];

  const lines: string[] = [];
  for (let index = 0; index < plain.length; index += normalizedWidth) {
    lines.push(plain.slice(index, index + normalizedWidth));
  }
  return lines;
}

// Ported from @earendil-works/pi-tui/dist/keys.js (isKeyRelease).
export function isKeyRelease(data: string): boolean {
  // Don't treat bracketed paste content as key release, even if it contains
  // patterns like ":3F" (e.g., bluetooth MAC addresses like "90:62:3F:A5").
  if (data.includes("\x1b[200~")) {
    return false;
  }
  // Quick check: release events with flag 2 contain ":3"
  // Format: \x1b[<codepoint>;<modifier>:3u
  if (
    data.includes(":3u") ||
    data.includes(":3~") ||
    data.includes(":3A") ||
    data.includes(":3B") ||
    data.includes(":3C") ||
    data.includes(":3D") ||
    data.includes(":3H") ||
    data.includes(":3F")
  ) {
    return true;
  }
  return false;
}

// Ported from @earendil-works/pi-tui/dist/keybindings.js.
export type KeybindingDefinition = {
  defaultKeys: string | string[];
  description: string;
};

export const TUI_KEYBINDINGS: Record<string, KeybindingDefinition> = {
  "tui.editor.cursorUp": { defaultKeys: "up", description: "Move cursor up" },
  "tui.editor.cursorDown": { defaultKeys: "down", description: "Move cursor down" },
  "tui.editor.cursorLeft": {
    defaultKeys: ["left", "ctrl+b"],
    description: "Move cursor left",
  },
  "tui.editor.cursorRight": {
    defaultKeys: ["right", "ctrl+f"],
    description: "Move cursor right",
  },
  "tui.editor.cursorWordLeft": {
    defaultKeys: ["alt+left", "ctrl+left", "alt+b"],
    description: "Move cursor word left",
  },
  "tui.editor.cursorWordRight": {
    defaultKeys: ["alt+right", "ctrl+right", "alt+f"],
    description: "Move cursor word right",
  },
  "tui.editor.cursorLineStart": {
    defaultKeys: ["home", "ctrl+a"],
    description: "Move to line start",
  },
  "tui.editor.cursorLineEnd": {
    defaultKeys: ["end", "ctrl+e"],
    description: "Move to line end",
  },
  "tui.editor.jumpForward": {
    defaultKeys: "ctrl+]",
    description: "Jump forward to character",
  },
  "tui.editor.jumpBackward": {
    defaultKeys: "ctrl+alt+]",
    description: "Jump backward to character",
  },
  "tui.editor.pageUp": { defaultKeys: "pageUp", description: "Page up" },
  "tui.editor.pageDown": { defaultKeys: "pageDown", description: "Page down" },
  "tui.editor.deleteCharBackward": {
    defaultKeys: "backspace",
    description: "Delete character backward",
  },
  "tui.editor.deleteCharForward": {
    defaultKeys: ["delete", "ctrl+d"],
    description: "Delete character forward",
  },
  "tui.editor.deleteWordBackward": {
    defaultKeys: ["ctrl+w", "alt+backspace"],
    description: "Delete word backward",
  },
  "tui.editor.deleteWordForward": {
    defaultKeys: ["alt+d", "alt+delete"],
    description: "Delete word forward",
  },
  "tui.editor.deleteToLineStart": {
    defaultKeys: "ctrl+u",
    description: "Delete to line start",
  },
  "tui.editor.deleteToLineEnd": {
    defaultKeys: "ctrl+k",
    description: "Delete to line end",
  },
  "tui.editor.yank": { defaultKeys: "ctrl+y", description: "Yank" },
  "tui.editor.yankPop": { defaultKeys: "alt+y", description: "Yank pop" },
  "tui.editor.undo": { defaultKeys: "ctrl+-", description: "Undo" },
  "tui.input.newLine": { defaultKeys: ["shift+enter", "ctrl+j"], description: "Insert newline" },
  "tui.input.submit": { defaultKeys: "enter", description: "Submit input" },
  "tui.input.tab": { defaultKeys: "tab", description: "Tab / autocomplete" },
  "tui.input.copy": { defaultKeys: "ctrl+c", description: "Copy selection" },
  "tui.select.up": { defaultKeys: "up", description: "Move selection up" },
  "tui.select.down": { defaultKeys: "down", description: "Move selection down" },
  "tui.select.pageUp": { defaultKeys: "pageUp", description: "Selection page up" },
  "tui.select.pageDown": {
    defaultKeys: "pageDown",
    description: "Selection page down",
  },
  "tui.select.confirm": { defaultKeys: "enter", description: "Confirm selection" },
  "tui.select.cancel": {
    defaultKeys: ["escape", "ctrl+c"],
    description: "Cancel selection",
  },
};

function normalizeKeys(keys: string | string[] | undefined): string[] {
  if (keys === undefined) return [];
  const keyList = Array.isArray(keys) ? keys : [keys];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const key of keyList) {
    if (!seen.has(key)) {
      seen.add(key);
      result.push(key);
    }
  }
  return result;
}

type KeybindingConflict = { key: string; keybindings: string[] };

export class KeybindingsManager {
  private definitions: Record<string, KeybindingDefinition>;
  private userBindings: Record<string, string | string[]>;
  private keysById = new Map<string, string[]>();
  private conflicts: KeybindingConflict[] = [];

  constructor(
    definitions: Record<string, KeybindingDefinition>,
    userBindings: Record<string, string | string[]> = {},
  ) {
    this.definitions = definitions;
    this.userBindings = userBindings;
    this.rebuild();
  }

  private rebuild(): void {
    this.keysById.clear();
    this.conflicts = [];
    const userClaims = new Map<string, Set<string>>();
    for (const [keybinding, keys] of Object.entries(this.userBindings)) {
      if (!(keybinding in this.definitions)) continue;
      for (const key of normalizeKeys(keys)) {
        const claimants = userClaims.get(key) ?? new Set<string>();
        claimants.add(keybinding);
        userClaims.set(key, claimants);
      }
    }
    for (const [key, keybindings] of userClaims) {
      if (keybindings.size > 1) {
        this.conflicts.push({ key, keybindings: [...keybindings] });
      }
    }
    for (const [id, definition] of Object.entries(this.definitions)) {
      const userKeys = this.userBindings[id];
      const keys = userKeys === undefined ? normalizeKeys(definition.defaultKeys) : normalizeKeys(userKeys);
      this.keysById.set(id, keys);
    }
  }

  matches(data: unknown, keybinding: string): boolean {
    const keys = this.keysById.get(keybinding) ?? [];
    for (const key of keys) {
      if (matchesKey(data, key)) return true;
    }
    return false;
  }

  getKeys(keybinding: string): string[] {
    return [...(this.keysById.get(keybinding) ?? [])];
  }

  getDefinition(keybinding: string): KeybindingDefinition | undefined {
    return this.definitions[keybinding];
  }

  getConflicts(): KeybindingConflict[] {
    return this.conflicts.map((conflict) => ({ ...conflict, keybindings: [...conflict.keybindings] }));
  }

  setUserBindings(userBindings: Record<string, string | string[]>): void {
    this.userBindings = userBindings;
    this.rebuild();
  }

  getUserBindings(): Record<string, string | string[]> {
    return { ...this.userBindings };
  }

  getResolvedBindings(): Record<string, string | string[]> {
    const resolved: Record<string, string | string[]> = {};
    for (const id of Object.keys(this.definitions)) {
      const keys = this.keysById.get(id) ?? [];
      resolved[id] = keys.length === 1 ? keys[0] : [...keys];
    }
    return resolved;
  }
}

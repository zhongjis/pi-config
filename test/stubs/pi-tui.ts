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
  ctrlShift(key: string) {
    return `ctrl+shift+${key}`;
  }
};

export class Box {
  children: unknown[];

  constructor(children: unknown[] = []) {
    this.children = children;
  }
}

export class Container {
  children: unknown[];

  constructor(children: unknown[] = []) {
    this.children = children;
  }
}

export class Editor {
  constructor(..._args: unknown[]) {}

  focus(): void {}
}

export class Markdown {
  text: string;

  constructor(text = "") {
    this.text = text;
  }
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
}

export function matchesKey(candidate: unknown, expected: unknown): boolean {
  if (candidate === expected) return true;
  if (candidate && typeof candidate === "object" && "key" in (candidate as Record<string, unknown>)) {
    return (candidate as { key?: unknown }).key === expected;
  }
  return false;
}

export function truncateToWidth(text: string, width: number): string {
  return stripAnsi(text).slice(0, Math.max(0, width));
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

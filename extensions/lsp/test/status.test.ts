import { describe, expect, it } from 'vitest';

import { formatLspStatus } from '../index';
import type { LoadedConfig } from '../config';

function cfg(globalDisabled: boolean, names: string[]): Pick<LoadedConfig, 'globalDisabled' | 'servers'> {
  return {
    globalDisabled,
    servers: names.map((name) => ({ name })) as LoadedConfig['servers'],
  };
}

describe('LSP footer status formatting', () => {
  it('uses compact labels for absent or disabled config', () => {
    expect(formatLspStatus(null)).toBe('LSP none');
    expect(formatLspStatus(cfg(true, ['tsserver']))).toBe('LSP disabled');
    expect(formatLspStatus(cfg(false, []))).toBe('LSP none');
  });

  it('shows running servers as a count over configured servers', () => {
    const loaded = cfg(false, ['bashls', 'pyright', 'typescript-language-server']);

    expect(formatLspStatus(loaded)).toBe('LSP 0/3');
    expect(formatLspStatus(loaded, 2)).toBe('LSP 2/3 running');
  });

  it('keeps exported helper output bounded for invalid counts', () => {
    const loaded = cfg(false, ['bashls', 'pyright']);

    expect(formatLspStatus(loaded, -1)).toBe('LSP 0/2');
    expect(formatLspStatus(loaded, 5)).toBe('LSP 2/2 running');
    expect(formatLspStatus(loaded, Number.NaN)).toBe('LSP 0/2');
  });
});

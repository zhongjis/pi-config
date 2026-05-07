import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';

// Mock fs before importing the extension so findGitNexusIndex is mockable.
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof fs>('node:fs');
  return { ...actual, existsSync: vi.fn() };
});


// The handler we'll extract from index.ts in Step 1.3.
// Import path will be `../src/stealth-injection.js` after the extraction.
// Until the module exists, these tests fail with a module-not-found error,
// which is the expected failing state for Step 1.2.
import { buildInjectedSystemPrompt, composeAnalyzeArgs, checkSkillDrift } from '../src/stealth-injection.js';

describe('buildInjectedSystemPrompt', () => {
  beforeEach(() => {
    vi.mocked(fs.existsSync).mockReset();
  });

  it('returns undefined when no .gitnexus/ index present (no injection)', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const result = buildInjectedSystemPrompt({
      base: 'BASE',
      cwd: '/fake/repo',
      skills: [{ name: 'gitnexus-exploring' }],
    });
    expect(result).toBeUndefined();
  });

  it('injects prose containing signature tokens when index is present', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const result = buildInjectedSystemPrompt({
      base: 'BASE',
      cwd: '/fake/repo',
      skills: [{ name: 'gitnexus-exploring' }],
    });
    expect(result).toBeDefined();
    expect(result).toMatch(/\bgitnexus_query\b/);
    expect(result).toMatch(/\bgitnexus_impact\b/);
    expect(result!.startsWith('BASE')).toBe(true);
  });

  it('lists loaded gitnexus skills by name with word-boundary match', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const result = buildInjectedSystemPrompt({
      base: 'BASE',
      cwd: '/fake/repo',
      skills: [
        { name: 'gitnexus-exploring' },
        { name: 'gitnexus-impact-analysis' },
        { name: 'gitnexus-pr-review' },
        { name: 'some-other-skill' },
      ],
    });
    expect(result).toMatch(/\bgitnexus-exploring\b/);
    expect(result).toMatch(/\bgitnexus-impact-analysis\b/);
    expect(result).toMatch(/\bgitnexus-pr-review\b/);
    expect(result).not.toMatch(/\bsome-other-skill\b/);
  });

  it('never includes .claude/skills/ paths in injected text', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const result = buildInjectedSystemPrompt({
      base: 'BASE',
      cwd: '/fake/repo',
      skills: [{ name: 'gitnexus-exploring' }],
    });
    expect(result).not.toContain('.claude/skills');
  });

  it('emits fallback pointing at sync script when zero gitnexus skills loaded', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const result = buildInjectedSystemPrompt({
      base: 'BASE',
      cwd: '/fake/repo',
      skills: [{ name: 'some-other-skill' }],
    });
    expect(result).toMatch(/sync-gitnexus-resources\.sh/);
    expect(result).not.toMatch(/\bgitnexus-exploring\b/);
  });

  it('handles undefined skills array with ?? [] coalescing', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const result = buildInjectedSystemPrompt({
      base: 'BASE',
      cwd: '/fake/repo',
      skills: undefined,
    });
    expect(result).toMatch(/sync-gitnexus-resources\.sh/);
  });
});

describe('composeAnalyzeArgs', () => {
  it('always prepends --skip-agents-md and --no-stats after the analyze subcommand', () => {
    const args = composeAnalyzeArgs([]);
    expect(args).toEqual(['analyze', '--skip-agents-md', '--no-stats']);
  });

  it('preserves base args (e.g., for npx wrapper)', () => {
    const args = composeAnalyzeArgs(['--some-base-flag']);
    expect(args).toEqual(['--some-base-flag', 'analyze', '--skip-agents-md', '--no-stats']);
  });

  it('appends user args after the stealth flags', () => {
    const args = composeAnalyzeArgs([], ['--force']);
    expect(args).toEqual(['analyze', '--skip-agents-md', '--no-stats', '--force']);
  });

  it('never includes --skills', () => {
    const args = composeAnalyzeArgs([], ['--force']);
    expect(args).not.toContain('--skills');
  });

  it('orders base args, analyze, stealth flags, then user rest', () => {
    const args = composeAnalyzeArgs(['--base'], ['--force']);
    expect(args).toEqual(['--base', 'analyze', '--skip-agents-md', '--no-stats', '--force']);
  });
});

describe('checkSkillDrift', () => {
  it('returns null (no drift message) when versions match', () => {
    const result = checkSkillDrift({ vendoredVersion: '1.6.3', binaryVersion: '1.6.3' });
    expect(result).toBeNull();
  });

  it('returns a warn-severity message when versions differ', () => {
    const result = checkSkillDrift({ vendoredVersion: '1.6.2', binaryVersion: '1.6.3' });
    expect(result).not.toBeNull();
    expect(result!.message).toMatch(/\b1\.6\.2\b/);
    expect(result!.message).toMatch(/\b1\.6\.3\b/);
    expect(result!.message).toMatch(/sync-gitnexus-resources\.sh/);
    expect(result!.severity).toBe('warning');
  });

  it('returns null when vendoredVersion is missing (undefined)', () => {
    const result = checkSkillDrift({ vendoredVersion: undefined, binaryVersion: '1.6.3' });
    expect(result).toBeNull();
  });

  it('returns null when binaryVersion is missing (undefined)', () => {
    const result = checkSkillDrift({ vendoredVersion: '1.6.3', binaryVersion: undefined });
    expect(result).toBeNull();
  });
});

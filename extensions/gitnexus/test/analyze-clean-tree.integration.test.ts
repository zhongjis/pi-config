import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeAnalyzeArgs } from '../src/stealth-injection.js';

const hasBinary = spawnSync('gitnexus', ['--version'], { stdio: 'ignore' }).status === 0;

describe.runIf(hasBinary)('gitnexus analyze + stealth contract leaves git tree clean', () => {
  it('with --skip-agents-md --no-stats AND .gitignore covering .claude/ + .gitnexus, scratch repo has no working-tree changes after analyze', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'gitnexus-clean-tree-'));

    // Minimal indexable scratch repo with the same stealth setup pi-config uses:
    // - .gitignore listing .gitnexus (binary's index dir) and .claude/ (binary's
    //   side-effect skill writes). This mirrors root .gitignore in the real repo.
    spawnSync('git', ['init', '--quiet'], { cwd: scratch });
    writeFileSync(join(scratch, '.gitignore'), '.gitnexus\n.claude/\n');
    writeFileSync(join(scratch, 'package.json'), '{"name":"t","version":"0.0.0"}\n');
    writeFileSync(join(scratch, 'index.ts'), 'export const x = 1;\n');
    spawnSync('git', ['add', '-A'], { cwd: scratch });
    spawnSync('git', ['commit', '--quiet', '-m', 'init'], { cwd: scratch });

    // Run analyze with the extension's composed argv (no user args).
    const args = composeAnalyzeArgs([]);
    const result = spawnSync('gitnexus', args, { cwd: scratch, stdio: 'ignore' });
    expect(result.status).toBe(0);

    // Assert: binary wrote its index (proves analyze actually ran).
    expect(existsSync(join(scratch, '.gitnexus'))).toBe(true);

    // Assert: working tree clean. Any untracked/modified file here means the
    // stealth contract (flags + gitignore) is insufficient — spec regression.
    const status = spawnSync('git', ['status', '--porcelain'], { cwd: scratch, encoding: 'utf-8' });
    expect(status.status).toBe(0);
    expect(status.stdout.trim()).toBe('');
  }, 60_000);
});

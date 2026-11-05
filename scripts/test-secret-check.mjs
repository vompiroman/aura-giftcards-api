import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const scanner = fileURLToPath(new URL('./check-secrets.mjs', import.meta.url));
const credential = 'https://discord.com/api/webhooks/' + '123456789012345678/' + 'a'.repeat(68);
function fixture(run) {
  const root = realpathSync(tmpdir());
  const cwd = mkdtempSync(resolve(root, 'aura-secret-check-'));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    git('init', '-q');
    git('config', 'user.name', 'Secret check fixture');
    git('config', 'user.email', 'fixture@example.invalid');
    run({ cwd, git, scan: (base = '') => spawnSync(process.execPath, [scanner], {
      cwd, encoding: 'utf8', env: { ...process.env, SECRET_SCAN_BASE: base },
    }) });
  } finally {
    const target = realpathSync(cwd);
    assert(target.startsWith(root + sep) && target.slice(root.length + 1).startsWith('aura-secret-check-'));
    rmSync(target, { recursive: true, force: true });
  }
}

test('allows harmless examples and ignores local private environment files', () => fixture(({ cwd, git, scan }) => {
  writeFileSync(resolve(cwd, '.gitignore'), '.env*\n!.env.example\n');
  writeFileSync(resolve(cwd, '.env.example'), 'DISCORD_WEBHOOK_URL=\n');
  writeFileSync(resolve(cwd, '.env.local'), `DISCORD_WEBHOOK_URL=${credential}\n`);
  git('add', '.');
  assert.equal(scan().status, 0);
}));

test('rejects a leaked URL without printing its value', () => fixture(({ cwd, git, scan }) => {
  writeFileSync(resolve(cwd, 'leak.json'), JSON.stringify({ hook: credential }).replaceAll('/', '\\/'));
  git('add', '.');
  const result = scan();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /leak.json/);
  assert(!result.stderr.includes(credential) && !result.stderr.includes('a'.repeat(68)));
}));

test('rejects a private environment file forced into Git', () => fixture(({ cwd, git, scan }) => {
  writeFileSync(resolve(cwd, '.gitignore'), '.env*\n');
  writeFileSync(resolve(cwd, '.env.production'), 'SECRET=private\n');
  git('add', '-f', '.env.production');
  assert.equal(scan().status, 1);
}));

test('detects a secret committed and removed before the final PR tree', () => fixture(({ cwd, git, scan }) => {
  writeFileSync(resolve(cwd, 'app.txt'), 'safe\n');
  git('add', '.'); git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(resolve(cwd, 'app.txt'), credential);
  git('commit', '-qam', 'leak');
  writeFileSync(resolve(cwd, 'app.txt'), 'safe again\n');
  git('commit', '-qam', 'remove');
  assert.equal(scan().status, 0);
  const result = scan(base);
  assert.equal(result.status, 1);
  assert(!result.stderr.includes(credential));
}));

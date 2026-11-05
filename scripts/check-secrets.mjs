import { execFileSync } from 'node:child_process';
import { readFileSync, lstatSync } from 'node:fs';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
const webhook = /https?:\/\/(?:[a-z0-9-]+\.)?discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/\d{16,22}\/[a-z0-9_-]{40,}/gi;
const issues = [];
const scan = (content, source) => {
  const text = content.replaceAll('\\/', '/');
  for (const match of text.matchAll(webhook)) {
    issues.push(`${source}:${text.slice(0, match.index).split('\n').length}: Discord webhook credential`);
  }
};
// Include staged/tracked content and new files; ignored local secrets stay private.
for (const file of new Set(git('ls-files', '-z', '--cached', '--others', '--exclude-standard').split('\0').filter(Boolean))) {
  try {
    if (!lstatSync(file).isFile()) continue;
    if (/(^|\/)\.env(?:\.|$)/.test(file) && !/\.example$/.test(file)) {
      issues.push(`${file}: secret-bearing environment file must not be tracked`);
    }
    const content = readFileSync(file);
    if (!content.includes(0)) scan(content.toString('utf8'), file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
// Also reject a secret added and then removed in another commit of the same PR.
const base = process.env.SECRET_SCAN_BASE;
if (base && !/^0+$/.test(base)) {
  if (!/^[0-9a-f]{40}$/i.test(base)) throw new Error('Invalid secret scan base SHA');
  const additions = git('log', '--format=', '--patch', '--unified=0', '--no-ext-diff', `${base}..HEAD`)
    .split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++')).join('\n');
  scan(additions, 'new commits');
}
if (issues.length) {
  console.error('Secret check failed. Remove credentials and revoke any exposed webhook. Values are never printed.');
  issues.forEach(issue => console.error(issue));
  process.exitCode = 1;
} else {
  console.log('No Discord webhook credentials or tracked private .env files found.');
}

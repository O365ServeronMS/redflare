#!/usr/bin/env node
// Test gate. Usage: node scripts/rf-test.mjs [changed|all]   (default: changed)
//   changed — tests whose file or direct imports changed vs origin/main (+ uncommitted),
//             typecheck if Worker files changed, build if SPA files changed.
//   all     — every test:* script + typecheck + build + wrangler dry-run + git diff --check.
// Prints one line per step; only failing steps print output (last 30 lines).
import { execSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, normalize } from 'node:path';

const mode = process.argv[2] ?? 'changed';
const sh = (c) => execSync(c, { encoding: 'utf8' }).trim();
const noExt = (p) => p.replace(/\.(m?js|ts)$/, '');
const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts;
const tests = Object.keys(scripts).filter((s) => s.startsWith('test:'));

const steps = [];
if (mode === 'all') {
  steps.push(['worker:typecheck'], ['build'], ...tests.map((t) => [t]));
  steps.push(['wrangler dry-run', 'npx', ['--no-install', 'wrangler', 'deploy', '--dry-run']]);
  steps.push(['git diff --check', 'git', ['diff', '--check', 'origin/main']]);
} else {
  const base = sh('git merge-base HEAD origin/main');
  const changed = new Set(
    [sh(`git diff --name-only ${base}`), sh('git ls-files --others --exclude-standard')]
      .join('\n').split('\n').filter(Boolean).map(noExt),
  );
  const any = (re) => [...changed].some((f) => re.test(f));
  if (any(/^(src-ssr\/|wrangler|tsconfig)/)) steps.push(['worker:typecheck']);
  if (any(/^(src\/|index|public\/|vite\.config)/)) steps.push(['build']);
  for (const t of tests) {
    const file = scripts[t].match(/tests\/\w+\.test\.mjs/)?.[0];
    if (!file) continue;
    // Tests bundle their imports transitively, so match on the top-level source
    // dir they import from (src-ssr/ or src/), not just the directly imported file.
    const roots = new Set([...readFileSync(file, 'utf8').matchAll(/from\s+['"](\.\.?\/[^'"]+)['"]/g)]
      .map((m) => normalize(join('tests', m[1])).split('/')[0] + '/'));
    if (changed.has(noExt(file)) || [...roots].some((r) => r !== 'tests/' && any(new RegExp('^' + r)))) steps.push([t]);
  }
  if (!steps.length) { console.log('NOTHING TO RUN (no mapped changes)'); process.exit(0); }
}

let failed = 0;
for (const [name, cmd = 'npm', args = ['run', '-s', name]] of steps) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (r.status === 0) { console.log(`PASS ${name}`); continue; }
  failed++;
  console.log(`FAIL ${name}\n` + `${r.stdout}${r.stderr}`.trim().split('\n').slice(-30).join('\n'));
}
console.log(`${failed ? 'FAILED' : 'OK'}: ${steps.length - failed}/${steps.length} passed`);
process.exit(failed ? 1 : 0);

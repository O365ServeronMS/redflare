#!/usr/bin/env node
// Usage: node scripts/run-bundled-test.mjs tests/<name>.test.mjs
// Bundles a test that imports src-ssr/*.ts (cloudflare:workers -> mock,
// miniflare left external), runs it with `node --test`, then deletes the
// bundle. The bundle sits next to the test so import.meta.url-relative
// paths (../migrations/...) still resolve.
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { build } from 'esbuild';

const entry = process.argv[2];
const outfile = entry.replace(/\.test\.mjs$/, '.bundle.mjs');
try {
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    alias: { 'cloudflare:workers': './tests/cloudflareWorkersMock.mjs' },
    external: ['miniflare'],
    outfile,
    logLevel: 'warning',
  });
  process.exitCode = spawnSync(process.execPath, ['--test', outfile], { stdio: 'inherit' }).status ?? 1;
} finally {
  rmSync(outfile, { force: true });
}

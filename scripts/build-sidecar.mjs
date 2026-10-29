// Compiles the Open Rock server into a single executable for the desktop app (Tauri sidecar).
//
//   node scripts/build-sidecar.mjs            # for this machine
//   node scripts/build-sidecar.mjs <triple>   # e.g. x86_64-pc-windows-msvc
//
// If .env names a Gemma server (OPEN_ROCK_DEDICATED_HOST and its token), it's baked into the binary and starts the
// Dedicated server list on first run. Servers are otherwise added in Settings → Dedicated.

import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

function hostTriple() {
  try {
    const out = execFileSync('rustc', ['-vV'], { encoding: 'utf8' });
    const line = out.split('\n').find((l) => l.startsWith('host:'));
    if (line) return line.slice(5).trim();
  } catch {
    // fall through
  }
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  if (process.platform === 'win32') return `${arch}-pc-windows-msvc`;
  if (process.platform === 'darwin') return `${arch}-apple-darwin`;
  return `${arch}-unknown-linux-gnu`;
}

function bunTarget(triple) {
  const arch = triple.startsWith('aarch64') ? 'arm64' : 'x64';
  if (triple.includes('windows')) return `bun-windows-${arch}`;
  if (triple.includes('apple-darwin')) return `bun-darwin-${arch}`;
  if (triple.includes('linux')) return `bun-linux-${arch}${triple.includes('musl') ? '-musl' : ''}`;
  throw new Error(`Unsupported target ${triple}`);
}

function readDotEnv() {
  const file = path.join(root, '.env');
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[line.slice(0, eq).trim()] = value;
  }
  return out;
}

function bunBinary() {
  try {
    const dir = path.dirname(require.resolve('bun/package.json'));
    for (const name of ['bin/bun.exe', 'bin/bun']) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) return p;
    }
  } catch {
    // not installed locally
  }
  return process.platform === 'win32' ? 'bun.exe' : 'bun';
}

const triple = process.argv[2] || process.env.TAURI_ENV_TARGET_TRIPLE || hostTriple();
const ext = triple.includes('windows') ? '.exe' : '';
const outDir = path.join(root, 'src-tauri', 'binaries');
const outfile = path.join(outDir, `open-rock-server-${triple}${ext}`);
fs.mkdirSync(outDir, { recursive: true });

const env = { ...readDotEnv(), ...process.env };
const embedded = {};
for (const key of ['OPEN_ROCK_DEDICATED_HOST', 'OPEN_ROCK_DEDICATED_URL', 'OPEN_ROCK_DEDICATED_TOKEN']) {
  if (env[key]) embedded[key] = env[key];
}
if (!embedded.OPEN_ROCK_DEDICATED_HOST && !embedded.OPEN_ROCK_DEDICATED_URL) {
  console.log('[sidecar] No Gemma server in .env; add servers in Settings → Dedicated.');
}

const args = [
  'build',
  path.join(root, 'server', 'src', 'index.ts'),
  '--compile',
  '--minify',
  `--target=${bunTarget(triple)}`,
  `--outfile=${outfile}`,
  `--define`,
  `__OPEN_ROCK_EMBEDDED__=${JSON.stringify(embedded)}`,
];

console.log(`[sidecar] building ${path.relative(root, outfile)} (${bunTarget(triple)})`);
const res = spawnSync(bunBinary(), args, { cwd: root, stdio: 'inherit' });
if (res.error) {
  console.error(`[sidecar] could not run bun: ${res.error.message}. Run "npm install" first.`);
  process.exit(1);
}
process.exit(res.status ?? 1);

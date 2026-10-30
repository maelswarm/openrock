import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { parseServerAddress } from '@open-rock/shared';

// Values baked into the desktop sidecar at build time (see scripts/build-sidecar.mjs).
declare const __OPEN_ROCK_EMBEDDED__: Record<string, string> | undefined;
const embedded: Record<string, string> = typeof __OPEN_ROCK_EMBEDDED__ !== 'undefined' ? __OPEN_ROCK_EMBEDDED__ : {};

/** Load KEY=value pairs from .env in the working directory or the repo root. Real env vars win. */
function loadDotEnv() {
  const candidates = [path.resolve(process.cwd(), '.env'), path.resolve(process.cwd(), '..', '.env')];
  // The desktop app runs the server from an unknown working directory; let a .env in its data folder override too.
  if (process.env.OPEN_ROCK_DATA_DIR) candidates.unshift(path.join(process.env.OPEN_ROCK_DATA_DIR, '.env'));
  for (const file of candidates) {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 1) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      if (process.env[key] === undefined) process.env[key] = value;
    }
    break;
  }
}
loadDotEnv();

function env(name: string): string | undefined {
  const v = process.env[name];
  if (v !== undefined && v !== '') return v;
  return embedded[name] || undefined;
}

function envInt(name: string, fallback: number): number {
  const v = env(name);
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function findWebDir(): string | null {
  const explicit = env('OPEN_ROCK_WEB_DIR');
  if (explicit) return path.resolve(explicit);
  const candidates = [path.resolve(process.cwd(), 'web/dist'), path.resolve(process.cwd(), '../web/dist'), path.resolve(process.cwd(), 'public')];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'index.html'))) return c;
  }
  return null;
}

/** Host from OPEN_ROCK_DEDICATED_HOST, or the host part of an older OPEN_ROCK_DEDICATED_URL. Empty when neither is set. */
function dedicatedHost(): string {
  const raw = env('OPEN_ROCK_DEDICATED_HOST') ?? env('OPEN_ROCK_DEDICATED_URL');
  return (raw && parseServerAddress(raw)?.host) || '';
}

export const config = {
  version: '0.1.1',
  host: env('OPEN_ROCK_HOST') ?? '127.0.0.1',
  port: envInt('OPEN_ROCK_PORT', 8787),
  dataDir: path.resolve(env('OPEN_ROCK_DATA_DIR') ?? path.join(os.homedir(), '.open-rock')),
  /** When set, every API call must send `Authorization: Bearer <token>`. */
  authToken: env('OPEN_ROCK_AUTH_TOKEN') ?? '',
  webDir: findWebDir(),
  maxUploadBytes: envInt('OPEN_ROCK_MAX_UPLOAD_MB', 50) * 1024 * 1024,
  allowedOrigins: [
    'tauri://localhost',
    'http://tauri.localhost',
    'https://tauri.localhost',
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    ...(env('OPEN_ROCK_ALLOWED_ORIGINS') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  ],
  /**
   * An optional dedicated server named in .env. It starts the server list on first run, and a server at this host with no
   * token of its own uses this token. The token never leaves the server.
   */
  dedicated: {
    host: dedicatedHost(),
    token: env('OPEN_ROCK_DEDICATED_TOKEN') ?? '',
  },
  /** Set by the desktop shell so the sidecar exits if the app goes away. */
  parentPid: envInt('OPEN_ROCK_PARENT_PID', 0),
};

export function dataPath(...parts: string[]): string {
  return path.join(config.dataDir, ...parts);
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

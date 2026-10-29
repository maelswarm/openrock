// Bundles the server into one file (dist/index.mjs) that runs with plain Node, no node_modules needed.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [path.join(here, 'src/index.ts')],
  outfile: path.join(here, 'dist/index.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  alias: { '@open-rock/shared': path.join(here, '../shared/src/index.ts') },
  // Some AWS SDK dependencies still use require(); give the ESM bundle one.
  banner: { js: "import { createRequire as __openRockRequire } from 'node:module'; const require = __openRockRequire(import.meta.url);" },
  logLevel: 'info',
});

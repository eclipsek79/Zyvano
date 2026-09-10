#!/usr/bin/env node
/**
 * Deterministic esbuild bundler for the Zyvano server-side applications.
 *
 * Usage: node scripts/build.mjs apps/api
 *
 * Bundles the application (and the workspace-internal @zyvano/shared package)
 * into a single CommonJS file under <root>/../dist/<app>/index.js so that the
 * runtime image only needs Node plus the native/runtime dependencies marked as
 * external below.
 */
import { build } from 'esbuild';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

const target = process.argv[2];
if (!target) {
  console.error('usage: node scripts/build.mjs <app-dir>');
  process.exit(1);
}

/**
 * Workspace packages (@zyvano/shared, @zyvano/server) are resolved to their
 * TypeScript sources so a build never depends on a prior package compilation
 * step and can never pick up a stale dist.
 */
const workspaceAlias = {
  '@zyvano/shared': path.join(repoRoot, 'packages', 'shared', 'src', 'index.ts'),
  '@zyvano/server': path.join(repoRoot, 'packages', 'server', 'src', 'index.ts'),
};

/** Expands a subpath alias (e.g. @zyvano/server/db/pool) to the real file. */
const workspaceSubpathPlugin = {
  name: 'zyvano-workspace-subpaths',
  setup(build) {
    for (const [pkg, root] of Object.entries({
      '@zyvano/shared': path.join(repoRoot, 'packages', 'shared', 'src'),
      '@zyvano/server': path.join(repoRoot, 'packages', 'server', 'src'),
    })) {
      const filter = new RegExp(`^${pkg.replace(/\//g, '\\/')}\/(.+)$`);
      build.onResolve({ filter }, (args) => {
        const resolved = path.join(root, args.path.replace(`${pkg}/`, ''));
        for (const candidate of [`${resolved}.ts`, path.join(resolved, 'index.ts')]) {
          if (existsSync(candidate)) return { path: candidate };
        }
        return null;
      });
    }
  },
};

const appDir = path.resolve(repoRoot, target);
const entry = path.join(appDir, 'src', 'index.ts');
if (!existsSync(entry)) {
  console.error(`entry not found: ${entry}`);
  process.exit(1);
}

const appName = path.basename(appDir);
const outDir = path.join(repoRoot, 'dist', appName);
mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [entry],
  outfile: path.join(outDir, 'index.js'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
  logLevel: 'info',
  // Native / dynamic-require dependencies stay external and are resolved from node_modules.
  external: [
    'pg-native',
    'bullmq',
    'ioredis',
    'pg',
    'nodemailer',
    'busboy',
    '@aws-sdk/client-s3',
    '@aws-sdk/s3-request-presigner',
  ],
  plugins: [workspaceSubpathPlugin],
  alias: workspaceAlias,
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
});

console.log(`built ${appName} -> dist/${appName}/index.js`);

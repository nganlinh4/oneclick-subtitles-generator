import fs from 'fs';
import path from 'path';
import managedBuildContext from '../scripts/managed-build-context.js';
import { defineConfig } from 'vite';

const { assertFrontendInnerInvocation } = managedBuildContext;

const managedFrontendRoot = process.env.OSG_MANAGED_FRONTEND_ROOT;
const managedPromptDjOutput = process.env.OSG_PROMPTDJ_OUT_DIR;
const e2eBuild = process.env.OSG_E2E_FRONTEND_BUILD === '1';
const e2ePromptDjOutput = process.env.OSG_E2E_PROMPTDJ_DIST;
const e2eViteCache = process.env.OSG_E2E_VITE_CACHE_DIR;
if ((managedFrontendRoot === undefined) !== (managedPromptDjOutput === undefined)) {
  throw new Error('Managed PromptDJ output requires both frontend-root environment values.');
}
let outDir: string | undefined;
let cacheDir: string | undefined;
if (managedFrontendRoot !== undefined) {
  if (!path.isAbsolute(managedFrontendRoot) || !path.isAbsolute(managedPromptDjOutput!)) {
    throw new Error('Managed PromptDJ paths must be absolute.');
  }
  const root = path.resolve(managedFrontendRoot);
  outDir = path.resolve(managedPromptDjOutput!);
  if (outDir !== path.join(root, 'promptdj')) {
    throw new Error('Managed PromptDJ output escaped its exact frontend cache root.');
  }
  cacheDir = path.join(root, 'promptdj-vite-cache');
  const status = fs.lstatSync(root);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new Error('Managed frontend cache root must be a real directory.');
  }
}
if (e2eBuild) {
  if (managedFrontendRoot !== undefined) {
    throw new Error('E2E and ordinary managed PromptDJ builds cannot share one Vite process.');
  }
  if (!e2ePromptDjOutput || !e2eViteCache
    || !path.isAbsolute(e2ePromptDjOutput) || !path.isAbsolute(e2eViteCache)) {
    throw new Error('E2E PromptDJ output and Vite cache paths must be absolute.');
  }
  const workspaceRoot = path.dirname(path.resolve(e2ePromptDjOutput));
  if (path.resolve(e2ePromptDjOutput) !== path.join(workspaceRoot, 'promptdj')
    || path.resolve(e2eViteCache) !== path.join(workspaceRoot, 'promptdj-vite-cache')) {
    throw new Error('E2E PromptDJ paths escaped their exact frontend workspace.');
  }
  cacheDir = path.resolve(e2eViteCache);
}
if (!e2eBuild) {
  assertFrontendInnerInvocation({
    environment: process.env,
    repositoryRoot: path.resolve(__dirname, '..'),
  });
}

export default defineConfig({
  base: './',
  build: outDir === undefined ? undefined : { outDir },
  cacheDir,
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
});

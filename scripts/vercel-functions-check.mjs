#!/usr/bin/env node
/* ============================================================================
   FSN — VERCEL FUNCTION BUDGET CHECK

   `node scripts/vercel-functions-check.mjs`

   Vercel turns every file under `api/` into its own Serverless Function, and
   the plan this project deploys on allows twelve per deployment. Going over
   does NOT fail the build. The build succeeds, "Build Completed" is printed,
   and then the DEPLOY fails at patchBuild with

     exceeded_serverless_functions_per_deployment
     No more than 12 Serverless Functions can be added to a Deployment on the
     Hobby plan.

   which takes the whole production deployment down, not just the new route.
   That is exactly what adding api/blog/articles-publish.js as a thirteenth
   file did, and nothing in the repo would have caught it: no build step, no
   type error, every test green.

   So the budget is a check. A new endpoint shares an existing file behind an
   `?action=` rewrite, the way /api/notifications-register,
   /api/transaction-wire-dispatch, /api/auth/yahoo/callback and
   /api/blog/articles/publish already do.

   It also verifies every rewrite in vercel.json points at a function that
   exists, since a rewrite to a deleted or renamed file is a 404 that only
   shows up in production.

   Exit code 0 means clean.
============================================================================ */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/* The Hobby plan's ceiling. If the project moves to a Pro plan this number
   goes up; it is written here rather than inferred so the change is a
   deliberate edit with the plan named in the diff. */
const MAX_FUNCTIONS = 12;
const FUNCTION_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.go', '.py', '.rb']);

let failures = 0;
const pass = (msg) => console.log('  ok    ' + msg);
const fail = (msg) => { failures++; console.log('  FAIL  ' + msg); };

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const file = join(dir, name);
    if (statSync(file).isDirectory()) walk(file, out);
    else if (FUNCTION_EXTENSIONS.has(extname(name))) out.push(file.slice(root.length + 1));
  }
  return out;
}

const functions = walk(join(root, 'api')).sort();

console.log('[vercel-functions-check] ' + functions.length + ' function file(s) under api/:');
for (const file of functions) console.log('    ' + file);

if (functions.length <= MAX_FUNCTIONS) {
  pass(functions.length + ' of ' + MAX_FUNCTIONS + ' Serverless Functions used');
} else {
  fail(
    functions.length + ' function files under api/, but the plan allows ' + MAX_FUNCTIONS + '. ' +
    'The build will SUCCEED and the deploy will fail at patchBuild with ' +
    'exceeded_serverless_functions_per_deployment, taking production down. ' +
    'Put the handler in lib/ and dispatch to it from an existing route on an ' +
    '?action= rewrite, as vercel.json already does for four other endpoints.',
  );
}

/* Every rewrite destination must resolve to a function that exists. */
const vercel = JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf8'));
const rewrites = Array.isArray(vercel.rewrites) ? vercel.rewrites : [];
let checkedRewrites = 0;

for (const rule of rewrites) {
  const destination = String((rule && rule.destination) || '');
  if (!destination.startsWith('/api/')) continue;
  const path = destination.split('?')[0].replace(/^\/+/, '');
  const resolved = functions.some((file) => file.replace(/\.[^.]+$/, '') === path);
  checkedRewrites++;
  if (resolved) pass('rewrite ' + rule.source + ' -> ' + destination);
  else fail('rewrite ' + rule.source + ' -> ' + destination + ' names no function under api/');
}
if (!checkedRewrites) fail('no /api rewrites were checked, which means this scan is not scanning');

console.log(failures ? '\n[vercel-functions-check] FAILED' : '\n[vercel-functions-check] clean');
process.exit(failures ? 1 : 0);

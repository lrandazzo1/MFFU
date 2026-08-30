#!/usr/bin/env node
/* Compile Tailwind and INLINE it into each HTML file.
 *
 * These pages are distributed as single self-contained files — they get opened
 * straight from disk over file://, copied around, and served statically. An
 * external <link> silently strips every utility and the preflight reset the
 * moment a file travels without its sibling stylesheet, which looks like a
 * total style collapse rather than a missing asset. So the compiled CSS is
 * spliced between the markers below instead of shipped alongside.
 *
 * Usage: npm run build:css
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = ['index.html', 'league-media-studio.html'];
const START = '<!-- tailwind:start -->';
const END = '<!-- tailwind:end -->';

const tmp = path.join(os.tmpdir(), 'fsn-tailwind-' + process.pid + '.css');
execFileSync('npx', [
  'tailwindcss',
  '-c', path.join(ROOT, 'tailwind.config.js'),
  '-i', path.join(ROOT, 'src/tailwind.css'),
  '-o', tmp,
  '--minify',
], { stdio: 'inherit', cwd: ROOT });

const css = fs.readFileSync(tmp, 'utf8').trim();
fs.unlinkSync(tmp);

const block = START + '\n<style>' + css + '</style>\n' + END;

for (const file of TARGETS) {
  const full = path.join(ROOT, file);
  let html = fs.readFileSync(full, 'utf8');
  const a = html.indexOf(START);
  const b = html.indexOf(END);
  if (a === -1 || b === -1) {
    console.error(`  ${file}: markers not found — expected ${START} … ${END}`);
    process.exitCode = 1;
    continue;
  }
  html = html.slice(0, a) + block + html.slice(b + END.length);
  fs.writeFileSync(full, html);
  console.log(`  ${file}: inlined ${(css.length / 1024).toFixed(1)} KB of compiled CSS`);
}

#!/usr/bin/env node
/* ============================================================================
   FSN — EDITORIAL COMPILER
   ----------------------------------------------------------------------------
   Compiles structured editorial source files (Markdown with YAML frontmatter,
   or JSON) into `landing/content/blog/` in the exact schema that
   `scripts/build-blog.mjs` already consumes (see
   `landing/content/blog/README.md`). From there `npm run build:blog` picks
   them up like any hand-authored article and stamps the deploy payload.

   This script is intentionally dependency-free and network-free. It does not
   fetch anything from the outside world, does not require a league id, and
   does not call any external API. All content originates from local editorial
   source files that the editor drops into the source directory.

   The core content guardrails are preserved verbatim:

     * Em dashes (U+2014) and horizontal bars (U+2015) are rejected in every
       user-facing field, matching `landing/content/blog/README.md`.
     * Every entry in `entities` must appear verbatim (case-insensitive, after
       stripping markdown emphasis) in the article title or body. Ghost
       entities are rejected loudly instead of being silently dropped, so the
       author sees the mistake before it ships.
     * Slugs must be lowercase kebab-case (letters, digits, hyphens).

   Usage:
     node scripts/generate-editorial.mjs                # process default source dir
     node scripts/generate-editorial.mjs --source <dir> # read source files from <dir>
     node scripts/generate-editorial.mjs --out <dir>    # write compiled files to <dir>
     node scripts/generate-editorial.mjs --publish-date 2026-09-11
                                                        # fallback publishDate when a
                                                        # source article omits one
     node scripts/generate-editorial.mjs --self-test    # run the offline test suite

   After a run:
     npm run build:blog

   This script is additive: it only reads its source directory and writes into
   the blog content directory. It never touches index.html, the News Desk
   generators, Supabase wiring, or any historical data pipeline.
============================================================================ */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_SOURCE_DIR = path.join(ROOT, 'content', 'editorial');
const DEFAULT_OUT_DIR = path.join(ROOT, 'landing', 'content', 'blog');

// U+2014 EM DASH and U+2015 HORIZONTAL BAR are banned everywhere in FSN blog
// copy (see landing/content/blog/README.md). Mirrored here so a compiled
// article can never slip past the build-blog.mjs punctuation check.
const BANNED_CHARS = /[—―]/;
const REQUIRED_META = ['title', 'slug', 'publishDate', 'category', 'excerpt'];
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function normName(s) {
  return String(s == null ? '' : s)
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/* ------------------------------------------------------------------ *
 * CLI args
 * ------------------------------------------------------------------ */
function parseArgs(argv) {
  const args = {
    source: DEFAULT_SOURCE_DIR,
    out: DEFAULT_OUT_DIR,
    publishDate: null,
    selfTest: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--source') args.source = path.resolve(argv[++i]);
    else if (a === '--out') args.out = path.resolve(argv[++i]);
    else if (a === '--publish-date') args.publishDate = argv[++i];
    else if (a === '--self-test') args.selfTest = true;
  }
  return args;
}

/* ------------------------------------------------------------------ *
 * Minimal YAML frontmatter parser. Same shape build-blog.mjs uses:
 * scalar keys and a `- key: value` list of maps for `entities`.
 * ------------------------------------------------------------------ */
function parseScalar(raw) {
  const v = String(raw).trim();
  if (v === '') return '';
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  if (v === 'true') return true;
  if (v === 'false') return false;
  return v;
}

function parseFrontmatter(block) {
  const meta = {};
  const lines = block.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') { i++; continue; }
    const m = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!m) { i++; continue; }
    const key = m[1];
    const rest = m[2];
    if (rest.trim() === '') {
      const items = [];
      i++;
      while (i < lines.length && /^\s*-\s+/.test(lines[i])) {
        const item = {};
        const firstProp = lines[i].replace(/^\s*-\s+/, '');
        const fp = firstProp.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
        if (fp) item[fp[1]] = parseScalar(fp[2]);
        i++;
        while (i < lines.length && /^\s+[A-Za-z0-9_]+:/.test(lines[i]) && !/^\s*-\s+/.test(lines[i])) {
          const sp = lines[i].trim().match(/^([A-Za-z0-9_]+):\s*(.*)$/);
          if (sp) item[sp[1]] = parseScalar(sp[2]);
          i++;
        }
        items.push(item);
      }
      meta[key] = items;
    } else {
      meta[key] = parseScalar(rest);
      i++;
    }
  }
  return meta;
}

/* ------------------------------------------------------------------ *
 * Load one source file into a normalized editorial record.
 * ------------------------------------------------------------------ */
function normalizeEntities(raw, file) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    throw new Error(`[generate-editorial] ${file}: "entities" must be an array`);
  }
  return raw.map((e, idx) => {
    if (typeof e !== 'object' || e == null) {
      throw new Error(`[generate-editorial] ${file}: entity #${idx + 1} is not an object`);
    }
    const name = String(e.name || '').trim();
    if (!name) {
      throw new Error(`[generate-editorial] ${file}: entity #${idx + 1} is missing "name"`);
    }
    const position = e.position != null ? String(e.position).trim() : '';
    const sleeperPlayerId = (e.sleeperPlayerId != null ? String(e.sleeperPlayerId)
      : e.player_id != null ? String(e.player_id) : '').trim();
    return { name, position, sleeperPlayerId };
  });
}

function loadSourceFile(sourceDir, file, fallbackPublishDate) {
  const ext = path.extname(file).toLowerCase();
  const full = path.join(sourceDir, file);
  const rawText = fs.readFileSync(full, 'utf8');
  let meta = {};
  let body = '';
  let format = 'markdown';

  if (ext === '.json') {
    format = 'json';
    let parsed;
    try { parsed = JSON.parse(rawText); }
    catch (err) {
      throw new Error(`[generate-editorial] ${file}: invalid JSON (${err.message})`);
    }
    if (typeof parsed !== 'object' || parsed == null || Array.isArray(parsed)) {
      throw new Error(`[generate-editorial] ${file}: JSON source must be an object`);
    }
    meta = parsed;
    body = typeof parsed.body === 'string' ? parsed.body : '';
  } else if (ext === '.md' || ext === '.mdx') {
    const fm = rawText.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
    if (!fm) {
      throw new Error(`[generate-editorial] ${file}: markdown source is missing a frontmatter block delimited by "---"`);
    }
    meta = parseFrontmatter(fm[1]);
    body = fm[2] || '';
  } else {
    return null;
  }

  const slugFromName = path.basename(file, ext);
  const article = {
    title: meta.title != null ? String(meta.title).trim() : '',
    slug: (meta.slug != null ? String(meta.slug) : slugFromName).trim(),
    publishDate: meta.publishDate != null ? String(meta.publishDate).trim()
      : (fallbackPublishDate || '').trim(),
    category: meta.category != null ? String(meta.category).trim() : '',
    excerpt: meta.excerpt != null ? String(meta.excerpt).trim() : '',
    author: meta.author != null ? String(meta.author).trim() : 'FSN Desk',
    entities: normalizeEntities(meta.entities, file),
    body,
    format,
    sourceFile: file,
  };

  return article;
}

/* ------------------------------------------------------------------ *
 * Guardrails. Every rule below mirrors a rule build-blog.mjs enforces,
 * so an article that compiles here cannot fail the blog build. They run
 * BEFORE writing anything so a bad source file never lands in
 * landing/content/blog/.
 * ------------------------------------------------------------------ */
function validateArticle(article) {
  for (const key of REQUIRED_META) {
    if (!article[key]) {
      throw new Error(`[generate-editorial] ${article.sourceFile}: missing required field "${key}"`);
    }
  }
  if (!SLUG_RE.test(article.slug)) {
    throw new Error(`[generate-editorial] ${article.sourceFile}: slug "${article.slug}" is not lowercase kebab-case`);
  }
  if (Number.isNaN(Date.parse(article.publishDate))) {
    throw new Error(`[generate-editorial] ${article.sourceFile}: publishDate "${article.publishDate}" is not a parseable date (use YYYY-MM-DD)`);
  }
  if (!article.entities.length) {
    throw new Error(`[generate-editorial] ${article.sourceFile}: articles must list at least one entity so the reader tray has something to map`);
  }

  const haystack = normName(article.title + ' ' + article.body);
  for (const e of article.entities) {
    if (!haystack.includes(normName(e.name))) {
      throw new Error(`[generate-editorial] ${article.sourceFile}: entity "${e.name}" is not named verbatim in the article title or body; refusing to ship a ghost entity`);
    }
  }

  const scanFields = [article.title, article.slug, article.category, article.excerpt, article.author, article.body,
    ...article.entities.map((e) => e.name)];
  for (const field of scanFields) {
    if (BANNED_CHARS.test(String(field))) {
      throw new Error(`[generate-editorial] ${article.sourceFile}: em dash (or horizontal bar) found in "${field}". Break clauses with periods, commas, or colons instead.`);
    }
  }
}

/* ------------------------------------------------------------------ *
 * Serialization. Markdown sources round-trip as markdown, JSON sources
 * round-trip as JSON, so the compiled file mirrors the shape the editor
 * authored.
 * ------------------------------------------------------------------ */
function serializeMarkdown(article) {
  const lines = ['---'];
  lines.push(`title: ${article.title}`);
  lines.push(`slug: ${article.slug}`);
  lines.push(`publishDate: ${article.publishDate}`);
  lines.push(`category: ${article.category}`);
  lines.push(`excerpt: ${article.excerpt}`);
  lines.push(`author: ${article.author}`);
  lines.push('entities:');
  for (const e of article.entities) {
    lines.push(`  - name: ${e.name}`);
    if (e.position) lines.push(`    position: ${e.position}`);
    if (e.sleeperPlayerId) lines.push(`    sleeperPlayerId: "${e.sleeperPlayerId}"`);
  }
  lines.push('---');
  lines.push('');
  lines.push(article.body.replace(/\s+$/g, ''));
  return lines.join('\n') + '\n';
}

function serializeJson(article) {
  const record = {
    title: article.title,
    slug: article.slug,
    publishDate: article.publishDate,
    category: article.category,
    excerpt: article.excerpt,
    author: article.author,
    entities: article.entities.map((e) => {
      const out = { name: e.name };
      if (e.position) out.position = e.position;
      if (e.sleeperPlayerId) out.sleeperPlayerId = e.sleeperPlayerId;
      return out;
    }),
    body: article.body,
  };
  return JSON.stringify(record, null, 2) + '\n';
}

/* ------------------------------------------------------------------ *
 * Compile
 * ------------------------------------------------------------------ */
function compile({ source, out, publishDate }) {
  if (!fs.existsSync(source)) {
    throw new Error(`[generate-editorial] source directory not found: ${source}. Drop editorial .md/.mdx/.json files there, or pass --source <dir>.`);
  }
  const stat = fs.statSync(source);
  if (!stat.isDirectory()) {
    throw new Error(`[generate-editorial] source path is not a directory: ${source}`);
  }

  const files = fs.readdirSync(source)
    .filter((f) => /\.(json|md|mdx)$/i.test(f) && f.toLowerCase() !== 'readme.md')
    .sort();

  if (!files.length) {
    console.log(`[generate-editorial] no source articles in ${source}; nothing to compile.`);
    return [];
  }

  const compiled = [];
  const seenSlugs = new Map();

  for (const file of files) {
    const article = loadSourceFile(source, file, publishDate);
    if (!article) continue;
    validateArticle(article);
    if (seenSlugs.has(article.slug)) {
      throw new Error(`[generate-editorial] ${file}: duplicate slug "${article.slug}" (also in ${seenSlugs.get(article.slug)})`);
    }
    seenSlugs.set(article.slug, file);
    compiled.push(article);
  }

  fs.mkdirSync(out, { recursive: true });
  const written = [];
  for (const article of compiled) {
    const ext = article.format === 'json' ? '.json' : '.md';
    const outFile = path.join(out, article.slug + ext);
    const body = article.format === 'json' ? serializeJson(article) : serializeMarkdown(article);
    fs.writeFileSync(outFile, body, 'utf8');
    written.push(outFile);
    console.log(`[generate-editorial] wrote ${path.relative(ROOT, outFile)}`);
  }
  return written;
}

/* ------------------------------------------------------------------ *
 * Self-test: exercises the full pipeline (parse, guardrails, write) with
 * in-memory fixtures, so `npm run check:editorial` runs offline and
 * needs no external service to stay green.
 * ------------------------------------------------------------------ */
const SELF_TEST_MD = `---
title: Week one recap: who carried their squad
slug: week-1-recap
publishDate: 2026-09-16
category: Recap
excerpt: The week one slate is final. Here is what happened and who won it.
author: FSN Desk
entities:
  - name: Test Player One
    position: WR
    sleeperPlayerId: "1001"
  - name: Test Player Two
    position: RB
    sleeperPlayerId: "1002"
---

The week one slate is final. Here is what happened.

## Alice All Stars beat Bob

Alice All Stars leaned on **Test Player One**, whose day was the difference.
Bob still got a starter effort from **Test Player Two**, but not enough to
close the gap.
`;

const SELF_TEST_JSON = {
  title: 'Waiver watch: two names to bid on',
  slug: 'waiver-watch-week-1',
  publishDate: '2026-09-11',
  category: 'Waiver Wire',
  excerpt: 'Two low-owned names worth a real bid before Wednesday.',
  author: 'FSN Desk',
  entities: [
    { name: 'Kimani Vidal', position: 'RB' },
    { name: 'Jalen McMillan', position: 'WR' },
  ],
  body: '**Kimani Vidal** stepped into first-team reps and is still low-owned. **Jalen McMillan** ran a full route tree and is available on most wires.',
};

function writeFixture(dir, name, body) {
  fs.writeFileSync(path.join(dir, name), body, 'utf8');
}

async function runSelfTest() {
  const failures = [];
  const check = (cond, msg) => { if (!cond) failures.push(msg); };

  const tmpSource = fs.mkdtempSync(path.join(os.tmpdir(), 'fsn-editorial-src-'));
  const tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), 'fsn-editorial-out-'));

  try {
    writeFixture(tmpSource, 'week-1-recap.md', SELF_TEST_MD);
    writeFixture(tmpSource, 'waiver-watch-week-1.json', JSON.stringify(SELF_TEST_JSON, null, 2));

    // 1. Determinism: same input, same output, twice.
    let firstMd = null;
    let firstJson = null;
    for (let run = 1; run <= 2; run++) {
      compile({ source: tmpSource, out: tmpOut, publishDate: null });
      const md = fs.readFileSync(path.join(tmpOut, 'week-1-recap.md'), 'utf8');
      const jsn = fs.readFileSync(path.join(tmpOut, 'waiver-watch-week-1.json'), 'utf8');
      if (run === 1) { firstMd = md; firstJson = jsn; }
      else {
        check(md === firstMd, 'markdown compile must be deterministic across runs');
        check(jsn === firstJson, 'json compile must be deterministic across runs');
      }
    }

    // 2. Round-trip: written files carry the fields the blog build needs.
    check(firstMd.includes('title: Week one recap: who carried their squad'), 'expected markdown title round-trip');
    check(firstMd.includes('sleeperPlayerId: "1001"'), 'expected sleeperPlayerId to be quoted in markdown output');
    check(firstMd.includes('**Test Player One**'), 'expected markdown body to round-trip verbatim');
    check(firstJson.includes('"slug": "waiver-watch-week-1"'), 'expected json slug round-trip');
    check(firstJson.includes('"category": "Waiver Wire"'), 'expected json category round-trip');
    check(!BANNED_CHARS.test(firstMd), 'expected no em dash in compiled markdown');
    check(!BANNED_CHARS.test(firstJson), 'expected no em dash in compiled json');

    // 3. Em dash rejection.
    const badDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsn-editorial-bad-'));
    try {
      writeFixture(badDir, 'em-dash.md', `---\ntitle: Something — else\nslug: em-dash\npublishDate: 2026-09-11\ncategory: Analysis\nexcerpt: nope\nauthor: FSN Desk\nentities:\n  - name: Justin Jefferson\n---\n\nJustin Jefferson stayed put.\n`);
      let threw = false;
      try { compile({ source: badDir, out: tmpOut, publishDate: null }); }
      catch (err) { threw = /em dash/.test(err.message); }
      check(threw, 'expected an em dash in a source file to abort the compile with a clear message');
    } finally {
      fs.rmSync(badDir, { recursive: true, force: true });
    }

    // 4. Ghost entity rejection.
    const ghostDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsn-editorial-ghost-'));
    try {
      writeFixture(ghostDir, 'ghost.md', `---\ntitle: A safe title\nslug: ghost\npublishDate: 2026-09-11\ncategory: Analysis\nexcerpt: fine\nauthor: FSN Desk\nentities:\n  - name: Nobody Mentioned\n---\n\nThe body never names the entity.\n`);
      let threw = false;
      try { compile({ source: ghostDir, out: tmpOut, publishDate: null }); }
      catch (err) { threw = /ghost entity/.test(err.message); }
      check(threw, 'expected a ghost entity (unnamed in the body) to abort the compile');
    } finally {
      fs.rmSync(ghostDir, { recursive: true, force: true });
    }

    // 5. Slug hygiene.
    const slugDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsn-editorial-slug-'));
    try {
      writeFixture(slugDir, 'ok.md', `---\ntitle: Slug hygiene\nslug: NotKebabCase\npublishDate: 2026-09-11\ncategory: Analysis\nexcerpt: fine\nauthor: FSN Desk\nentities:\n  - name: Justin Jefferson\n---\n\nJustin Jefferson holds the target share.\n`);
      let threw = false;
      try { compile({ source: slugDir, out: tmpOut, publishDate: null }); }
      catch (err) { threw = /kebab-case/.test(err.message); }
      check(threw, 'expected a non kebab-case slug to abort the compile');
    } finally {
      fs.rmSync(slugDir, { recursive: true, force: true });
    }

    // 6. No CLI flags required. Compile ran with no --league, no --source, no
    //    --publish-date argument in step 1; getting here proves it.
    check(true, 'compile ran without --league, --source, or --publish-date');

    // 7. Missing publishDate falls back to --publish-date when provided.
    const dateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsn-editorial-date-'));
    const dateOut = fs.mkdtempSync(path.join(os.tmpdir(), 'fsn-editorial-date-out-'));
    try {
      writeFixture(dateDir, 'nodate.md', `---\ntitle: No date in the source\nslug: nodate\ncategory: Analysis\nexcerpt: fine\nauthor: FSN Desk\nentities:\n  - name: Justin Jefferson\n---\n\nJustin Jefferson still leads the league.\n`);
      compile({ source: dateDir, out: dateOut, publishDate: '2026-09-11' });
      const out = fs.readFileSync(path.join(dateOut, 'nodate.md'), 'utf8');
      check(/publishDate: 2026-09-11/.test(out), 'expected --publish-date to be used when a source file omits publishDate');
    } finally {
      fs.rmSync(dateDir, { recursive: true, force: true });
      fs.rmSync(dateOut, { recursive: true, force: true });
    }

    // 8. Empty source directory is a no-op, not an error.
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsn-editorial-empty-'));
    try {
      const written = compile({ source: emptyDir, out: tmpOut, publishDate: null });
      check(Array.isArray(written) && written.length === 0, 'expected an empty source directory to be a no-op');
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(tmpSource, { recursive: true, force: true });
    fs.rmSync(tmpOut, { recursive: true, force: true });
  }

  if (failures.length) {
    console.error('[generate-editorial] SELF-TEST FAILED:');
    for (const f of failures) console.error('  - ' + f);
    process.exit(1);
  }
  console.log('[generate-editorial] self-test passed: markdown and json compile, guardrails (em dashes, ghost entities, slug hygiene) all verified offline.');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) {
    await runSelfTest();
    return;
  }
  try {
    const written = compile(args);
    if (written.length) {
      console.log(`[generate-editorial] done. Run "npm run build:blog" to compile ${written.length} article(s) into the deploy payload.`);
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

main();

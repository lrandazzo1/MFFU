#!/usr/bin/env node
/**
 * FSN Blog ingestion pipeline.
 *
 * Reads local source articles dropped into `content/blog/` (JSON, Markdown, or
 * MDX) and compiles them into a static, deploy-ready payload the public blog
 * pages fetch at runtime:
 *
 *   content/generated/blog/index.json        -> manifest (metadata list)
 *   content/generated/blog/posts/<slug>.json -> normalized article + rendered body
 *
 * The pipeline is deliberately dependency-free so it runs in the Vercel build
 * environment and in `npm run` without an install step. It is additive: it only
 * reads `content/blog/**` and writes `content/generated/blog/**`. It never
 * touches index.html, the News Desk generators, Supabase wiring, or any
 * historical data pipeline.
 *
 * Punctuation contract: em dashes are rejected everywhere (titles, metadata,
 * body). Clauses are broken with periods, commas, or colons. The build fails
 * loudly if an em dash is found so bad copy never ships.
 *
 * Usage:
 *   node scripts/build-blog.mjs           # build the payload
 *   node scripts/build-blog.mjs --check   # verify only, write nothing, exit 1 on drift
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The blog is served on the root domain (fantasysportsnetwork.app) by the
// `fsn-landing` Vercel project, whose deploy root is `landing/`. Source lives
// in landing/content/blog and the compiled payload lands in
// landing/content/generated/blog so the landing deploy serves it directly at
// /content/generated/blog/**.
const SRC_DIR = path.join(ROOT, 'landing', 'content', 'blog');
const OUT_DIR = path.join(ROOT, 'landing', 'content', 'generated', 'blog');
const POSTS_DIR = path.join(OUT_DIR, 'posts');
// The reader is a static shell that resolves its slug from the URL path. The
// landing project runs cleanUrls, which serves an extensionless path from a
// matching .html file BEFORE any rewrite is consulted, so a single
// /blog/:slug rewrite does not fire. To make every article slug resolve on
// the root domain we stamp one page per slug (a verbatim copy of the reader
// shell) into landing/blog/, which cleanUrls then serves at /blog/<slug>.
const PAGES_DIR = path.join(ROOT, 'landing', 'blog');
const READER_TEMPLATE = path.join(PAGES_DIR, 'reader.html');
// Hand-authored shells in landing/blog that the build must never delete.
const RESERVED_PAGES = new Set(['index.html', 'reader.html']);

const CHECK_ONLY = process.argv.includes('--check');

// U+2014 EM DASH is banned. U+2015 HORIZONTAL BAR reads the same and is also
// banned. En dashes and hyphens are allowed (they are legitimate ranges/joins).
const BANNED_CHARS = /[—―]/;
const REQUIRED_META = ['title', 'slug', 'publishDate', 'category', 'excerpt'];

const errors = [];
const fail = (msg) => errors.push(msg);

/* ------------------------------------------------------------------ *
 * Minimal YAML frontmatter parser
 * Supports the subset our schema needs: scalars, quoted scalars, and
 * a list of `- key: value` maps (the entities array). No external deps.
 * ------------------------------------------------------------------ */
function parseScalar(raw) {
  let v = String(raw).trim();
  if (v === '') return '';
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  if (v === 'true') return true;
  if (v === 'false') return false;
  return v;
}

function parseFrontmatter(block, file) {
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
      // Could be a block list (entities). Collect indented `- ` items.
      const items = [];
      i++;
      while (i < lines.length && /^\s*-\s+/.test(lines[i])) {
        // First property of the item is on the dash line.
        const item = {};
        let firstProp = lines[i].replace(/^\s*-\s+/, '');
        const fp = firstProp.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
        if (fp) item[fp[1]] = parseScalar(fp[2]);
        i++;
        // Subsequent indented `key: value` lines belong to the same item.
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
 * Minimal, safe Markdown renderer.
 * Escapes HTML first (content is trusted but we never emit raw markup),
 * then applies a conservative block + inline grammar.
 * ------------------------------------------------------------------ */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderInline(text) {
  let t = escapeHtml(text);
  // Links: [label](url) — only http(s) and root-relative destinations.
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (full, label, url) => {
    const safe = /^(https?:\/\/|\/)/.test(url) ? url : '#';
    const ext = /^https?:\/\//.test(safe) ? ' target="_blank" rel="noopener"' : '';
    return `<a href="${safe}"${ext}>${label}</a>`;
  });
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  return t;
}

function renderMarkdown(md) {
  const lines = String(md).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;
  let listBuf = null; // { type: 'ul'|'ol', items: [] }

  const flushList = () => {
    if (!listBuf) return;
    const tag = listBuf.type;
    out.push(`<${tag}>` + listBuf.items.map((x) => `<li>${renderInline(x)}</li>`).join('') + `</${tag}>`);
    listBuf = null;
  };

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === '') { flushList(); i++; continue; }

    const h = trimmed.match(/^(#{1,4})\s+(.*)$/);
    if (h) { flushList(); const lvl = h[1].length; out.push(`<h${lvl}>${renderInline(h[2])}</h${lvl}>`); i++; continue; }

    if (/^(---|\*\*\*|___)$/.test(trimmed)) { flushList(); out.push('<hr>'); i++; continue; }

    if (/^>\s?/.test(trimmed)) {
      flushList();
      const quote = [];
      while (i < lines.length && /^>\s?/.test(lines[i].trim())) { quote.push(lines[i].trim().replace(/^>\s?/, '')); i++; }
      out.push(`<blockquote>${renderInline(quote.join(' '))}</blockquote>`);
      continue;
    }

    const ul = trimmed.match(/^[-*]\s+(.*)$/);
    if (ul) {
      if (!listBuf || listBuf.type !== 'ul') { flushList(); listBuf = { type: 'ul', items: [] }; }
      listBuf.items.push(ul[1]); i++; continue;
    }
    const ol = trimmed.match(/^\d+\.\s+(.*)$/);
    if (ol) {
      if (!listBuf || listBuf.type !== 'ol') { flushList(); listBuf = { type: 'ol', items: [] }; }
      listBuf.items.push(ol[1]); i++; continue;
    }

    // Paragraph: gather until blank line or block start.
    flushList();
    const para = [trimmed];
    i++;
    while (i < lines.length && lines[i].trim() !== '' &&
      !/^(#{1,4}\s|>|[-*]\s|\d+\.\s|---|\*\*\*|___)/.test(lines[i].trim())) {
      para.push(lines[i].trim()); i++;
    }
    out.push(`<p>${renderInline(para.join(' '))}</p>`);
  }
  flushList();
  return out.join('\n');
}

/* ------------------------------------------------------------------ *
 * Load + normalize one source file into an article record.
 * ------------------------------------------------------------------ */
function normalizeEntities(raw, file) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) { fail(`${file}: "entities" must be an array`); return []; }
  return raw.map((e, idx) => {
    if (typeof e !== 'object' || e == null) { fail(`${file}: entity #${idx + 1} is not an object`); return null; }
    const name = String(e.name || '').trim();
    if (!name) fail(`${file}: entity #${idx + 1} is missing "name"`);
    const position = e.position != null ? String(e.position).trim() : '';
    // Sleeper player_id is a string in Sleeper's API. Normalize to string.
    const sleeperPlayerId = (e.sleeperPlayerId != null ? String(e.sleeperPlayerId)
      : e.player_id != null ? String(e.player_id) : '').trim();
    return { name, position, sleeperPlayerId };
  }).filter(Boolean);
}

function scanForBannedPunctuation(article, file) {
  const fields = {
    title: article.title,
    slug: article.slug,
    category: article.category,
    excerpt: article.excerpt,
    author: article.author,
    body: article.body,
  };
  for (const [key, val] of Object.entries(fields)) {
    if (val && BANNED_CHARS.test(String(val))) {
      fail(`${file}: em dash (or horizontal bar) found in "${key}". Break clauses with periods, commas, or colons instead.`);
    }
  }
  for (const ent of article.entities || []) {
    if (BANNED_CHARS.test(ent.name || '')) fail(`${file}: em dash found in entity name "${ent.name}".`);
  }
}

function loadFile(file) {
  const full = path.join(SRC_DIR, file);
  const rawText = fs.readFileSync(full, 'utf8');
  const ext = path.extname(file).toLowerCase();
  let meta = {};
  let body = '';
  let format = 'markdown';

  if (ext === '.json') {
    format = 'json';
    let parsed;
    try { parsed = JSON.parse(rawText); }
    catch (err) { fail(`${file}: invalid JSON (${err.message})`); return null; }
    meta = parsed;
    body = typeof parsed.body === 'string' ? parsed.body : '';
  } else if (ext === '.md' || ext === '.mdx') {
    const fm = rawText.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
    if (!fm) { fail(`${file}: markdown file is missing a frontmatter block delimited by "---"`); return null; }
    meta = parseFrontmatter(fm[1], file);
    body = fm[2] || '';
  } else {
    return null; // ignore unrelated files
  }

  const slugFromName = path.basename(file, ext);
  const article = {
    title: meta.title != null ? String(meta.title).trim() : '',
    slug: (meta.slug != null ? String(meta.slug) : slugFromName).trim(),
    publishDate: meta.publishDate != null ? String(meta.publishDate).trim() : '',
    category: meta.category != null ? String(meta.category).trim() : '',
    excerpt: meta.excerpt != null ? String(meta.excerpt).trim() : '',
    author: meta.author != null ? String(meta.author).trim() : 'FSN Desk',
    body,
    entities: normalizeEntities(meta.entities, file),
    format,
    sourceFile: file,
  };

  for (const key of REQUIRED_META) {
    if (!article[key]) fail(`${file}: missing required field "${key}"`);
  }
  if (article.slug && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(article.slug)) {
    fail(`${file}: slug "${article.slug}" must be lowercase kebab-case (letters, digits, hyphens).`);
  }
  if (article.publishDate && Number.isNaN(Date.parse(article.publishDate))) {
    fail(`${file}: publishDate "${article.publishDate}" is not a parseable date (use YYYY-MM-DD).`);
  }

  scanForBannedPunctuation(article, file);
  return article;
}

/* ------------------------------------------------------------------ *
 * Build
 * ------------------------------------------------------------------ */
function build() {
  if (!fs.existsSync(SRC_DIR)) {
    console.error(`[blog] source directory not found: ${SRC_DIR}`);
    process.exit(1);
  }

  const files = fs.readdirSync(SRC_DIR)
    .filter((f) => /\.(json|md|mdx)$/i.test(f) && f.toLowerCase() !== 'readme.md');

  const articles = [];
  const seenSlugs = new Map();

  for (const file of files) {
    const article = loadFile(file);
    if (!article) continue;
    if (seenSlugs.has(article.slug)) {
      fail(`${file}: duplicate slug "${article.slug}" (also in ${seenSlugs.get(article.slug)})`);
      continue;
    }
    seenSlugs.set(article.slug, file);
    articles.push(article);
  }

  if (errors.length) {
    console.error('\n[blog] ingestion failed with ' + errors.length + ' error(s):');
    for (const e of errors) console.error('  - ' + e);
    process.exit(1);
  }

  articles.sort((a, b) => Date.parse(b.publishDate) - Date.parse(a.publishDate));

  const manifest = {
    generatedAt: new Date().toISOString(),
    count: articles.length,
    posts: articles.map((a) => ({
      title: a.title,
      slug: a.slug,
      publishDate: a.publishDate,
      category: a.category,
      excerpt: a.excerpt,
      author: a.author,
      entityCount: a.entities.length,
    })),
  };

  const posts = articles.map((a) => ({
    title: a.title,
    slug: a.slug,
    publishDate: a.publishDate,
    category: a.category,
    excerpt: a.excerpt,
    author: a.author,
    format: a.format,
    entities: a.entities,
    bodyHtml: renderMarkdown(a.body),
  }));

  if (CHECK_ONLY) {
    let drift = false;
    const manifestPath = path.join(OUT_DIR, 'index.json');
    if (!fs.existsSync(manifestPath)) { console.error('[blog] check: manifest not generated. Run: npm run build:blog'); drift = true; }
    else {
      const existing = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const norm = (m) => JSON.stringify(m.posts);
      if (norm(existing) !== norm(manifest)) { console.error('[blog] check: manifest is stale. Run: npm run build:blog'); drift = true; }
    }
    if (drift) process.exit(1);
    console.log(`[blog] check passed. ${articles.length} article(s), punctuation clean.`);
    return;
  }

  fs.mkdirSync(POSTS_DIR, { recursive: true });
  // Clear stale generated posts.
  for (const f of fs.readdirSync(POSTS_DIR)) {
    if (f.endsWith('.json')) fs.unlinkSync(path.join(POSTS_DIR, f));
  }
  fs.writeFileSync(path.join(OUT_DIR, 'index.json'), JSON.stringify(manifest, null, 2) + '\n');
  for (const post of posts) {
    fs.writeFileSync(path.join(POSTS_DIR, post.slug + '.json'), JSON.stringify(post, null, 2) + '\n');
  }

  // Stamp one static reader page per slug so cleanUrls serves /blog/<slug>.
  const readerShell = fs.readFileSync(READER_TEMPLATE, 'utf8');
  const wantSlugPages = new Set(posts.map((p) => p.slug + '.html'));
  for (const f of fs.readdirSync(PAGES_DIR)) {
    if (f.endsWith('.html') && !RESERVED_PAGES.has(f) && !wantSlugPages.has(f)) {
      fs.unlinkSync(path.join(PAGES_DIR, f)); // remove pages for deleted articles
    }
  }
  for (const post of posts) {
    fs.writeFileSync(path.join(PAGES_DIR, post.slug + '.html'), readerShell);
  }

  console.log(`[blog] built ${posts.length} article(s) -> landing/content/generated/blog/ + landing/blog/<slug>.html`);
  for (const p of posts) console.log(`  - ${p.slug} (${p.entities.length} entit${p.entities.length === 1 ? 'y' : 'ies'})`);
}

build();

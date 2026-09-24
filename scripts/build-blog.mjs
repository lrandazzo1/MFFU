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

const SITEMAP_PATH = path.join(ROOT, 'landing', 'sitemap.xml');

/* ONE canonical origin for every absolute URL the build emits: the <title>
   suffix's companion in og:url, the canonical link, and every <loc> in the
   sitemap. It matches the host already baked into the deployed og:image and
   the existing sitemap. Canonical, og:url and sitemap MUST agree on the host
   or a crawler treats www and apex as two sites and splits the ranking, so
   this is deliberately a single constant rather than a string repeated in
   five templates. */
const SITE_ORIGIN = 'https://www.fantasysportsnetwork.app';

/* Pages that exist on the landing deploy and are not articles. Listed here so
   the generated sitemap carries the whole site rather than only the blog. */
const STATIC_ROUTES = ['/', '/blog', '/support', '/privacy', '/terms'];

const CHECK_ONLY = process.argv.includes('--check');

// U+2014 EM DASH is banned. U+2015 HORIZONTAL BAR reads the same and is also
// banned. En dashes and hyphens are allowed (they are legitimate ranges/joins).
const BANNED_CHARS = /[—―]/;
const REQUIRED_META = ['title', 'slug', 'publishDate', 'category', 'excerpt'];

// Normalize a string for name matching: strip markdown emphasis/backticks,
// collapse whitespace (names split across a wrapped line still match), lowercase.
const normName = (s) => String(s == null ? '' : s)
  .replace(/[*_`~]/g, '')
  .replace(/\s+/g, ' ')
  .trim()
  .toLowerCase();

// Consensus-owned roster anchors: locked-in starters and universally drafted
// players who are never legitimate standard 12-team waiver claims. Waiver Wire
// stories must focus on true low-owned targets, direct injury replacements, or
// viable streaming options instead. Matched case-insensitively by normalized
// full name. Extend this list as the consensus baseline shifts week to week.
const WAIVER_ANCHOR_BLOCKLIST = new Set([
  'christian mccaffrey', 'bijan robinson', 'saquon barkley', 'jahmyr gibbs',
  'jaylen warren', 'derrick henry', 'jonathan taylor', 'de\'von achane',
  'justin jefferson', 'ja\'marr chase', 'ceedee lamb', 'amon-ra st. brown',
  'jayden reed', 'a.j. brown', 'tyreek hill', 'puka nacua', 'nico collins',
  'sam laporta', 'travis kelce', 'trey mcbride', 'george kittle',
  'josh allen', 'lamar jackson', 'jalen hurts', 'patrick mahomes',
]);

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

// Ghost-entity guard: a player only belongs in the "Players in this story"
// tray if their exact display name is actually mentioned in the article title
// or body copy (headings included). Orphaned entity IDs that no reader ever
// sees named in the prose are dropped so the tray maps only real mentions.
function filterMentionedEntities(article, file) {
  const haystack = normName(article.title + ' ' + article.body);
  article.entities = (article.entities || []).filter((ent) => {
    const nm = normName(ent.name);
    if (nm && haystack.includes(nm)) return true;
    console.warn(`[blog] ${file}: dropping ghost entity "${ent.name}" (not mentioned in the article body or headings).`);
    return false;
  });
}

// Waiver Wire realism guard: a Waiver Wire story may not recommend a
// consensus-owned roster anchor (a universally drafted starter). These claims
// are never available on a standard 12-team wire, so featuring one is a build
// error. Waiver stories must feature true low-owned targets, direct injury
// replacements, or viable streaming options. Runs after ghost filtering, so it
// only inspects players the article actually features.
function enforceWaiverConstraints(article, file) {
  if (!/waiver/i.test(article.category || '')) return;
  for (const ent of article.entities || []) {
    if (WAIVER_ANCHOR_BLOCKLIST.has(normName(ent.name))) {
      fail(`${file}: "${ent.name}" is a consensus-owned roster anchor and cannot be recommended as a waiver claim. Waiver Wire stories must feature true low-owned targets, direct injury replacements, or standard 12-team streaming options.`);
    }
  }
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

  filterMentionedEntities(article, file);
  enforceWaiverConstraints(article, file);
  scanForBannedPunctuation(article, file);
  return article;
}

/* ------------------------------------------------------------------ *
 * Build
 * ------------------------------------------------------------------ */
/* ------------------------------------------------------------------------
   PER-ARTICLE METADATA

   Every slug page used to be a VERBATIM copy of the reader shell, so every
   article on the site shipped the same <title>FSN Blog</title>, the same
   description ("An FSN Blog story.") and the same og:title. The shell rewrote
   them from JSON after load, which a crawler that does not execute the page's
   JavaScript never sees. Google was being handed one title and one
   description for the whole blog.

   The fix is to bake each article's own metadata and its rendered body into
   its page at BUILD time. That is this static site's equivalent of a
   framework's generateMetadata plus server rendering, and it is strictly
   better for crawling than either: the HTML is already on disk, so there is
   no server render and no hydration to wait for.

   The client-side hydration stays exactly as it was. It now re-renders the
   same content it finds, which costs nothing and keeps the reader working
   when a slug is opened through the /blog/:slug rewrite rather than its own
   stamped page.
------------------------------------------------------------------------ */

/** Escape for an HTML attribute value. Article copy is build-time input from
 *  the repo, not user input, but a stray quote in a title would still break
 *  the tag it lands in. */
function attr(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** "September 14, 2026", matching what the reader renders client-side so the
 *  pre-rendered body and the hydrated body read identically. */
function longDate(iso) {
  const date = new Date(String(iso) + 'T00:00:00Z');
  if (Number.isNaN(date.getTime())) return String(iso == null ? '' : iso);
  return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

/** Replace the FIRST match of a pattern, THROWING if it is absent.
 *
 *  Deliberately a throw and not `fail()`. The stamp runs in the write phase,
 *  after the collected errors have already been reported, so a `fail()` here
 *  would be noted and then the page written anyway, without its metadata. A
 *  reader shell that has been restructured must stop the build instead: this
 *  regression is invisible in review and surfaces weeks later as a ranking
 *  drop, which is the worst way to find out. */
function replaceOnce(html, pattern, replacement, what) {
  if (!pattern.test(html)) {
    throw new Error(
      `[blog] reader.html no longer contains ${what}, so per-article metadata cannot be stamped. ` +
      'Restore that markup in landing/blog/reader.html or update stampArticlePage() to match it.',
    );
  }
  return html.replace(pattern, replacement);
}

function stampArticlePage(shell, post) {
  const url = `${SITE_ORIGIN}/blog/${post.slug}`;
  const title = `${post.title} | Fantasy Sports Network`;
  let html = shell;

  html = replaceOnce(html, /<title>[^<]*<\/title>/,
    `<title>${escapeHtml(title)}</title>`, '<title>');
  html = replaceOnce(html, /<meta name="description" content="[^"]*">/,
    `<meta name="description" content="${attr(post.excerpt)}">`, 'the description meta');
  html = replaceOnce(html, /<meta property="og:title" content="[^"]*">/,
    `<meta property="og:title" content="${attr(title)}">`, 'the og:title meta');
  html = replaceOnce(html, /<meta property="og:description" content="[^"]*">/,
    `<meta property="og:description" content="${attr(post.excerpt)}">`, 'the og:description meta');
  html = replaceOnce(html, /<meta name="twitter:title" content="[^"]*">/,
    `<meta name="twitter:title" content="${attr(title)}">`, 'the twitter:title meta');
  html = replaceOnce(html, /<meta name="twitter:description" content="[^"]*">/,
    `<meta name="twitter:description" content="${attr(post.excerpt)}">`, 'the twitter:description meta');

  /* The tags the shell has no placeholder for. Canonical and og:url share
     SITE_ORIGIN with the sitemap so a crawler sees one host, not two. */
  html = replaceOnce(html, /<meta property="og:type" content="article">/,
    '<meta property="og:type" content="article">\n' +
    `<meta property="og:url" content="${attr(url)}">\n` +
    `<meta property="article:published_time" content="${attr(post.publishDate)}">\n` +
    `<meta property="article:section" content="${attr(post.category)}">\n` +
    `<meta property="article:author" content="${attr(post.author || 'FSN Desk')}">\n` +
    `<link rel="canonical" href="${attr(url)}">`,
    'the og:type meta');

  /* The body itself, so a crawler reads the article rather than a skeleton.
     Same markup the hydrator builds, minus the entity chips, which are an
     interactive enhancement rather than content. */
  const article =
    '<div class="art-meta">' +
      `<span class="chip">${escapeHtml(post.category)}</span>` +
      `<span class="date">${escapeHtml(longDate(post.publishDate))}</span>` +
    '</div>' +
    `<h1 class="title">${escapeHtml(post.title)}</h1>` +
    `<div class="byline">By <b>${escapeHtml(post.author || 'FSN Desk')}</b></div>` +
    `<div class="body">${post.bodyHtml || ''}</div>` +
    '<div class="more"><a href="/blog">&lsaquo; All stories</a></div>';

  html = replaceOnce(html, /<article id="article" aria-live="polite">[\s\S]*?<\/article>/,
    `<article id="article" aria-live="polite">${article}</article>`,
    'the #article mount point');

  return html;
}

/* ------------------------------------------------------------------------
   SITEMAP

   Was hand-maintained, and had already drifted: it listed three articles
   while landing/blog held four, so the newest story was not discoverable.
   Generated from the same `posts` the pages are stamped from, which is the
   only way the two cannot disagree.

   Every URL here is a PUBLIC, file-backed article from landing/content/blog.
   Nothing in this build reads Supabase, so a league's private recap has no
   path into this file. See the guard in the check phase.
------------------------------------------------------------------------ */
function buildSitemap(posts) {
  const entry = (loc, lastmod, changefreq) =>
    '  <url>\n' +
    `    <loc>${escapeHtml(loc)}</loc>\n` +
    (lastmod ? `    <lastmod>${escapeHtml(lastmod)}</lastmod>\n` : '') +
    (changefreq ? `    <changefreq>${changefreq}</changefreq>\n` : '') +
    '  </url>';

  const newest = posts
    .map((p) => p.publishDate)
    .filter(Boolean)
    .sort()
    .pop();

  const lines = STATIC_ROUTES.map((route) => entry(
    SITE_ORIGIN + (route === '/' ? '/' : route),
    /* The index and the blog list change whenever an article does; the legal
       pages do not, and claiming otherwise wastes crawl budget. */
    route === '/' || route === '/blog' ? newest : null,
    route === '/blog' ? 'weekly' : 'monthly',
  ));

  for (const post of posts) {
    lines.push(entry(`${SITE_ORIGIN}/blog/${post.slug}`, post.publishDate, 'weekly'));
  }

  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    lines.join('\n') + '\n' +
    '</urlset>\n';
}

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
    /* The manifest carries the tracked players too, so the app can decide
       which story is relevant to a reader's roster from ONE request instead
       of downloading every article body to find out. */
    tracked_players: a.entities,
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
    /* The same list under the name the rest of the product uses for "the
       players this article is about". `entities` is kept beside it because
       the compiled payload is public and cached at the edge for a day, so a
       client running older code must keep working through the rollover. */
    tracked_players: a.entities,
    bodyHtml: renderMarkdown(a.body),
  }));

  if (CHECK_ONLY) {
    let drift = false;
    const stale = (what) => { console.error(`[blog] check: ${what} Run: npm run build:blog`); drift = true; };

    const manifestPath = path.join(OUT_DIR, 'index.json');
    if (!fs.existsSync(manifestPath)) stale('manifest not generated.');
    else {
      const existing = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const norm = (m) => JSON.stringify(m.posts);
      if (norm(existing) !== norm(manifest)) stale('manifest is stale.');
    }

    /* Every slug page must carry its OWN metadata. Comparing against a fresh
       stamp catches both halves of the regression this exists to prevent: a
       page that was never restamped after its article changed, and a page
       still holding the shell's generic title because the stamp silently
       stopped applying. */
    const readerShell = fs.existsSync(READER_TEMPLATE) ? fs.readFileSync(READER_TEMPLATE, 'utf8') : '';
    for (const post of posts) {
      const pagePath = path.join(PAGES_DIR, post.slug + '.html');
      if (!fs.existsSync(pagePath)) { stale(`landing/blog/${post.slug}.html is missing.`); continue; }
      const onDisk = fs.readFileSync(pagePath, 'utf8');
      if (onDisk !== stampArticlePage(readerShell, post)) stale(`landing/blog/${post.slug}.html is stale.`);
      if (onDisk.includes('<title>FSN Blog</title>')) {
        stale(`landing/blog/${post.slug}.html still carries the shell's generic title.`);
      }
    }

    /* The sitemap is generated from the same posts, so any disagreement means
       one of the two was written by hand. */
    const sitemapOnDisk = fs.existsSync(SITEMAP_PATH) ? fs.readFileSync(SITEMAP_PATH, 'utf8') : '';
    if (sitemapOnDisk !== buildSitemap(posts)) stale('landing/sitemap.xml is stale.');

    /* ---- THE LEAK GUARD --------------------------------------------------

       `blog_articles` in Supabase holds ONE thing: per-league recaps, every
       row carrying a NOT NULL league_id. There is no such thing as a global
       row in that table, and /api/blog/articles requires a league_id and
       refuses the request without one, so it cannot be enumerated.

       The public blog is file-backed from landing/content/blog and reads none
       of it, which is WHY no private recap can appear on /blog or in the
       sitemap. That is an architectural guarantee rather than a filter, and
       the way it would be lost is someone adding a convenience fetch to a
       blog page later and quietly publishing twelve leagues' private
       matchups. This fails the build if that read ever appears.

       Scoped to the BLOG surface, and to actual read syntax. The invite page
       legitimately handles a league id, and the privacy policy legitimately
       names Supabase in prose; neither is the blog and neither is a read.

       landing/vercel.json's proxy of /api/blog/articles is also allowed: it
       exists so the APP can serve that route from the root domain, it still
       demands a league_id, and no blog page calls it.
    --------------------------------------------------------------------- */
    const BLOG_SURFACE = [PAGES_DIR, OUT_DIR];
    const READ_PATTERNS = [
      [/\/api\/blog\/articles/, 'the league-scoped article endpoint'],
      [/\bblog_articles\b/, 'the blog_articles table'],
      [/\bcreateClient\s*\(/, 'a Supabase client'],
      [/\.supabase\.co/, 'a Supabase host'],
      [/\bfrom\s*\(\s*['"`]blog_articles/, 'a blog_articles query'],
    ];
    let leaks = 0;
    const scanned = [];
    const walk = (dir) => {
      if (!fs.existsSync(dir)) return;
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        if (fs.statSync(full).isDirectory()) { walk(full); continue; }
        if (!/\.(html|js|mjs|json)$/.test(name)) continue;
        const rel = path.relative(ROOT, full);
        scanned.push(rel);
        for (const [pattern, what] of READ_PATTERNS) {
          if (!pattern.test(fs.readFileSync(full, 'utf8'))) continue;
          console.error(
            `[blog] LEAK: ${rel} references ${what}. The public blog is file-backed and must never ` +
            'read league-scoped article storage: every row in it is one league\'s private recap.',
          );
          leaks++;
        }
      }
    };
    for (const dir of BLOG_SURFACE) walk(dir);
    if (leaks) process.exit(1);

    if (drift) process.exit(1);
    console.log(`[blog] check passed. ${articles.length} article(s), punctuation clean, ` +
      `per-article metadata stamped, sitemap current, ${scanned.length} landing file(s) free of league-scoped reads.`);
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
    fs.writeFileSync(path.join(PAGES_DIR, post.slug + '.html'), stampArticlePage(readerShell, post));
  }

  fs.writeFileSync(SITEMAP_PATH, buildSitemap(posts));

  console.log(`[blog] built ${posts.length} article(s) -> landing/content/generated/blog/ + landing/blog/<slug>.html`);
  console.log(`[blog] sitemap: ${STATIC_ROUTES.length + posts.length} URL(s) -> landing/sitemap.xml`);
  for (const p of posts) console.log(`  - ${p.slug} (${p.entities.length} entit${p.entities.length === 1 ? 'y' : 'ies'})`);
}

build();

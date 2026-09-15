#!/usr/bin/env node
/* ============================================================================
   FSN — PUBLIC EDITORIAL GENERATOR
   ----------------------------------------------------------------------------
   Turns one item from a public RSS/Atom feed into a small, attributed Markdown
   source file for `landing/content/blog/`. It is intentionally league-agnostic:
   it does not read league IDs, provider rosters, fantasy scores, or player
   statistics. The original report remains the source of record; this script
   writes a lean linked brief rather than inventing analysis around it.

   Usage:
     node scripts/generate-editorial.mjs
     node scripts/generate-editorial.mjs --feed https://example.com/nfl.xml
     node scripts/generate-editorial.mjs --feed <url> --player "CeeDee Lamb|WR"
     node scripts/generate-editorial.mjs --local-state editorial-source.json
     node scripts/generate-editorial.mjs --self-test

   Options:
     --feed <url>                 Repeatable public RSS or Atom feed URL.
                                  Defaults to Google News' NFL feed.
     --item <n>                   Zero-based usable item in the feed (default 0).
     --category <name>            Optional explicit blog category.
     --player "Name|POSITION"     Repeatable, evidence-backed entity tag. The
                                  supplied name must appear in the source item.
     --publish-date <YYYY-MM-DD>  Optional date override (default: source date).
     --week <1-18>                Optional source week. It must appear in the
                                  verified source text.
     --local-state <file>         Optional local JSON fallback containing a
                                  `verifiedEditorialSource` object. It is read
                                  only after feed reads fail and is never
                                  published unless its source text validates.
     --out <dir>                  Optional output directory.
     --self-test                  Network-free parser and serialization check.

   After generation, compile the static public payload with `npm run build:blog`.
============================================================================ */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT_DIR = path.join(ROOT, 'landing', 'content', 'blog');
const DEFAULT_FEED = 'https://news.google.com/rss/search?q=NFL%20fantasy%20football&hl=en-US&gl=US&ceid=US:en';
const BANNED_CHARS = /[—―]/;

function decodeEntities(value) {
  return String(value)
    .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, raw) => {
      const code = raw[0].toLowerCase() === 'x' ? parseInt(raw.slice(1), 16) : parseInt(raw, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    });
}

function cleanText(value) {
  return decodeEntities(String(value == null ? '' : value)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function stripFeedSuffix(title) {
  /* Google News appends " - Publisher". Preserve all other source copy. */
  return String(title || '').replace(/\s+-\s+[^-]{2,80}$/, '').trim();
}

function xmlTag(block, names) {
  for (const name of names) {
    const re = new RegExp('<(?:[A-Za-z0-9_-]+:)?' + name + '\\b[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z0-9_-]+:)?' + name + '>', 'i');
    const match = re.exec(block);
    if (match) return cleanText(match[1]);
  }
  return '';
}

function xmlLink(block) {
  const atom = /<link\b[^>]*\bhref=["']([^"']+)["'][^>]*>/i.exec(block);
  if (atom) return decodeEntities(atom[1]).trim();
  return xmlTag(block, ['link']);
}

function parseFeed(xml) {
  const source = String(xml || '');
  const chunks = source.match(/<(?:[A-Za-z0-9_-]+:)?(?:item|entry)\b[\s\S]*?<\/(?:[A-Za-z0-9_-]+:)?(?:item|entry)>/gi) || [];
  return chunks.map((chunk) => ({
    title: stripFeedSuffix(xmlTag(chunk, ['title'])),
    description: xmlTag(chunk, ['description', 'summary', 'content']),
    url: xmlLink(chunk),
    publishedAt: xmlTag(chunk, ['pubDate', 'published', 'updated', 'date']),
    author: xmlTag(chunk, ['creator', 'author']),
  })).filter((item) => item.title && item.url);
}

function parsePlayer(raw) {
  const parts = String(raw || '').split('|');
  const name = cleanText(parts.shift());
  const position = cleanText(parts.join('|')).toUpperCase();
  if (!name) throw new Error('[generate-editorial] --player requires a name, for example "CeeDee Lamb|WR".');
  return { name, position };
}

function parseArgs(argv) {
  const args = { feeds: [], item: 0, category: '', players: [], publishDate: '', week: 0, localState: '', out: DEFAULT_OUT_DIR, selfTest: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error('[generate-editorial] ' + arg + ' requires a value.');
      return value;
    };
    if (arg === '--feed') args.feeds.push(next());
    else if (arg === '--item') args.item = Number(next());
    else if (arg === '--category') args.category = cleanText(next());
    else if (arg === '--player') args.players.push(parsePlayer(next()));
    else if (arg === '--publish-date') args.publishDate = next();
    else if (arg === '--week') args.week = Number(next());
    else if (arg === '--local-state') args.localState = path.resolve(next());
    else if (arg === '--out') args.out = path.resolve(next());
    else if (arg === '--self-test') args.selfTest = true;
    else throw new Error('[generate-editorial] unknown option "' + arg + '". This generator accepts public feeds only; league options are not supported.');
  }
  if (!Number.isInteger(args.item) || args.item < 0) throw new Error('[generate-editorial] --item must be a non-negative integer.');
  if (!Number.isInteger(args.week) || args.week < 0 || args.week > 18) throw new Error('[generate-editorial] --week must be an integer from 1 through 18.');
  if (!args.feeds.length) args.feeds.push(DEFAULT_FEED);
  return args;
}

async function fetchFeed(url) {
  let res;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);
  try {
    res = await fetch(url, {
      headers: { Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.1' },
      signal: controller.signal,
    });
  } catch (err) {
    throw new Error('[generate-editorial] request to ' + url + ' failed: ' + err.message);
  } finally {
    clearTimeout(timer);
  }
  const body = await res.text();
  if (!res.ok) throw new Error('[generate-editorial] feed returned ' + res.status + ' ' + res.statusText + ' for ' + url + '.');
  const items = parseFeed(body);
  if (!items.length) throw new Error('[generate-editorial] no usable RSS or Atom items were found at ' + url + '.');
  return items;
}

/* A local fallback is intentionally narrow. It may hold a previously verified
   public-source snapshot, but never raw league data, scores, rosters, cookies
   or provider payloads. That keeps a network-restricted run deterministic and
   prevents private state from becoming a public blog post. */
function localVerifiedSource(file) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error('[generate-editorial] local state ' + file + ' could not be read: ' + err.message);
  }
  const source = parsed && parsed.verifiedEditorialSource;
  if (!source || typeof source !== 'object') {
    throw new Error('[generate-editorial] local state has no verifiedEditorialSource; no public output will be created.');
  }
  const title = cleanText(source.title);
  const description = cleanText(source.description || source.summary);
  const url = cleanText(source.url);
  const sourceText = cleanText(source.sourceText || source.text);
  if (!title || !url || !sourceText) {
    throw new Error('[generate-editorial] local verifiedEditorialSource requires title, url, and sourceText; no public output will be created.');
  }
  if (!/^https?:\/\//i.test(url)) {
    throw new Error('[generate-editorial] local verifiedEditorialSource url must be http(s); no public output will be created.');
  }
  return {
    title,
    description: description || sourceText,
    url,
    publishedAt: cleanText(source.publishedAt || source.publishDate),
    author: cleanText(source.author),
    sourceText,
  };
}

function sourceTextFor(item) {
  return cleanText([item && item.title, item && item.description, item && item.sourceText].filter(Boolean).join(' '));
}

function resolveSourceWeek(item, requestedWeek) {
  const sourceText = sourceTextFor(item);
  const weeks = Array.from(sourceText.matchAll(/\bweek\s+([1-9]|1[0-8])\b/gi), match => Number(match[1]));
  const uniqueWeeks = Array.from(new Set(weeks));
  if (requestedWeek) {
    if (!uniqueWeeks.includes(requestedWeek)) {
      throw new Error('[generate-editorial] --week ' + requestedWeek + ' is not present in the verified source text. Refusing to assign an unsupported week bucket.');
    }
    return requestedWeek;
  }
  return uniqueWeeks.length === 1 ? uniqueWeeks[0] : null;
}

function sourceDate(value, fallback) {
  if (fallback) return fallback;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
}

function slugify(value) {
  const slug = cleanText(value).toLowerCase().normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 72).replace(/-+$/g, '');
  return slug || 'nfl-news-brief';
}

function inferCategory(item, explicit) {
  if (explicit) return explicit;
  const text = (item.title + ' ' + item.description).toLowerCase();
  if (/\b(?:waiver|faab|pickup|streamer|claim)\b/.test(text)) return 'Waiver Wire';
  if (/\b(?:injury|injured|questionable|out|inactive|practice)\b/.test(text)) return 'Injury Report';
  if (/\b(?:preview|start sit|matchup|lineup|projection)\b/.test(text)) return 'Matchup Preview';
  if (/\b(?:recap|results|final|highs|lows|standout)\b/.test(text)) return 'Recap';
  return 'Analysis';
}

function dedupeEntities(players, sourceText) {
  const lower = sourceText.toLowerCase();
  const seen = new Set();
  return players.filter((player) => {
    const key = player.name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    if (!lower.includes(key)) {
      throw new Error('[generate-editorial] "' + player.name + '" was supplied with --player but does not appear in the selected public feed item. Refusing to create a ghost entity.');
    }
    return true;
  });
}

function buildArticle(item, options) {
  const publishDate = sourceDate(item.publishedAt, options.publishDate);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(publishDate)) throw new Error('[generate-editorial] publish date must be YYYY-MM-DD.');
  const summary = cleanText(item.description).slice(0, 420);
  const title = item.title;
  const sourceText = sourceTextFor(item);
  const entities = dedupeEntities(options.players, sourceText);
  const excerpt = summary || 'A public NFL news brief from the FSN desk.';
  const sourceLabel = cleanText(item.author) || new URL(item.url).hostname.replace(/^www\./, '');
  const body = [
    '## Public news brief',
    summary || 'This brief links directly to the original public report.',
    '[Read the original report](' + item.url + ')',
    '*Source: ' + sourceLabel + '*',
  ].join('\n\n');
  return {
    title, slug: slugify(publishDate + '-' + title), publishDate,
    category: inferCategory(item, options.category), excerpt, author: 'FSN Desk',
    week: resolveSourceWeek(item, options.week), entities, body,
  };
}

function validateArticle(article) {
  for (const key of ['title', 'slug', 'publishDate', 'category', 'excerpt', 'author', 'body']) {
    if (!article[key]) throw new Error('[generate-editorial] generated article is missing required field "' + key + '".');
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(article.slug)) throw new Error('[generate-editorial] generated slug is not lowercase kebab-case.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(article.publishDate)) throw new Error('[generate-editorial] generated publishDate is not YYYY-MM-DD.');
  const haystack = cleanText(article.title + ' ' + article.body).toLowerCase();
  for (const entity of article.entities) {
    if (!haystack.includes(entity.name.toLowerCase())) throw new Error('[generate-editorial] entity "' + entity.name + '" is not named in the public brief.');
  }
  const fields = [article.title, article.slug, article.category, article.excerpt, article.author, article.body, ...article.entities.map((e) => e.name)];
  if (fields.some((field) => BANNED_CHARS.test(String(field)))) throw new Error('[generate-editorial] em dash found in generated content.');
  if (article.week != null && (!Number.isInteger(article.week) || article.week < 1 || article.week > 18)) {
    throw new Error('[generate-editorial] generated week must be an integer from 1 through 18.');
  }
}

function serializeFrontmatter(article) {
  const lines = ['---'];
  for (const key of ['title', 'slug', 'publishDate', 'category', 'excerpt', 'author']) lines.push(key + ': ' + article[key]);
  if (article.week != null) lines.push('week: ' + article.week);
  if (article.entities.length) {
    lines.push('entities:');
    for (const entity of article.entities) {
      lines.push('  - name: ' + entity.name);
      if (entity.position) lines.push('    position: ' + entity.position);
    }
  }
  lines.push('---', '', article.body);
  return lines.join('\n') + '\n';
}

async function generate(options) {
  let item = null;
  let lastError = null;
  for (const feed of options.feeds) {
    try {
      const items = await fetchFeed(feed);
      item = items[options.item] || null;
      if (!item) throw new Error('[generate-editorial] feed ' + feed + ' has no usable item #' + options.item + '.');
      console.log('[generate-editorial] selected public feed item from ' + feed + '.');
      break;
    } catch (err) {
      lastError = err;
      console.warn('[generate-editorial] skipping public feed ' + feed + ': ' + err.message);
    }
  }
  if (!item && options.localState) {
    try {
      item = localVerifiedSource(options.localState);
      console.warn('[generate-editorial] live feeds were unavailable; using the supplied verified local editorial source.');
    } catch (err) {
      lastError = err;
      console.warn('[generate-editorial] local fallback rejected: ' + err.message);
    }
  }
  if (!item) {
    console.warn('[generate-editorial] no verified source is available; no blog, News Desk, or database write was attempted.' +
      (lastError ? ' Last verification failure: ' + lastError.message : ''));
    return null;
  }
  const article = buildArticle(item, options);
  validateArticle(article);
  fs.mkdirSync(options.out, { recursive: true });
  const outFile = path.join(options.out, article.slug + '.md');
  fs.writeFileSync(outFile, serializeFrontmatter(article), 'utf8');
  console.log('[generate-editorial] wrote ' + outFile);
  return outFile;
}

function fixtureXml() {
  return `<?xml version="1.0"?><rss><channel><title>Fixture</title><item><title>CeeDee Lamb returns to practice - Example Sports</title><link>https://news.example.test/ceedee-lamb-practice</link><description><![CDATA[The Cowboys listed CeeDee Lamb as a full participant in Monday's practice.]]></description><pubDate>Mon, 14 Sep 2026 12:00:00 GMT</pubDate><dc:creator xmlns:dc="http://purl.org/dc/elements/1.1/">Example Sports</dc:creator></item></channel></rss>`;
}

async function runSelfTest() {
  const server = createServer((req, res) => {
    if (req.url === '/feed.xml') {
      res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
      res.end(fixtureXml());
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsn-editorial-selftest-'));
  const localState = path.join(tmp, 'verified-editorial-source.json');
  const failures = [];
  const check = (value, message) => { if (!value) failures.push(message); };
  try {
    const file = await generate({ feeds:['http://127.0.0.1:' + server.address().port + '/feed.xml'], item:0, category:'', players:[parsePlayer('CeeDee Lamb|WR')], publishDate:'', week:0, localState:'', out:tmp });
    const content = fs.readFileSync(file, 'utf8');
    check(content.includes('CeeDee Lamb returns to practice'), 'source headline was not preserved');
    check(content.includes('position: WR'), 'player position was not serialized');
    check(content.includes('[Read the original report](https://news.example.test/ceedee-lamb-practice)'), 'original report link is missing');
    check(!/league\/.+matchup|points:/.test(content), 'output contains a league or fabricated-stat dependency');
    check(!BANNED_CHARS.test(content), 'output contains banned punctuation');
    check(!/^week:/m.test(content), 'unverified fixture did not infer an unsupported week');
    fs.writeFileSync(localState, JSON.stringify({ verifiedEditorialSource: {
      title:'Week 1 CeeDee Lamb practice update',
      description:'CeeDee Lamb practiced in full before Week 2.',
      url:'https://news.example.test/week-1-lamb',
      publishedAt:'2026-09-14', author:'Example Sports',
      sourceText:'Week 1 CeeDee Lamb practice update. CeeDee Lamb practiced in full before Week 2.',
    } }), 'utf8');
    const fallbackFile = await generate({
      feeds:['http://127.0.0.1:' + server.address().port + '/blocked.xml'], item:0, category:'',
      players:[parsePlayer('CeeDee Lamb|WR')], publishDate:'', week:1, localState, out:tmp,
    });
    const fallbackContent = fs.readFileSync(fallbackFile, 'utf8');
    check(/^week: 1$/m.test(fallbackContent), 'verified local fallback did not preserve its source week');
    check(fallbackContent.includes('CeeDee Lamb'), 'verified local fallback dropped its source entity');
    const beforeNoop = fs.readdirSync(tmp).sort().join('|');
    const noOutput = await generate({
      feeds:['http://127.0.0.1:' + server.address().port + '/blocked.xml'], item:0, category:'',
      players:[], publishDate:'', week:0, localState:path.join(tmp, 'missing-state.json'), out:tmp,
    });
    check(noOutput === null, 'unverified fallback did not return the safe no-write result');
    check(fs.readdirSync(tmp).sort().join('|') === beforeNoop, 'unverified fallback wrote a blog artifact');
    let leagueOptionRejected = false;
    try { parseArgs(['--league', '123']); }
    catch (err) { leagueOptionRejected = /league options are not supported/.test(err.message); }
    check(leagueOptionRejected, 'legacy league input was not rejected');
    let ghostRejected = false;
    try { buildArticle(parseFeed(fixtureXml())[0], { players:[parsePlayer('Ghost Player|QB')], category:'', publishDate:'', week:0 }); }
    catch (err) { ghostRejected = /ghost entity/.test(err.message); }
    check(ghostRejected, 'unmentioned player entity was not rejected');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmp, { recursive:true, force:true });
  }
  if (failures.length) {
    console.error('[generate-editorial] SELF-TEST FAILED:');
    failures.forEach((failure) => console.error('  - ' + failure));
    process.exit(1);
  }
  console.log('[generate-editorial] self-test passed: public RSS ingestion, attributed Markdown, evidence-backed player entities, and no league/stat dependency.');
}

async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (err) { console.error(err.message); process.exit(1); }
  if (args.selfTest) { await runSelfTest(); return; }
  try {
    const file = await generate(args);
    if (file) console.log('[generate-editorial] done. Run "npm run build:blog" to compile ' + path.relative(ROOT, file) + '.');
    else console.log('[generate-editorial] skipped safely: no verified source, no output written.');
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

main();

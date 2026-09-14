#!/usr/bin/env node
/* ============================================================================
   FSN — LEAGUE-AGNOSTIC NFL EDITORIAL GENERATOR
   ----------------------------------------------------------------------------
   Fetches public NFL RSS/Atom feeds and compiles a source-attributed roundup
   into landing/content/blog/. It never reads a fantasy league, roster,
   database, provider cookie, or user identifier.

   Defaults:
     Tuesday  -> game_recap        -> Recap
     Thursday -> tnf_matchup_prep  -> Roster Watch
     Friday   -> weekend_deepdive  -> Roster Watch

   Usage:
     npm run generate:editorial
     node scripts/generate-editorial.mjs --publish-date 2026-09-15
     node scripts/generate-editorial.mjs --feed "CBS Sports NFL|https://..."
     node scripts/generate-editorial.mjs --self-test

   FSN_NEWS_FEEDS may be a JSON array of { name, url } objects. A custom
   --feed argument replaces the defaults and may be repeated. Normal runs fail
   loudly unless at least one source succeeds and enough recent stories remain.
============================================================================ */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT_DIR = path.join(ROOT, 'landing', 'content', 'blog');
const DEFAULT_FEEDS = Object.freeze([
  { name: 'CBS Sports NFL', url: 'https://www.cbssports.com/rss/headlines/nfl/' },
  { name: 'ESPN NFL', url: 'https://www.espn.com/espn/rss/nfl/news' },
  { name: 'Yahoo Sports NFL', url: 'https://sports.yahoo.com/nfl/rss/' },
]);
const EDITIONS = Object.freeze({
  game_recap: {
    weekdays: [2],
    category: 'Recap',
    titlePrefix: 'NFL news roundup',
    excerpt: 'The latest verified NFL headlines and reporting from around the league.',
    intro: 'The NFL news cycle has moved. Here are the reports shaping the league right now.',
  },
  tnf_matchup_prep: {
    weekdays: [4],
    category: 'Roster Watch',
    titlePrefix: 'NFL Thursday news briefing',
    excerpt: 'The latest NFL injuries, roster developments, and reporting before Thursday night.',
    intro: 'Thursday has arrived with injuries, roster movement, and a new slate taking shape. Here is the latest reporting.',
  },
  weekend_deepdive: {
    weekdays: [5],
    category: 'Roster Watch',
    titlePrefix: 'NFL weekend news briefing',
    excerpt: 'The NFL reports that matter before the weekend slate begins.',
    intro: 'The weekend board is nearly set. These are the NFL reports worth carrying into the slate.',
  },
});
const ALLOWED_TRIGGERS = new Set(Object.keys(EDITIONS));
const BANNED_CHARS = /[—―]/;
const MAX_DESCRIPTION_CHARS = 360;

function decodeEntities(value) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return String(value).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (full, entity) => {
    const key = entity.toLowerCase();
    if (key[0] !== '#') return named[key] == null ? full : named[key];
    const number = key.startsWith('#x') ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
    return Number.isFinite(number) ? String.fromCodePoint(number) : full;
  });
}

function cleanText(value) {
  return decodeEntities(String(value == null ? '' : value)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(BANNED_CHARS, ',')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tagValue(block, names) {
  for (const name of names) {
    const escaped = escapeRegExp(name);
    const match = new RegExp(`<${escaped}\\b[^>]*>([\\s\\S]*?)<\\/${escaped}>`, 'i').exec(block);
    if (match) return match[1];
  }
  return '';
}

function atomLink(block) {
  const tags = block.match(/<link\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const rel = /\brel=["']([^"']+)["']/i.exec(tag);
    const href = /\bhref=["']([^"']+)["']/i.exec(tag);
    if (href && (!rel || rel[1].toLowerCase() === 'alternate')) return decodeEntities(href[1]);
  }
  return '';
}

function blocksFor(xml, tag) {
  const escaped = escapeRegExp(tag);
  return [...String(xml).matchAll(new RegExp(`<${escaped}\\b[^>]*>([\\s\\S]*?)<\\/${escaped}>`, 'gi'))]
    .map((match) => match[1]);
}

function safeHttpUrl(value, base) {
  try {
    const url = new URL(cleanText(value), base);
    const loopback = url.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(url.hostname);
    if (url.protocol !== 'https:' && !loopback) return '';
    url.hash = '';
    return url.toString();
  } catch (err) {
    return '';
  }
}

function parseFeed(xml, feed) {
  const rssItems = blocksFor(xml, 'item');
  const atomEntries = rssItems.length ? [] : blocksFor(xml, 'entry');
  const blocks = rssItems.length ? rssItems : atomEntries;
  const isAtom = !rssItems.length && atomEntries.length > 0;
  const channelTitle = cleanText(tagValue(xml, ['title']));
  const source = cleanText(feed.name || channelTitle || new URL(feed.url).hostname);
  return blocks.map((block) => {
    const title = cleanText(tagValue(block, ['title']));
    const rawLink = isAtom ? atomLink(block) : tagValue(block, ['link']);
    const url = safeHttpUrl(rawLink, feed.url);
    const publishedRaw = cleanText(tagValue(block, ['pubDate', 'dc:date', 'published', 'updated']));
    const publishedMs = Date.parse(publishedRaw);
    const description = cleanText(tagValue(block, ['description', 'summary', 'content:encoded', 'content']));
    return {
      title,
      url,
      source,
      publishedAt: Number.isFinite(publishedMs) ? new Date(publishedMs).toISOString() : '',
      publishedMs: Number.isFinite(publishedMs) ? publishedMs : 0,
      description,
    };
  }).filter((item) => item.title && item.url && item.publishedMs > 0);
}

function parseFeedArg(value) {
  const raw = String(value || '').trim();
  const split = raw.indexOf('|');
  const name = split === -1 ? '' : raw.slice(0, split).trim();
  const url = split === -1 ? raw : raw.slice(split + 1).trim();
  if (!url) throw new Error('[generate-editorial] --feed requires a URL, optionally prefixed with "Source name|".');
  return { name, url };
}

function feedsFromEnv() {
  const raw = String(process.env.FSN_NEWS_FEEDS || '').trim();
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`[generate-editorial] FSN_NEWS_FEEDS must be valid JSON: ${err.message}`);
  }
  if (!Array.isArray(parsed) || !parsed.length) {
    throw new Error('[generate-editorial] FSN_NEWS_FEEDS must be a non-empty JSON array.');
  }
  return parsed.map((feed, index) => {
    if (!feed || typeof feed !== 'object' || !feed.url) {
      throw new Error(`[generate-editorial] FSN_NEWS_FEEDS entry ${index + 1} needs a url.`);
    }
    return { name: String(feed.name || '').trim(), url: String(feed.url).trim() };
  });
}

function parseArgs(argv) {
  const cliFeeds = [];
  const args = {
    feeds: null,
    publishDate: null,
    out: DEFAULT_OUT_DIR,
    trigger: null,
    limit: 6,
    maxAgeHours: 96,
    selfTest: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--feed') cliFeeds.push(parseFeedArg(argv[++i]));
    else if (arg === '--publish-date') args.publishDate = argv[++i];
    else if (arg === '--out') args.out = path.resolve(argv[++i]);
    else if (arg === '--trigger') args.trigger = argv[++i];
    else if (arg === '--limit') args.limit = Number(argv[++i]);
    else if (arg === '--max-age-hours') args.maxAgeHours = Number(argv[++i]);
    else if (arg === '--self-test') args.selfTest = true;
    else throw new Error(`[generate-editorial] unknown argument "${arg}".`);
  }
  args.feeds = cliFeeds.length ? cliFeeds : (feedsFromEnv() || DEFAULT_FEEDS.map((feed) => ({ ...feed })));
  return args;
}

function validateFeedUrl(feed) {
  const url = safeHttpUrl(feed.url, feed.url);
  if (!url) throw new Error(`[generate-editorial] refused non-HTTPS feed URL "${feed.url}".`);
  return { name: cleanText(feed.name), url };
}

async function fetchText(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  let response;
  try {
    response = await fetch(url, {
      headers: {
        Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.1',
        'User-Agent': 'FSNEditorialBot/1.0 (+https://fantasysportsnetwork.app)',
      },
      signal: controller.signal,
    });
  } catch (err) {
    throw new Error(`[generate-editorial] request to ${url} failed: ${err.message}`);
  } finally {
    clearTimeout(timeout);
  }
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`[generate-editorial] feed returned ${response.status} ${response.statusText} for ${url}: ${text.slice(0, 160)}`);
  }
  if (!/<(?:rss|feed|rdf:RDF)\b/i.test(text)) {
    throw new Error(`[generate-editorial] ${url} did not return RSS or Atom XML.`);
  }
  return text;
}

async function fetchFeeds(feeds) {
  const checked = feeds.map(validateFeedUrl);
  const results = await Promise.allSettled(checked.map(async (feed) => {
    const xml = await fetchText(feed.url);
    const items = parseFeed(xml, feed);
    if (!items.length) throw new Error(`[generate-editorial] ${feed.url} contained no usable dated stories.`);
    return { feed, items };
  }));
  const items = [];
  let succeeded = 0;
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      succeeded++;
      items.push(...result.value.items);
    } else {
      console.warn(`[generate-editorial] source "${checked[index].name || checked[index].url}" failed; continuing with the other configured feeds.`, result.reason);
    }
  });
  if (!succeeded) throw new Error('[generate-editorial] every configured news feed failed. No article was written.');
  return items;
}

function selectStories(items, asOfMs, maxAgeHours, limit) {
  const minimum = asOfMs - maxAgeHours * 3600000;
  const maximum = asOfMs + 6 * 3600000;
  const seen = new Set();
  const sourceCounts = new Map();
  const sorted = items.slice().sort((a, b) => b.publishedMs - a.publishedMs || a.title.localeCompare(b.title));
  const selected = [];
  for (const item of sorted) {
    if (item.publishedMs < minimum || item.publishedMs > maximum) continue;
    const key = item.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (!key || seen.has(key)) continue;
    const count = sourceCounts.get(item.source) || 0;
    if (count >= 3) continue;
    seen.add(key);
    sourceCounts.set(item.source, count + 1);
    selected.push(item);
    if (selected.length >= limit) break;
  }
  return selected;
}

function editionFor(publishDate, requestedTrigger) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(publishDate) || Number.isNaN(Date.parse(publishDate + 'T12:00:00Z'))) {
    throw new Error(`[generate-editorial] publish date "${publishDate}" must be YYYY-MM-DD.`);
  }
  if (requestedTrigger) {
    if (!ALLOWED_TRIGGERS.has(requestedTrigger)) {
      throw new Error(`[generate-editorial] trigger "${requestedTrigger}" is not a Tuesday, Thursday, or Friday news trigger.`);
    }
    return { trigger: requestedTrigger, ...EDITIONS[requestedTrigger] };
  }
  const weekday = new Date(publishDate + 'T12:00:00Z').getUTCDay();
  const match = Object.entries(EDITIONS).find(([, edition]) => edition.weekdays.includes(weekday));
  if (!match) {
    throw new Error(`[generate-editorial] ${publishDate} is not a Tuesday, Thursday, or Friday. Pass --trigger only for an intentional manual edition.`);
  }
  return { trigger: match[0], ...match[1] };
}

function displayDate(publishDate) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  }).format(new Date(publishDate + 'T12:00:00Z'));
}

function trimDescription(value) {
  const text = cleanText(value);
  if (text.length <= MAX_DESCRIPTION_CHARS) return text;
  const clipped = text.slice(0, MAX_DESCRIPTION_CHARS - 3).replace(/\s+\S*$/, '').trim();
  return clipped + '...';
}

function buildArticle({ publishDate, edition, stories }) {
  const stamp = displayDate(publishDate);
  const sections = stories.map((story) => {
    const published = new Intl.DateTimeFormat('en-US', {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
      timeZone: 'UTC', timeZoneName: 'short',
    }).format(new Date(story.publishedAt));
    const description = trimDescription(story.description);
    const lines = [
      `### ${story.title}`,
      `Source: [${story.source}](${story.url}) · ${published}`,
    ];
    if (description && description.toLowerCase() !== story.title.toLowerCase()) lines.push(description);
    return lines.join('\n\n');
  });
  return {
    title: `${edition.titlePrefix}: ${stamp}`,
    slug: `nfl-news-${edition.trigger.replace(/_/g, '-')}-${publishDate}`,
    publishDate,
    category: edition.category,
    excerpt: edition.excerpt,
    author: 'FSN Desk',
    notificationTrigger: edition.trigger,
    entities: [],
    body: [edition.intro, ...sections,
      'FSN links to the original reporting so readers can continue with the source publication.'].join('\n\n'),
  };
}

function validateArticle(article) {
  for (const key of ['title', 'slug', 'publishDate', 'category', 'excerpt', 'author', 'notificationTrigger', 'body']) {
    if (!article[key]) throw new Error(`[generate-editorial] generated article is missing required field "${key}".`);
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(article.slug)) {
    throw new Error(`[generate-editorial] generated slug "${article.slug}" is not lowercase kebab-case.`);
  }
  if (!ALLOWED_TRIGGERS.has(article.notificationTrigger)) {
    throw new Error(`[generate-editorial] generated trigger "${article.notificationTrigger}" is not registered.`);
  }
  if (article.entities.length !== 0) {
    throw new Error('[generate-editorial] internet news articles must not carry league roster entities.');
  }
  for (const field of [article.title, article.category, article.excerpt, article.author, article.body]) {
    if (BANNED_CHARS.test(String(field))) throw new Error('[generate-editorial] em dash found in generated content.');
  }
}

function serializeFrontmatter(article) {
  return [
    '---',
    `title: ${article.title}`,
    `slug: ${article.slug}`,
    `publishDate: ${article.publishDate}`,
    `category: ${article.category}`,
    `excerpt: ${article.excerpt}`,
    `author: ${article.author}`,
    `notificationTrigger: ${article.notificationTrigger}`,
    '---',
    '',
    article.body,
    '',
  ].join('\n');
}

async function generate({ feeds, publishDate, out, trigger, limit, maxAgeHours }) {
  if (!Number.isInteger(limit) || limit < 3 || limit > 12) {
    throw new Error('[generate-editorial] --limit must be an integer from 3 through 12.');
  }
  if (!Number.isFinite(maxAgeHours) || maxAgeHours < 1 || maxAgeHours > 336) {
    throw new Error('[generate-editorial] --max-age-hours must be between 1 and 336.');
  }
  const resolvedDate = publishDate || new Date().toISOString().slice(0, 10);
  const edition = editionFor(resolvedDate, trigger);
  const asOfMs = Date.parse(resolvedDate + 'T23:59:59Z');
  console.log(`[generate-editorial] fetching ${feeds.length} public news feed(s) for ${edition.trigger}`);
  const fetched = await fetchFeeds(feeds);
  const stories = selectStories(fetched, asOfMs, maxAgeHours, limit);
  if (stories.length < 3) {
    throw new Error(`[generate-editorial] only ${stories.length} recent unique stories remained; at least 3 are required. No article was written.`);
  }
  const article = buildArticle({ publishDate: resolvedDate, edition, stories });
  validateArticle(article);
  fs.mkdirSync(out, { recursive: true });
  const outFile = path.join(out, article.slug + '.md');
  fs.writeFileSync(outFile, serializeFrontmatter(article), 'utf8');
  console.log(`[generate-editorial] wrote ${outFile} from ${stories.length} source-attributed reports`);
  return { outFile, article, stories };
}

function fixtureFeeds(origin) {
  return [
    { name: 'Fixture RSS', url: origin + '/rss.xml' },
    { name: 'Fixture Atom', url: origin + '/atom.xml' },
  ];
}

function startFixtureServer() {
  const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>Fixture RSS</title>
    <item><title>Quarterback returns to practice</title><link>https://example.com/qb-practice</link><pubDate>Tue, 15 Sep 2026 16:00:00 GMT</pubDate><description><![CDATA[The starter returned — and handled the full session.]]></description></item>
    <item><title>Rookie receiver earns larger role</title><link>https://example.com/rookie-role</link><pubDate>Tue, 15 Sep 2026 14:00:00 GMT</pubDate><description>The offense expanded his package after a strong opener.</description></item>
    <item><title>Old report outside the window</title><link>https://example.com/old</link><pubDate>Mon, 01 Jun 2026 10:00:00 GMT</pubDate><description>Stale.</description></item>
  </channel></rss>`;
  const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Fixture Atom</title>
    <entry><title>Defense adjusts after Week 1</title><link rel="alternate" href="https://example.org/defense"/><updated>2026-09-15T12:00:00Z</updated><summary>Coaches changed the rotation &amp; elevated a young defender.</summary></entry>
    <entry><title>Quarterback returns to practice</title><link href="https://example.org/duplicate"/><updated>2026-09-15T11:00:00Z</updated><summary>Duplicate title.</summary></entry>
    <entry><title>Veteran signs with contender</title><link href="https://example.org/signing"/><updated>2026-09-15T10:00:00Z</updated><summary>A veteran joined the active roster.</summary></entry>
  </feed>`;
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/xml');
    if (req.url === '/rss.xml') res.end(rss);
    else if (req.url === '/atom.xml') res.end(atom);
    else { res.statusCode = 404; res.end('<error>missing</error>'); }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function runSelfTest() {
  const server = await startFixtureServer();
  const origin = `http://127.0.0.1:${server.address().port}`;
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'fsn-editorial-selftest-'));
  const failures = [];
  const check = (condition, message) => { if (!condition) failures.push(message); };
  try {
    const dates = [
      ['2026-09-15', 'game_recap', 'Recap'],
      ['2026-09-17', 'tnf_matchup_prep', 'Roster Watch'],
      ['2026-09-18', 'weekend_deepdive', 'Roster Watch'],
    ];
    let first = '';
    for (const [publishDate, expectedTrigger, expectedCategory] of dates) {
      const result = await generate({
        feeds: fixtureFeeds(origin), publishDate, out, trigger: null, limit: 4, maxAgeHours: 96,
      });
      const content = fs.readFileSync(result.outFile, 'utf8');
      check(result.article.notificationTrigger === expectedTrigger, `${publishDate} should map to ${expectedTrigger}`);
      check(result.article.category === expectedCategory, `${publishDate} should map to ${expectedCategory}`);
      check(result.article.entities.length === 0, 'internet articles should carry no roster entities');
      check(content.includes('[Fixture RSS](https://example.com/qb-practice)'), 'RSS source link should be preserved');
      check(content.includes('[Fixture Atom](https://example.org/defense)'), 'Atom source link should be preserved');
      check((content.match(/Quarterback returns to practice/g) || []).length === 1, 'duplicate headlines should collapse');
      check(!content.includes('Old report outside the window'), 'stale feed items should be filtered');
      check(!BANNED_CHARS.test(content), 'source copy should be punctuation-cleaned');
      check(!/roster_id|owner_id|sleeperPlayerId/.test(content), 'output should not contain fantasy-league identifiers');
      if (!first) first = content;
    }
    const again = await generate({
      feeds: fixtureFeeds(origin), publishDate: '2026-09-15', out, trigger: null, limit: 4, maxAgeHours: 96,
    });
    check(fs.readFileSync(again.outFile, 'utf8') === first, 'identical feed input should generate identical output');
  } finally {
    server.close();
    fs.rmSync(out, { recursive: true, force: true });
  }
  if (failures.length) {
    console.error('[generate-editorial] SELF-TEST FAILED:');
    failures.forEach((failure) => console.error('  - ' + failure));
    process.exit(1);
  }
  console.log('[generate-editorial] self-test passed: RSS, Atom, deduplication, freshness, cadence routing, attribution, and league independence verified.');
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.selfTest) await runSelfTest();
    else {
      const result = await generate(args);
      console.log(`[generate-editorial] done. Run "npm run build:blog" to compile ${path.relative(ROOT, result.outFile)}.`);
    }
  } catch (err) {
    console.error('[generate-editorial] generation failed.', err);
    process.exit(1);
  }
}

main();

#!/usr/bin/env node
/* ============================================================================
   FSN — CROSS-BLOCK SCOPE SCAN

   `node scripts/scope-scan.mjs`

   index.html ships as several independent inline <script> blocks, each wrapping
   an engine in its own IIFE. A helper defined inside one IIFE is invisible to
   the other blocks, and the failure mode is the worst kind: not a parse error,
   not a build failure, but a runtime ReferenceError thrown mid-render that the
   calling renderer catches and degrades into an empty card. The build is green,
   the deploy succeeds, and the reader sees "This week's board hit a snag".

   CLAUDE.md rule 1 exists because that already shipped once — leagueScopeToken()
   was private to the News Desk IIFE and called from FSNIntel.memo(), so every
   memoised read threw before it could compute anything.

   This script is the mechanical check for that entire class of bug. For each
   inline block it parses the source, collects every binding declared anywhere
   inside it, and reports every identifier the block REFERENCES that resolves to
   nothing: not declared in this block, not a global published by an earlier
   block or an external script, and not a JS/browser builtin.

   Exit code 0 means clean.

   ---- WHAT THIS DELIBERATELY DOES NOT MODEL ----

   Block scoping. A binding declared anywhere in a block counts as declared for
   the whole block. That is an over-approximation, and it is the right direction
   to be wrong in: it cannot produce a false alarm for a correctly-scoped
   helper, and it still catches the real bug — an identifier that exists in NO
   block the caller can see.
============================================================================ */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

/* Identifiers that resolve to the language or the browser rather than to this
   codebase. Kept explicit rather than probed from the running Node process,
   because Node's globals and a browser's are not the same set. */
const BUILTINS = new Set([
  // language
  'globalThis', 'undefined', 'NaN', 'Infinity', 'Object', 'Function', 'Boolean', 'Symbol',
  'Error', 'EvalError', 'RangeError', 'ReferenceError', 'SyntaxError', 'TypeError', 'URIError',
  'Number', 'BigInt', 'Math', 'Date', 'String', 'RegExp', 'Array', 'Map', 'Set', 'WeakMap',
  'WeakSet', 'WeakRef', 'ArrayBuffer', 'SharedArrayBuffer', 'DataView', 'JSON', 'Promise',
  'Reflect', 'Proxy', 'Intl', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'decodeURI',
  'decodeURIComponent', 'encodeURI', 'encodeURIComponent', 'escape', 'unescape', 'eval',
  'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array',
  'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array',
  'AggregateError', 'FinalizationRegistry', 'structuredClone', 'queueMicrotask',
  /* Implicit binding inside every non-arrow function, so it is never a free
     reference even though it is never declared. */
  'arguments',
  // browser
  'window', 'document', 'navigator', 'location', 'history', 'screen', 'console',
  'localStorage', 'sessionStorage', 'indexedDB', 'caches', 'crypto', 'performance',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback',
  'fetch', 'Headers', 'Request', 'Response', 'FormData', 'URL', 'URLSearchParams', 'Blob',
  'File', 'FileReader', 'AbortController', 'AbortSignal', 'TextEncoder', 'TextDecoder',
  'Notification', 'PushManager', 'ServiceWorker', 'ServiceWorkerRegistration',
  'Image', 'Audio', 'Option', 'Event', 'CustomEvent', 'EventTarget', 'MessageChannel',
  'MutationObserver', 'IntersectionObserver', 'ResizeObserver', 'DOMParser', 'XMLSerializer',
  'XMLHttpRequest', 'WebSocket', 'Worker', 'atob', 'btoa', 'alert', 'confirm', 'prompt',
  'matchMedia', 'getComputedStyle', 'scrollTo', 'scrollBy', 'open', 'close', 'postMessage',
  'HTMLElement', 'Element', 'Node', 'NodeList', 'DocumentFragment', 'CSS', 'Range',
  'self', 'top', 'parent', 'frames', 'devicePixelRatio', 'innerWidth', 'innerHeight',
  'Uint8Array', 'clipboardData', 'ClipboardItem', 'visualViewport', 'speechSynthesis',
]);

/* Globals published by external <script src> files loaded before the inline
   blocks. Each is asserted below against the file that actually defines it, so
   this list cannot drift into a rubber stamp. */
const EXTERNAL_GLOBALS = [
  { name: 'EditorialScheduleEngine', file: 'editorialScheduleEngine.js' },
  { name: 'FSNNotifications', file: 'notificationService.js' },
  { name: 'tailwind', file: null },   // cdn.tailwindcss.com
  { name: 'Capacitor', file: null },  // injected by the native WebView shell
];

/* ---------------------------------------------------------------------------
   Extract inline <script> blocks with their line offsets.
--------------------------------------------------------------------------- */
function inlineBlocks(html) {
  const blocks = [];
  const re = /<script([^>]*)>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    const attrs = match[1] || '';
    if (/\bsrc\s*=/.test(attrs)) continue;   // external file, not an inline block
    const body = match[2];
    const startLine = html.slice(0, match.index).split('\n').length;
    blocks.push({ body, startLine });
  }
  return blocks;
}

/* ---------------------------------------------------------------------------
   Collect every binding declared anywhere in an AST, and every free reference.
--------------------------------------------------------------------------- */
function collectPatternNames(node, out) {
  if (!node) return;
  switch (node.type) {
    case 'Identifier': out.add(node.name); break;
    case 'ObjectPattern':
      for (const prop of node.properties) {
        if (prop.type === 'RestElement') collectPatternNames(prop.argument, out);
        else collectPatternNames(prop.value, out);
      }
      break;
    case 'ArrayPattern':
      for (const el of node.elements) collectPatternNames(el, out);
      break;
    case 'AssignmentPattern': collectPatternNames(node.left, out); break;
    case 'RestElement': collectPatternNames(node.argument, out); break;
    default: break;
  }
}

function analyze(ast) {
  const declared = new Set();
  const referenced = new Map();   // name -> first node

  walk.full(ast, (node) => {
    switch (node.type) {
      case 'VariableDeclarator':
        collectPatternNames(node.id, declared);
        break;
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        if (node.id) declared.add(node.id.name);
        for (const param of node.params) collectPatternNames(param, declared);
        break;
      case 'ClassDeclaration':
      case 'ClassExpression':
        if (node.id) declared.add(node.id.name);
        break;
      case 'CatchClause':
        if (node.param) collectPatternNames(node.param, declared);
        break;
      case 'ImportDefaultSpecifier':
      case 'ImportNamespaceSpecifier':
      case 'ImportSpecifier':
        declared.add(node.local.name);
        break;
      case 'LabeledStatement':
        declared.add(node.label.name);
        break;
      default:
        break;
    }
  });

  /* References. `ancestor` gives the parent chain, which is what distinguishes
     a real read of `foo` from the property in `obj.foo`, the key in `{foo: 1}`,
     and a label in `break foo`. */
  walk.ancestor(ast, {
    Identifier(node, _state, ancestors) {
      const parent = ancestors[ancestors.length - 2];
      if (!parent) return;

      // obj.foo  -> `foo` is a property, not a binding (obj[foo] IS a read)
      if (parent.type === 'MemberExpression' && parent.property === node && !parent.computed) return;
      // { foo: 1 } -> key, unless shorthand ({ foo } reads foo)
      if (parent.type === 'Property' && parent.key === node && !parent.computed && !parent.shorthand) return;
      // class { foo(){} }
      if (parent.type === 'MethodDefinition' && parent.key === node && !parent.computed) return;
      if (parent.type === 'PropertyDefinition' && parent.key === node && !parent.computed) return;
      // declaration sites and labels are handled above
      if (parent.type === 'LabeledStatement' || parent.type === 'BreakStatement' ||
          parent.type === 'ContinueStatement') return;
      // function foo(){} / class Foo {}
      if ((parent.type === 'FunctionDeclaration' || parent.type === 'FunctionExpression' ||
           parent.type === 'ArrowFunctionExpression' || parent.type === 'ClassDeclaration' ||
           parent.type === 'ClassExpression') && parent.id === node) return;
      // const foo = ... (the binding, not a read)
      if (parent.type === 'VariableDeclarator' && parent.id === node) return;

      if (!referenced.has(node.name)) referenced.set(node.name, node);
    },
  });

  return { declared, referenced };
}

/* --------------------------------------------------------------------------- */
const htmlPath = join(root, 'index.html');
const html = readFileSync(htmlPath, 'utf8');
const blocks = inlineBlocks(html);

if (!blocks.length) {
  console.error('[scope-scan] no inline <script> blocks found in index.html — the extractor is broken.');
  process.exit(1);
}

/* Verify each declared external global really is published by its file, so the
   allowlist cannot quietly excuse a missing script. */
const externals = new Set();
let externalError = false;
for (const ext of EXTERNAL_GLOBALS) {
  externals.add(ext.name);
  if (!ext.file) continue;
  let source;
  try {
    source = readFileSync(join(root, ext.file), 'utf8');
  } catch (err) {
    console.error(`[scope-scan] ${ext.file} is listed as publishing window.${ext.name} but could not be read.`, err.message);
    externalError = true;
    continue;
  }
  if (!new RegExp('window\\.' + ext.name + '\\s*=').test(source)) {
    console.error(`[scope-scan] ${ext.file} does not assign window.${ext.name}; the allowlist is stale.`);
    externalError = true;
  }
  if (!new RegExp('<script[^>]*src=["\']' + ext.file + '["\']').test(html)) {
    console.error(`[scope-scan] index.html does not load ${ext.file}, but window.${ext.name} is allowlisted.`);
    externalError = true;
  }
}

const parsed = [];
for (let i = 0; i < blocks.length; i++) {
  const block = blocks[i];
  let ast;
  try {
    ast = acorn.parse(block.body, { ecmaVersion: 'latest', sourceType: 'script', locations: true });
  } catch (err) {
    console.error(`[scope-scan] block ${i + 1} (index.html line ${block.startLine}) failed to parse: ${err.message}`);
    process.exit(1);
  }
  parsed.push({ index: i + 1, startLine: block.startLine, ...analyze(ast) });
}

/* Everything any block declares at all is reachable from a later block only if
   it was declared at the top level of an earlier one. Modelling that precisely
   needs real scope analysis; instead, treat every block's declarations plus
   `window.X = ` assignments as the cross-block surface, which is exactly the
   set the runtime actually exposes. */
const windowGlobals = new Set();
for (const match of html.matchAll(/window\.([A-Za-z_$][\w$]*)\s*=/g)) windowGlobals.add(match[1]);

/* A global function/var declared at the top level of ANY inline block is a real
   global at runtime (scripts share one global scope), so collect them all. */
const topLevelGlobals = new Set();
for (const block of blocks) {
  let ast;
  try {
    ast = acorn.parse(block.body, { ecmaVersion: 'latest', sourceType: 'script' });
  } catch { continue; }
  for (const node of ast.body) {
    if (node.type === 'FunctionDeclaration' && node.id) topLevelGlobals.add(node.id.name);
    if (node.type === 'ClassDeclaration' && node.id) topLevelGlobals.add(node.id.name);
    if (node.type === 'VariableDeclaration') {
      for (const d of node.declarations) collectPatternNames(d.id, topLevelGlobals);
    }
  }
}

const findings = [];
for (const block of parsed) {
  for (const [name, node] of block.referenced) {
    if (block.declared.has(name)) continue;
    if (BUILTINS.has(name)) continue;
    if (externals.has(name)) continue;
    if (windowGlobals.has(name)) continue;
    if (topLevelGlobals.has(name)) continue;
    findings.push({
      block: block.index,
      name,
      line: block.startLine + (node.loc ? node.loc.start.line - 1 : 0),
    });
  }
}

console.log(`[scope-scan] parsed ${parsed.length} inline blocks from index.html`);
for (const block of parsed) {
  console.log(`  block ${block.index} (line ${block.startLine}): ` +
    `${block.declared.size} bindings, ${block.referenced.size} references`);
}

if (externalError) {
  console.error('\n[scope-scan] FAILED: the external-global allowlist does not match the files on disk.');
  process.exit(1);
}

if (findings.length) {
  console.error(`\n[scope-scan] FAILED: ${findings.length} identifier(s) resolve to nothing:\n`);
  for (const f of findings) {
    console.error(`  block ${f.block}, index.html:${f.line}  ->  ${f.name}`);
  }
  console.error('\nEach of these throws a ReferenceError at runtime the first time its line runs.');
  console.error('Per CLAUDE.md rule 1, a helper shared across blocks belongs at global scope in');
  console.error('the first block, or on window.FSNBridge if it needs block 6\'s closure.\n');
  process.exit(1);
}

console.log('\n[scope-scan] clean — every identifier resolves.');

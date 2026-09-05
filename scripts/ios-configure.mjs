#!/usr/bin/env node
// Configure the generated Capacitor iOS project for an App Store archive.
//
// `npx cap add ios` scaffolds ios/App from a template every time it runs, and
// this repo does not commit the native project, so CI regenerates it on each
// build. Everything Xcode would normally hold onto — the Info.plist keys from
// docs/ios-handoff.md, the push entitlement, signing settings, the shared
// scheme xcodebuild needs — is re-applied here instead of by hand.
//
// Idempotent: safe to re-run over an already-configured project, so a repo
// that later commits ios/ keeps working unchanged.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const appDir = join(root, 'ios', 'App');
const plistPath = join(appDir, 'App', 'Info.plist');
const pbxPath = join(appDir, 'App.xcodeproj', 'project.pbxproj');
const entitlementsPath = join(appDir, 'App', 'App.entitlements');
const schemePath = join(
  appDir, 'App.xcodeproj', 'xcshareddata', 'xcschemes', 'App.xcscheme'
);

const bool = (v, dflt) => (v === undefined || v === '' ? dflt : !/^(0|false|no)$/i.test(v));

const opts = {
  team: process.env.IOS_TEAM_ID || '',
  signingStyle: (process.env.IOS_SIGNING_STYLE || 'automatic').toLowerCase(),
  profile: process.env.IOS_PROVISIONING_PROFILE_NAME || '',
  push: bool(process.env.IOS_ENABLE_PUSH, true),
  marketingVersion: process.env.IOS_MARKETING_VERSION || '',
  buildNumber: process.env.IOS_BUILD_NUMBER || ''
};

const fail = (msg) => { console.error(`[ios-configure] ${msg}`); process.exit(1); };

if (!existsSync(plistPath)) {
  fail(`no native project at ${plistPath} — run "npx cap add ios" (or "npx cap sync ios") first.`);
}
if (!existsSync(pbxPath)) fail(`missing ${pbxPath}`);

/* ---------------------------------------------------------------- plist --
 * Minimal top-level-dict editor. Only the root <dict> is touched, and only
 * whole key/value pairs are replaced, so nested values (the ATS dict) survive
 * a re-run intact. Deliberately not a general plist parser.
 */
function rootDictRange(xml) {
  const open = xml.indexOf('<dict>');
  if (open < 0) throw new Error('no root <dict> in Info.plist');
  const close = xml.lastIndexOf('</dict>');
  if (close < 0) throw new Error('unterminated root <dict> in Info.plist');
  return { start: open + '<dict>'.length, end: close };
}

const CONTAINERS = new Set(['dict', 'array']);

// Walk the value element that starts at `i`, returning the index just past it.
function endOfValue(xml, i) {
  const tag = /<([a-zA-Z]+)(\s[^>]*)?(\/?)>/g;
  tag.lastIndex = i;
  const m = tag.exec(xml);
  if (!m) throw new Error(`no value element at offset ${i}`);
  const name = m[1];
  if (m[3] === '/') return tag.lastIndex;              // <true/>, <false/>
  if (!CONTAINERS.has(name)) {                          // <string>…</string>
    const close = xml.indexOf(`</${name}>`, tag.lastIndex);
    if (close < 0) throw new Error(`unterminated <${name}>`);
    return close + name.length + 3;
  }
  let depth = 1;                                        // nested dict/array
  let cursor = tag.lastIndex;
  const nested = new RegExp(`<${name}(\\s[^>]*)?(/?)>|</${name}>`, 'g');
  while (depth > 0) {
    nested.lastIndex = cursor;
    const n = nested.exec(xml);
    if (!n) throw new Error(`unterminated <${name}>`);
    if (n[0].startsWith(`</`)) depth--;
    else if (n[2] !== '/') depth++;
    cursor = nested.lastIndex;
  }
  return cursor;
}

// [{ key, start, end }] for every pair in the root dict.
function readPairs(xml) {
  const { start, end } = rootDictRange(xml);
  const keyRe = /<key>([\s\S]*?)<\/key>/g;
  const pairs = [];
  keyRe.lastIndex = start;
  let m;
  while ((m = keyRe.exec(xml)) && m.index < end) {
    const valueStart = xml.indexOf('<', keyRe.lastIndex);
    if (valueStart < 0 || valueStart >= end) break;
    pairs.push({ key: m[1].trim(), start: m.index, end: endOfValue(xml, valueStart) });
    keyRe.lastIndex = pairs[pairs.length - 1].end;
  }
  return pairs;
}

function setTopLevelKeys(xml, entries) {
  for (const [key, value] of entries) {
    const block = `\t<key>${key}</key>\n${value}`;
    const pair = readPairs(xml).find((p) => p.key === key);
    if (pair) {
      xml = xml.slice(0, pair.start) + block.replace(/^\t/, '') + xml.slice(pair.end);
    } else {
      const { end } = rootDictRange(xml);
      xml = xml.slice(0, end) + block + '\n' + xml.slice(end);
    }
  }
  return xml;
}

const portrait = (extra) =>
  '\t<array>\n\t\t<string>UIInterfaceOrientationPortrait</string>\n' +
  (extra ? '\t\t<string>UIInterfaceOrientationPortraitUpsideDown</string>\n' : '') +
  '\t</array>';

// Mirrors the "Info.plist snippets" section of docs/ios-handoff.md.
const ats =
  '\t<dict>\n' +
  '\t\t<key>NSAllowsArbitraryLoads</key>\n\t\t<false/>\n' +
  '\t\t<key>NSExceptionDomains</key>\n\t\t<dict>\n' +
  ['espn.com', 'supabase.co', 'vercel.app', 'fantasysportsnetwork.app']
    .map((d) =>
      `\t\t\t<key>${d}</key>\n\t\t\t<dict>\n` +
      '\t\t\t\t<key>NSIncludesSubdomains</key>\n\t\t\t\t<true/>\n' +
      '\t\t\t\t<key>NSExceptionAllowsInsecureHTTPLoads</key>\n\t\t\t\t<false/>\n' +
      '\t\t\t</dict>\n')
    .join('') +
  '\t\t</dict>\n\t</dict>';

const plistEntries = [
  ['UISupportedInterfaceOrientations', portrait(false)],
  ['UISupportedInterfaceOrientations~ipad', portrait(true)],
  ['UIStatusBarStyle', '\t<string>UIStatusBarStyleLightContent</string>'],
  ['UIViewControllerBasedStatusBarAppearance', '\t<false/>'],
  ['NSAppTransportSecurity', ats],
  ['ITSAppUsesNonExemptEncryption', '\t<false/>']
];

if (opts.push) {
  // @capacitor/push-notifications is a dependency and notificationService.js
  // registers for APNs, so the background mode has to be declared.
  plistEntries.push([
    'UIBackgroundModes',
    '\t<array>\n\t\t<string>remote-notification</string>\n\t</array>'
  ]);
}

let plist = readFileSync(plistPath, 'utf8');
try {
  plist = setTopLevelKeys(plist, plistEntries);
} catch (err) {
  console.error('[ios-configure] failed to patch Info.plist', err);
  process.exit(1);
}
writeFileSync(plistPath, plist);
console.log(`[ios-configure] Info.plist: ${plistEntries.map((e) => e[0]).join(', ')}`);

/* --------------------------------------------------------- entitlements --
 * TestFlight and the App Store both ride the production APNs environment.
 */
if (opts.push) {
  writeFileSync(entitlementsPath,
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    '<plist version="1.0">\n<dict>\n' +
    '\t<key>aps-environment</key>\n\t<string>production</string>\n' +
    '</dict>\n</plist>\n');
  console.log('[ios-configure] wrote App.entitlements (aps-environment: production)');
}

/* --------------------------------------------------------------- scheme --
 * The Capacitor template ships no shared scheme. Xcode writes one on first GUI
 * open; a headless runner never opens it, so `xcodebuild -scheme App` against
 * the workspace would have nothing to resolve. Write it ourselves.
 */
if (!existsSync(schemePath)) {
  mkdirSync(dirname(schemePath), { recursive: true });
  // Blueprint identifier is the App PBXNativeTarget from the Capacitor template.
  const ref =
    '<BuildableReference BuildableIdentifier="primary" ' +
    'BlueprintIdentifier="504EC3031FED79650016851F" BuildableName="App.app" ' +
    'BlueprintName="App" ReferencedContainer="container:App.xcodeproj">' +
    '</BuildableReference>';
  writeFileSync(schemePath,
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<Scheme LastUpgradeVersion="1500" version="1.7">\n' +
    '  <BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES">\n' +
    '    <BuildActionEntries>\n' +
    '      <BuildActionEntry buildForTesting="YES" buildForRunning="YES" ' +
    'buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES">\n' +
    `        ${ref}\n` +
    '      </BuildActionEntry>\n' +
    '    </BuildActionEntries>\n' +
    '  </BuildAction>\n' +
    '  <TestAction buildConfiguration="Debug" ' +
    'selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" ' +
    'selectedLauncherIdentifier="Xcode.DebuggerFoundation.Launcher.LLDB" ' +
    'shouldUseLaunchSchemeArgsEnv="YES"><Testables></Testables></TestAction>\n' +
    '  <LaunchAction buildConfiguration="Debug" ' +
    'selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" ' +
    'selectedLauncherIdentifier="Xcode.DebuggerFoundation.Launcher.LLDB" ' +
    'launchStyle="0" useCustomWorkingDirectory="NO" ignoresPersistentStateOnLaunch="NO" ' +
    'debugDocumentVersioning="YES" debugServiceExtension="internal" ' +
    'allowLocationSimulation="YES">\n' +
    '    <BuildableProductRunnable runnableDebuggingMode="0">\n' +
    `      ${ref}\n` +
    '    </BuildableProductRunnable>\n' +
    '  </LaunchAction>\n' +
    '  <ProfileAction buildConfiguration="Release" shouldUseLaunchSchemeArgsEnv="YES" ' +
    'savedToolIdentifier="" useCustomWorkingDirectory="NO" debugDocumentVersioning="YES">\n' +
    '    <BuildableProductRunnable runnableDebuggingMode="0">\n' +
    `      ${ref}\n` +
    '    </BuildableProductRunnable>\n' +
    '  </ProfileAction>\n' +
    '  <AnalyzeAction buildConfiguration="Debug"></AnalyzeAction>\n' +
    '  <ArchiveAction buildConfiguration="Release" revealArchiveInOrganizer="YES">' +
    '</ArchiveAction>\n' +
    '</Scheme>\n');
  console.log('[ios-configure] wrote shared scheme App.xcscheme');
} else {
  console.log('[ios-configure] shared scheme already present, left as-is');
}

/* ------------------------------------------------------------- pbxproj --
 * Signing, team and version settings, applied only to the App target's build
 * configurations. Passing these on the xcodebuild command line instead would
 * apply them to every target in the workspace, including the Pods targets,
 * where an entitlements file or a distribution identity does not belong.
 *
 * The App target's configs are the only XCBuildConfiguration blocks carrying
 * INFOPLIST_FILE = App/Info.plist.
 */
const SETTING = 'INFOPLIST_FILE = App/Info.plist;';

const settings = {};
if (opts.team) settings.DEVELOPMENT_TEAM = opts.team;
if (opts.marketingVersion) settings.MARKETING_VERSION = opts.marketingVersion;
if (opts.buildNumber) settings.CURRENT_PROJECT_VERSION = opts.buildNumber;
if (opts.push) settings.CODE_SIGN_ENTITLEMENTS = 'App/App.entitlements';

if (opts.signingStyle === 'manual') {
  if (!opts.profile) fail('IOS_SIGNING_STYLE=manual requires IOS_PROVISIONING_PROFILE_NAME.');
  settings.CODE_SIGN_STYLE = 'Manual';
  settings.CODE_SIGN_IDENTITY = '"Apple Distribution"';
  settings.PROVISIONING_PROFILE_SPECIFIER = `"${opts.profile}"`;
} else {
  settings.CODE_SIGN_STYLE = 'Automatic';
  // The template pins the legacy "iPhone Developer" identity at project level,
  // which would pull a development cert into an App Store archive.
  settings.CODE_SIGN_IDENTITY = '"Apple Distribution"';
  settings.PROVISIONING_PROFILE_SPECIFIER = '""';
}

let pbx = readFileSync(pbxPath, 'utf8');
let patched = 0;

// Split on config blocks and rewrite the buildSettings of matching ones.
pbx = pbx.replace(
  /(\t\t[0-9A-F]{24} \/\* (?:Debug|Release) \*\/ = \{\n\t\t\tisa = XCBuildConfiguration;[\s\S]*?\n\t\t\tbuildSettings = \{\n)([\s\S]*?)(\n\t\t\t\};)/g,
  (whole, head, body, tail) => {
    if (!body.includes(SETTING)) return whole;
    let next = body;
    for (const [key, value] of Object.entries(settings)) {
      const line = `\t\t\t\t${key} = ${value};`;
      const re = new RegExp(`^\\t\\t\\t\\t${key} = .*;$`, 'm');
      next = re.test(next) ? next.replace(re, line) : `${next}\n${line}`;
    }
    // Keep buildSettings alphabetised the way Xcode writes them back.
    next = next.split('\n').filter(Boolean).sort((a, b) =>
      a.trim().localeCompare(b.trim())).join('\n');
    patched++;
    return head + next + tail;
  }
);

if (patched === 0) {
  fail(`no App target build configurations found in ${pbxPath} (looked for "${SETTING}")`);
}

// The target still advertises the template's provisioning style; align it so
// Xcode does not re-derive automatic signing over a manual build.
pbx = pbx.replace(
  /ProvisioningStyle = \w+;/g,
  `ProvisioningStyle = ${opts.signingStyle === 'manual' ? 'Manual' : 'Automatic'};`
);

writeFileSync(pbxPath, pbx);
console.log(
  `[ios-configure] pbxproj: patched ${patched} App build configuration(s) — ` +
  Object.keys(settings).join(', ')
);
console.log(
  `[ios-configure] done (signing=${opts.signingStyle}, push=${opts.push}, ` +
  `team=${opts.team || 'unset'}, version=${opts.marketingVersion || 'project default'}, ` +
  `build=${opts.buildNumber || 'project default'})`
);

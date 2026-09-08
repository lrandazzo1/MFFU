#!/usr/bin/env node
// Verify the generated catalog really uses the FSN source, rather than a scaffold icon.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import sharp from 'sharp';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const master = join(root, 'assets/icon.png');
const meta = await sharp(master).metadata();
assert.equal(meta.width, 1024);
assert.equal(meta.height, 1024);
assert.equal(meta.hasAlpha, false, 'App icon must be opaque');
const folder = join(root, 'ios/App/App/Assets.xcassets/AppIcon.appiconset');
const catalog = JSON.parse(readFileSync(join(folder, 'Contents.json'), 'utf8'));
assert(catalog.images.length > 0, 'Empty app icon catalog');
for(const entry of catalog.images){
  assert(entry.filename, 'Missing icon slot');
  const file = join(folder, entry.filename);
  const actual = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject:true });
  assert.equal(actual.info.width, actual.info.height, 'Icon must be square');
  const expectedSize = Number(String(entry.size).split('x')[0]) * Number(String(entry.scale || '1x').replace('x',''));
  if(Number.isFinite(expectedSize)) assert.equal(actual.info.width, expectedSize, 'Incorrect icon size');
  const expected = await sharp(master).resize(actual.info.width).removeAlpha().raw().toBuffer();
  assert.deepEqual(actual.data, expected, `Icon ${entry.filename} is not the FSN master`);
}
console.log(`[assets] ${catalog.images.length} generated icon slots match the opaque FSN master.`);

#!/usr/bin/env node
import sharp from 'sharp';
import assert from 'node:assert/strict';
const { data, info } = await sharp(process.argv[2]).removeAlpha().raw().toBuffer({ resolveWithObject:true });
const reference = await sharp(new URL('../assets/icon.png', import.meta.url).pathname)
  .resize(info.width, info.height).removeAlpha().raw().toBuffer();
assert.equal(data.length, reference.length);
let difference = 0;
for(let i = 0; i < data.length; i++) difference += Math.abs(data[i] - reference[i]);
// Xcode's resampler can differ at letter edges; the overall image must agree.
assert(difference / data.length < 6, 'Compiled app icon does not match FSN branding');
console.log(`[ios-release] FSN icon verified at ${info.width}×${info.height}.`);

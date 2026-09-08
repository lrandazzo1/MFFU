#!/usr/bin/env node
// Rasterize FSN's outlined vector mark. No network fonts or machine-specific text rendering.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const asset = name => fileURLToPath(new URL('../assets/' + name, import.meta.url));
const source = readFileSync(asset('icon.svg'));
await sharp(source).resize(1024, 1024).removeAlpha().png().toFile(asset('icon.png'));
const mark = await sharp(source).resize(768, 768).removeAlpha().png().toBuffer();
await sharp({ create:{ width:2732, height:2732, channels:3, background:'#080a0e' } })
  .composite([{ input:mark, gravity:'centre' }]).removeAlpha().png().toFile(asset('splash.png'));
console.log('[assets] Generated opaque FSN icon (1024×1024) and splash (2732×2732).');

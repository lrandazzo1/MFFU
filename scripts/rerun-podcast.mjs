#!/usr/bin/env node
// One-league forced regeneration. The existing ready row stays live until the
// replacement is uploaded and verified at a new, cache-safe Storage path.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';

const require = createRequire(import.meta.url);
const { buildLeagueEpisode, readNewsPayload } = require('../lib/dist/generate-weekly-podcast.js');
const { readMp3Frames } = require('../lib/dist/mp3-frames.js');
const ffmpeg = process.env.FFMPEG_PATH || require('ffmpeg-static');
const BUCKET = 'podcast-episodes';

const args = Object.fromEntries(process.argv.slice(2).filter(arg => arg.startsWith('--') && arg.includes('='))
  .map(arg => arg.slice(2).split(/=(.*)/s).slice(0, 2)));
const leagueId = args.leagueId;
const week = Number(args.week);
const season = Number(args.season);
assert.match(leagueId || '', /^\d{1,20}$/, 'Invalid league ID');
assert.equal(week, 2, 'Only Week 2 was authorized');
assert.equal(season, 2026, 'Only the 2026 season was authorized');
assert.ok(process.argv.includes('--force'), 'The --force flag is required');

for (const key of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'ELEVENLABS_API_KEY'])
  assert.ok(process.env[key], key + ' repository secret is unavailable; no episode was changed');

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } });
const { data: current, error: readError } = await db.from('podcast_episodes')
  .select('status, audio_url, episode, updated_at')
  .eq('league_id', leagueId).eq('season', season).eq('week', week).single();
if (readError) throw readError;
assert.ok(current, 'No existing episode row to replace');
assert.notEqual(current.status, 'generating', 'An episode is already being generated');
assert.ok(await readNewsPayload(db, leagueId, season, week),
  'No published Week 2 news payload; no TTS was requested');

console.log('[rerun-podcast] Replacing 2026 Week 2 for league ' + leagueId);
const outcome = await buildLeagueEpisode({ league_id: leagueId, season, week },
  { db, format: 'news', script_only: false });
assert.ok(outcome.audio?.length, 'The regenerated episode has no audio');
assert.equal(outcome.turnMarkers.length, outcome.script.lines.length, 'Turn cues do not match lines');
assert.equal(outcome.storyReelMarkers.length, outcome.script.stories.length,
  'Story Reel cues do not match stories');
assert.ok(outcome.storyReelMarkers.length > 0, 'No Story Reel cues were generated');
const frames = readMp3Frames(outcome.audio);
assert.equal(frames.sampleRate, 48000, 'The final MP3 is not 48 kHz');
assert.equal(frames.bitrateKbps, 128, 'The final MP3 is not 128 kbps CBR');
const durationMs = Math.round(frames.duration * 1000);
for (const [name, cues] of [['turn', outcome.turnMarkers], ['story', outcome.storyReelMarkers]]) {
  cues.forEach((cue, i) => {
    assert.ok(Number.isInteger(cue.startMs) && Number.isInteger(cue.endMs),
      name + ' cue has invalid millisecond timestamps');
    assert.ok(cue.startMs >= 0 && cue.endMs > cue.startMs && cue.endMs <= durationMs,
      name + ' cue is outside the final MP3');
    if (i) assert.equal(cue.startMs, cues[i - 1].endMs, name + ' cues have a gap');
  });
  assert.equal(cues.at(-1).endMs, durationMs, name + ' final cue misses the MP3 end');
}
assert.equal(outcome.turnMarkers[0].startMs, outcome.leadInOffsetMs, 'Lead-in offset mismatch');
const decoded = spawnSync(ffmpeg, ['-hide_banner', '-nostdin', '-loglevel', 'error',
  '-f', 'mp3', '-i', 'pipe:0', '-f', 'null', '-'],
{ input: outcome.audio, timeout: 45_000, maxBuffer: 2 * 1024 * 1024 });
assert.equal(decoded.status, 0, 'FFmpeg rejected the MP3: ' + decoded.stderr?.toString().slice(-1000));

const digest = createHash('sha256').update(outcome.audio).digest('hex');
const path = `${leagueId}/${season}/${week}-regenerated-${digest.slice(0, 16)}.mp3`;
const bucket = db.storage.from(BUCKET);
const uploaded = await bucket.upload(path, outcome.audio,
  { contentType: 'audio/mpeg', upsert: false, cacheControl: '3600' });
if (uploaded.error && !/already exists|duplicate/i.test(uploaded.error.message))
  throw uploaded.error;
const download = await bucket.download(path);
if (download.error) throw download.error;
const stored = Buffer.from(await download.data.arrayBuffer());
assert.equal(createHash('sha256').update(stored).digest('hex'), digest,
  'Stored MP3 does not match the validated output');
const audioUrl = bucket.getPublicUrl(path).data.publicUrl;
const episode = {
  title: outcome.script.title, lines: outcome.script.lines,
  stories: outcome.script.stories, visuals: current.episode?.visuals || [],
  segments: outcome.script.segments.map(s => ({
    key: s.key, title: s.title, headline: s.headline, populated: s.populated,
  })),
  markers: outcome.markers, turn_markers: outcome.turnMarkers,
  story_reel_markers: outcome.storyReelMarkers, leadInOffsetMs: outcome.leadInOffsetMs,
  week, year: season, leagueId, createdAt: Date.now(),
};
let saved;
try {
  const result = await db.from('podcast_episodes')
    .update({ status: 'ready', episode, audio_url: audioUrl,
      updated_at: new Date().toISOString() })
    .eq('league_id', leagueId).eq('season', season).eq('week', week)
    .eq('updated_at', current.updated_at)
    .select('status, audio_url, episode').single();
  if (result.error) throw result.error;
  saved = result.data;
  assert.equal(saved.status, 'ready');
  assert.equal(saved.audio_url, audioUrl);
  assert.deepEqual(saved.episode.story_reel_markers, outcome.storyReelMarkers);
} catch (err) {
  const cleanup = await bucket.remove([path]);
  if (cleanup.error) console.warn('[rerun-podcast] Could not remove unused staged MP3:', cleanup.error.message);
  throw err;
}
const oldUrl = current.audio_url || '';
const oldPath = oldUrl.includes('/storage/v1/object/public/' + BUCKET + '/')
  ? decodeURIComponent(oldUrl.split('/storage/v1/object/public/' + BUCKET + '/')[1].split('?')[0])
  : null;
if (oldPath && oldPath.startsWith(leagueId + '/' + season + '/') && oldPath !== path) {
  const removed = await bucket.remove([oldPath]);
  if (removed.error) console.warn('[rerun-podcast] Previous MP3 remains in Storage:', removed.error.message);
}
console.log(JSON.stringify({ status: saved.status, audioUrl, leagueId, season, week,
  audioBytes: stored.length, sampleRate: frames.sampleRate,
  bitrateKbps: frames.bitrateKbps, durationMs, storyReelMarkers: saved.episode.story_reel_markers,
  turnMarkers: saved.episode.turn_markers }, null, 2));

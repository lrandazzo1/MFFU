"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.configuredPodcastStingers = configuredPodcastStingers;
exports.storyReelMarkers = storyReelMarkers;
exports.duckStingers = duckStingers;
exports.buildPodcastAudio = buildPodcastAudio;
const node_child_process_1 = require("node:child_process");
const promises_1 = require("node:fs/promises");
const node_fs_1 = require("node:fs");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const ffmpeg_static_1 = __importDefault(require("ffmpeg-static"));
const mp3_frames_1 = require("./mp3-frames");
const RATE = 48000;
const CHANNELS = 2;
const BYTES_PER_SAMPLE = CHANNELS * 2; // interleaved signed 16-bit PCM
const FADE_SAMPLES = Math.round(RATE * 0.07);
const MAX_TURN_BYTES = 8 * 1024 * 1024;
const MAX_STINGER_BYTES = 5 * 1024 * 1024;
const FFMPEG = process.env.FFMPEG_PATH || ffmpeg_static_1.default;
/** Build one card range per story from the final audio turn ranges. */
function storyReelMarkers(turns, storyCount, segmentTurnCounts) {
    if (!turns.length || !storyCount) return [];
    const grouped = segmentTurnCounts && segmentTurnCounts.length === storyCount &&
        segmentTurnCounts.every(n => Number.isInteger(n) && n > 0) &&
        segmentTurnCounts.reduce((sum, n) => sum + n, 0) === turns.length;
    const starts = [];
    if (grouped) {
        let turn = 0;
        for (const count of segmentTurnCounts) {
            starts.push(turns[turn].startMs);
            turn += count;
        }
    } else {
        for (let story = 0; story < storyCount; story++)
            starts.push(turns[Math.min(story === 0 ? 0 :
                storyCount < turns.length ? story + 1 : story, turns.length - 1)].startMs);
    }
    return starts.map((startMs, i) => ({
        startMs, endMs: i + 1 < starts.length ? starts[i + 1] : turns[turns.length - 1].endMs,
    }));
}
/** Optional, deploy-owned tracks. No file is needed for speech-only episodes. */
async function configuredPodcastStingers() {
    const base = (0, node_path_1.join)(process.cwd(), 'assets/podcast-audio');
    const load = async (name) => {
        const path = (0, node_path_1.join)(base, name);
        if (!(0, node_fs_1.existsSync)(path))
            return undefined;
        if ((await (0, promises_1.stat)(path)).size > MAX_STINGER_BYTES)
            throw new Error('Podcast stinger is too large: ' + name);
        return (0, promises_1.readFile)(path);
    };
    return { intro: await load('intro.mp3'), outro: await load('outro.mp3') };
}
function runFfmpeg(args) {
    if (!FFMPEG)
        throw new Error('Podcast FFmpeg binary is unavailable');
    return new Promise((done, reject) => {
        const child = (0, node_child_process_1.spawn)(FFMPEG, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        let settled = false;
        const timer = setTimeout(() => child.kill('SIGKILL'), 45_000);
        child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-4096); });
        const finish = (error) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            if (error)
                reject(error);
            else
                done();
        };
        child.on('error', err => finish(err));
        child.on('close', code => finish(code === 0 ? undefined :
            new Error('Podcast FFmpeg failed (' + code + '): ' + stderr)));
    });
}
async function decode(input, path, prefix, maxBytes = MAX_TURN_BYTES) {
    if (!input.length || input.length > maxBytes)
        throw new Error('Invalid podcast audio input size');
    const encoded = path + '.mp3';
    await (0, promises_1.writeFile)(encoded, input);
    await runFfmpeg(['-i', encoded, '-map', '0:a:0', '-vn', '-ac', String(CHANNELS),
        '-ar', String(RATE), '-f', 's16le', '-acodec', 'pcm_s16le', path]);
    const size = (await (0, promises_1.stat)(path)).size;
    if (!size || size % BYTES_PER_SAMPLE)
        throw new Error('Podcast ' + prefix + ' decoded to invalid PCM');
    return size / BYTES_PER_SAMPLE;
}
function crossfadePcm(turns) {
    const overlapBytes = FADE_SAMPLES * BYTES_PER_SAMPLE;
    const length = turns.reduce((n, turn) => n + turn.length, 0) - (turns.length - 1) * overlapBytes;
    const output = Buffer.allocUnsafe(length);
    let cursor = 0;
    for (let i = 0; i < turns.length; i++) {
        const turn = turns[i];
        const start = i ? cursor - overlapBytes : 0;
        if (i) {
            for (let sample = 0; sample < FADE_SAMPLES; sample++) {
                const gain = sample / (FADE_SAMPLES - 1);
                for (let channel = 0; channel < CHANNELS; channel++) {
                    const at = (sample * CHANNELS + channel) * 2;
                    const mixed = Math.round(output.readInt16LE(start + at) * (1 - gain) + turn.readInt16LE(at) * gain);
                    output.writeInt16LE(Math.max(-32768, Math.min(32767, mixed)), start + at);
                }
            }
        }
        turn.copy(output, start + (i ? overlapBytes : 0), i ? overlapBytes : 0);
        cursor = start + turn.length;
    }
    return output;
}
/** Speech-gated bed mix. Sustained speech moves music to -12 dB over 10 ms;
 * its release is 200 ms so pauses do not pump the background level. */
function duckStingers(speech, intro, outro) {
    if (!intro && !outro)
        return speech;
    const result = Buffer.allocUnsafe(speech.length);
    const frames = speech.length / BYTES_PER_SAMPLE;
    const introFrames = (intro?.length || 0) / BYTES_PER_SAMPLE;
    const outroFrames = (outro?.length || 0) / BYTES_PER_SAMPLE;
    const outroStart = Math.max(0, frames - outroFrames);
    let gain = 1;
    let level = 0;
    const gate = 0.008; // about -42 dBFS speech RMS
    const duckedGain = Math.pow(10, -12 / 20);
    const detectorStep = 1 / Math.round(RATE * 0.01);
    const attackStep = 1 / Math.round(RATE * 0.01);
    const releaseStep = 1 / Math.round(RATE * 0.2);
    for (let frame = 0; frame < frames; frame++) {
        const left = speech.readInt16LE(frame * 4);
        const right = speech.readInt16LE(frame * 4 + 2);
        const peak = Math.max(Math.abs(left), Math.abs(right)) / 32768;
        level += (peak - level) * detectorStep;
        const target = level > gate ? duckedGain : 1;
        gain += (target - gain) * (target < gain ? attackStep : releaseStep);
        for (let channel = 0; channel < CHANNELS; channel++) {
            const at = frame * 4 + channel * 2;
            let bed = frame < introFrames ? intro.readInt16LE(at) : 0;
            const outroFrame = frame - outroStart;
            if (outroFrame >= 0 && outroFrame < outroFrames)
                bed += outro.readInt16LE(outroFrame * 4 + channel * 2);
            const mixed = Math.round(speech.readInt16LE(at) + bed * gain);
            result.writeInt16LE(Math.max(-32768, Math.min(32767, mixed)), at);
        }
    }
    return result;
}
/** Decode each independent provider turn, overlap adjacent speakers by 70 ms,
 * optionally duck music beneath speech, normalize and encode one fresh MP3.
 * Markers switch at the midpoint of each overlap; the final one matches the
 * encoded MP3 duration used by the browser audio element. */
async function buildPodcastAudio(segments, stingers = {}) {
    if (!segments.length || segments.length > 16)
        throw new Error('Invalid podcast audio segment count');
    const directory = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'fsn-podcast-'));
    try {
        const paths = [];
        const samples = [];
        for (let i = 0; i < segments.length; i++) {
            const path = (0, node_path_1.join)(directory, `turn-${i}.pcm`);
            samples.push(await decode(segments[i], path, `turn ${i}`));
            paths.push(path);
        }
        if (samples.some(n => n <= FADE_SAMPLES * 2))
            throw new Error('Podcast turn is too short for a 70 ms crossfade');
        let mixed = crossfadePcm(await Promise.all(paths.map(path => (0, promises_1.readFile)(path))));
        const requestedLeadIn = stingers.intro ? (stingers.leadInOffsetMs ?? 250) : (stingers.leadInOffsetMs ?? 0);
        if (!Number.isFinite(requestedLeadIn) || requestedLeadIn < 0 || requestedLeadIn > 5000)
            throw new Error('Invalid podcast lead-in offset');
        const leadInSamples = Math.round(requestedLeadIn * RATE / 1000);
        if (leadInSamples) mixed = Buffer.concat([Buffer.alloc(leadInSamples * BYTES_PER_SAMPLE), mixed]);
        const mixedSamples = mixed.length / BYTES_PER_SAMPLE;
        const boundaries = [];
        let elapsed = leadInSamples;
        for (let i = 0; i < samples.length; i++) {
            elapsed += samples[i] - (i ? FADE_SAMPLES : 0);
            boundaries.push(elapsed - (i < samples.length - 1 ? FADE_SAMPLES / 2 : 0));
        }
        const beds = {};
        for (const kind of ['intro', 'outro']) {
            const data = stingers[kind];
            if (!data)
                continue;
            if (data.length > MAX_STINGER_BYTES)
                throw new Error('Podcast ' + kind + ' stinger is too large');
            const path = (0, node_path_1.join)(directory, kind + '.pcm');
            await decode(data, path, kind);
            beds[kind] = await (0, promises_1.readFile)(path);
        }
        mixed = duckStingers(mixed, beds.intro, beds.outro);
        const mixPath = (0, node_path_1.join)(directory, 'mix.pcm');
        await (0, promises_1.writeFile)(mixPath, mixed);
        const output = (0, node_path_1.join)(directory, 'episode.mp3');
        await runFfmpeg(['-f', 's16le', '-ar', String(RATE), '-ac', String(CHANNELS), '-i', mixPath,
            '-af', `loudnorm=I=-16:TP=-1.0:LRA=11,aresample=${RATE}`,
            '-map_metadata', '-1', '-ac', String(CHANNELS), '-ar', String(RATE),
            '-c:a', 'libmp3lame', '-b:a', '128k', '-minrate', '128k', '-maxrate', '128k', '-id3v2_version', '0', output]);
        const audio = await (0, promises_1.readFile)(output);
        if (!audio.length)
            throw new Error('Podcast mix encoded an empty MP3');
        const frames = (0, mp3_frames_1.readMp3Frames)(audio);
        if (frames.sampleRate !== RATE || frames.bitrateKbps !== 128)
            throw new Error('Podcast output must be 48 kHz / 128 kbps CBR MP3');
        const decodedSamples = await decode(audio, (0, node_path_1.join)(directory, 'final.pcm'), 'final MP3', 64 * 1024 * 1024);
        const durationMs = Math.round(frames.duration * 1000);
        if (Math.abs(decodedSamples / RATE - frames.duration) > 0.1)
            throw new Error('Podcast decoded duration disagrees with MP3 frame timeline');
        const cueAt = (sample) => Math.max(0, Math.min(durationMs,
            Math.round(Math.round(sample * decodedSamples / mixedSamples) * 1000 / RATE)));
        const turnMarkers = [];
        let startMs = cueAt(leadInSamples);
        for (let i = 0; i < boundaries.length; i++) {
            const endMs = i === boundaries.length - 1 ? durationMs : cueAt(boundaries[i]);
            if (endMs <= startMs) throw new Error('Podcast output has a collapsed visual cue');
            turnMarkers.push({ startMs, endMs });
            startMs = endMs;
        }
        return { audio, markers: turnMarkers.map(cue => cue.endMs / 1000),
            turnMarkers, leadInOffsetMs: turnMarkers[0].startMs };
    }
    finally {
        await (0, promises_1.rm)(directory, { recursive: true, force: true });
    }
}

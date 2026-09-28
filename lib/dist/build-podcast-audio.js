"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildPodcastAudio = buildPodcastAudio;
const mp3_frames_1 = require("./mp3-frames");
/** Join complete provider turns once, with markers based on decoded samples.
 * Raw MP3 stitching preserves each turn's encoder delay; sample-exact gapless
 * joins, stingers and loudness normalization require a decode/mix/re-encode. */
function buildPodcastAudio(segments) {
    if (!segments.length)
        throw new Error('Podcast has no audio segments');
    const parsed = segments.map(mp3_frames_1.readMp3Frames);
    if (parsed.some(segment => segment.mono !== parsed[0].mono))
        throw new Error('Podcast MP3 segments have inconsistent channel layouts');
    let elapsed = 0;
    const markers = parsed.map(segment => (elapsed += segment.duration));
    return { audio: Buffer.concat(parsed.map(segment => segment.audio)), markers };
}

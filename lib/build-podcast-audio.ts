import { readMp3Frames } from './mp3-frames';

/** Join complete provider turns once, with markers based on decoded samples.
 * Raw MP3 stitching preserves each turn's encoder delay; sample-exact gapless
 * joins, stingers and loudness normalization require a decode/mix/re-encode. */
export function buildPodcastAudio(segments: Buffer[]): { audio: Buffer; markers: number[] } {
  if (!segments.length) throw new Error('Podcast has no audio segments');
  const parsed = segments.map(readMp3Frames);
  if (parsed.some(segment => segment.mono !== parsed[0].mono))
    throw new Error('Podcast MP3 segments have inconsistent channel layouts');
  let elapsed = 0;
  const markers = parsed.map(segment => (elapsed += segment.duration));
  return { audio: Buffer.concat(parsed.map(segment => segment.audio)), markers };
}

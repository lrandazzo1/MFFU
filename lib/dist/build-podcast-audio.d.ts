/** Join complete provider turns once, with markers based on decoded samples.
 * Raw MP3 stitching preserves each turn's encoder delay; sample-exact gapless
 * joins, stingers and loudness normalization require a decode/mix/re-encode. */
export declare function buildPodcastAudio(segments: Buffer[]): {
    audio: Buffer;
    markers: number[];
};

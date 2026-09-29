export type PodcastStingers = {
    intro?: Buffer;
    outro?: Buffer;
    leadInOffsetMs?: number;
};
export type PodcastCue = {
    startMs: number;
    endMs: number;
};
/** Build one card range per story from the final audio turn ranges. */
export declare function storyReelMarkers(turns: PodcastCue[], storyCount: number, segmentTurnCounts?: number[]): PodcastCue[];
/** Optional, deploy-owned tracks. No file is needed for speech-only episodes. */
export declare function configuredPodcastStingers(): Promise<PodcastStingers>;
/** Speech-gated bed mix. Sustained speech moves music to -12 dB over 10 ms;
 * its release is 200 ms so pauses do not pump the background level. */
export declare function duckStingers(speech: Buffer, intro?: Buffer, outro?: Buffer): Buffer;
/** Decode each independent provider turn, overlap adjacent speakers by 70 ms,
 * optionally duck music beneath speech, normalize and encode one fresh MP3.
 * Switch turns at the midpoint of each overlap and measure the final output
 * again after encoding so playback cues share the browser's audio timeline. */
export declare function buildPodcastAudio(segments: Buffer[], stingers?: PodcastStingers): Promise<{
    audio: Buffer;
    markers: number[];
    turnMarkers: PodcastCue[];
    leadInOffsetMs: number;
}>;

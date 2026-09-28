export type PodcastStingers = {
    intro?: Buffer;
    outro?: Buffer;
};
/** Optional, deploy-owned tracks. No file is needed for speech-only episodes. */
export declare function configuredPodcastStingers(): Promise<PodcastStingers>;
/** Speech-gated bed mix. Sustained speech moves music to -12 dB over 10 ms;
 * its release is 200 ms so pauses do not pump the background level. */
export declare function duckStingers(speech: Buffer, intro?: Buffer, outro?: Buffer): Buffer;
/** Decode each independent provider turn, overlap adjacent speakers by 70 ms,
 * optionally duck music beneath speech, normalize and encode one fresh MP3.
 * Markers switch at the midpoint of each overlap; the final one matches the
 * encoded MP3 duration used by the browser audio element. */
export declare function buildPodcastAudio(segments: Buffer[], stingers?: PodcastStingers): Promise<{
    audio: Buffer;
    markers: number[];
}>;

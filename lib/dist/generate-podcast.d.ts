type Request = {
    method?: string;
    headers: Record<string, string | undefined>;
    body?: unknown;
};
type Response = {
    status(code: number): Response;
    json(data: unknown): void;
    setHeader(key: string, value: string): void;
    end(data?: Buffer): void;
};
/**
 * Dialogue turns one episode may carry.
 *
 * Was 6, which fit the original single-block recap. The four-segment script in
 * `lib/podcast-script.ts` is a cold open, two turns per segment and a sign-off
 * — ten turns — so a cap of 6 rejected every scheduled episode with the generic
 * "Invalid episode request" and no way to tell which of that condition's nine
 * clauses had failed.
 *
 * It is still a hard ceiling, not a formality: every turn is one ElevenLabs
 * call, so this is the per-request spend bound. 16 leaves room for a fifth
 * segment without leaving room for a runaway payload, and the 24000-character
 * body limit below still applies on top of it.
 */
export declare const MAX_EPISODE_LINES = 16;
export declare const CURRENT_SEASON = 2026;
export declare const HISTORICAL_SEASON_ERROR = "Audio recaps are only available for the current season.";
export declare function generateHostAudio(text: string, voiceId: string): Promise<import("stream").Readable>;
export declare function podcastHost(host: string): 'DAN' | 'STU' | null;
export declare function podcastVoiceIds(): {
    DAN: string;
    STU: string;
};
export declare function stitchPodcastMp3(segments: Buffer[]): Buffer;
export default function handler(req: Request, res: Response): Promise<void>;
export {};

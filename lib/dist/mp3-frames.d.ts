export type Mp3Frames = {
    audio: Buffer;
    frames: number;
    duration: number;
    mono: boolean;
};
export declare function readMp3Frames(input: Buffer): Mp3Frames;

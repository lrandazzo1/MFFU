/**
 * Minimal ambient declarations for the article pipeline.
 *
 * The repository ships no `@types/node` and no runtime framework: `scripts/`
 * and `lib/` are deliberately dependency-free so `npm ci` stays small and the
 * Vercel build (which has no build command at all) never needs a toolchain.
 * These two modules are the only TypeScript in the tree, so rather than pull a
 * types package in for them, the handful of host globals they touch are
 * declared here.
 *
 * Nothing in here is a runtime shim. It describes what Node already provides.
 */

declare const console: {
  error(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  log(...args: unknown[]): void;
};

declare const process: {
  env: Record<string, string | undefined>;
  argv: string[];
};

/** CommonJS interop: the repo's other `lib/` modules and `api/` routes are CJS. */
declare function require(id: string): any;
declare const module: { exports: any };

/** Node 18+ ships these globally; the repo targets `node >= 18`. */
declare function fetch(input: any, init?: any): Promise<any>;
declare const AbortSignal: { timeout(ms: number): any };

/** Used by the cron route's constant-time secret comparison. */
declare const Buffer: {
  from(input: string, encoding: string): { length: number };
};

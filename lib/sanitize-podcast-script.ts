/** Spoken replacements can be extended per deployment without changing the
 * archived script. Keys are matched as whole phrases, longest first. */
const DEFAULT_PRONUNCIATIONS: Record<string, string> = {
  'FSN': 'F S N',
  'NFL': 'N F L',
  'D/ST': 'defense and special teams',
  'A.J. Brown': 'A J Brown',
};

export function sanitizePodcastScript(text: string, overrides: Record<string, string> = {}): string {
  let spoken = String(text || '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\[(?:SFX|MUSIC|PAUSE|INTRO|OUTRO)[^\]]*\]/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(?:amp|#38);/gi, ' and ')
    .replace(/&(?:lt|gt|quot|apos);/gi, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/(?:^|\s)#{1,6}\s/g, ' ')
    .replace(/[*_`~]/g, '')
    .replace(/[\p{Extended_Pictographic}\u200d\ufe0f]/gu, '')
    .replace(/&/g, ' and ')
    .replace(/%/g, ' percent ');

  const dictionary = { ...DEFAULT_PRONUNCIATIONS, ...overrides };
  for (const key of Object.keys(dictionary).sort((a, b) => b.length - a.length)) {
    if (!key.trim() || !dictionary[key]?.trim()) continue;
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    spoken = spoken.replace(new RegExp('(?<![\\p{L}\\p{N}])' + escaped + '(?![\\p{L}\\p{N}])', 'giu'), () => dictionary[key]);
  }
  return spoken.replace(/[^\p{L}\p{N}\p{M}\s.,!?;:'’\-]/gu, ' ').replace(/\s+/g, ' ').trim();
}

export function podcastPronunciations(): Record<string, string> {
  const raw = process.env.PODCAST_PRONUNCIATIONS;
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('expected an object');
    const entries = Object.entries(parsed).filter(([key, value]) =>
      key.length <= 80 && typeof value === 'string' && value.length <= 120);
    if (entries.length > 100) throw new Error('too many overrides');
    return Object.fromEntries(entries);
  } catch (err) {
    console.error('[Podcast] Invalid PODCAST_PRONUNCIATIONS JSON', err);
    throw new Error('Invalid podcast pronunciation configuration');
  }
}

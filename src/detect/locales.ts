const normalize = (locale: string): string => locale.toLowerCase().replaceAll('_', '-');
const LANGUAGE: RegExp = /^[a-z]{2,3}$/i;
const language = (code: string): string => normalize(code).split('-')[0] ?? '';

/**
 * Disk locales that differ from a Translify locale only by case or separator (`en_US` → `en-US`),
 * then bare languages with exactly one regional match (`en` → `en-US`, but not with `en-GB` too).
 */
export function suggestLocaleMap(diskLocales: string[], translifyLocales: string[]): Record<string, string> {
  const known: Set<string> = new Set(translifyLocales);
  const disk: Set<string> = new Set(diskLocales);
  const map: Record<string, string> = {};
  const targets: Set<string> = new Set();
  // A bijection that cannot chain: loadConfig rejects anything else.
  const take = (locale: string, target: string | undefined): void => {
    if (target === undefined || targets.has(target) || disk.has(target)) return;
    map[locale] = target;
    targets.add(target);
  };

  for (const locale of diskLocales) {
    if (known.has(locale)) continue;
    take(locale, translifyLocales.find((code) => normalize(code) === normalize(locale)));
  }
  for (const locale of diskLocales) {
    if (known.has(locale) || map[locale] !== undefined || !LANGUAGE.test(locale)) continue;
    const regional: string[] = translifyLocales.filter((code) => code.includes('-') && language(code) === locale.toLowerCase());
    if (regional.length === 1) take(locale, regional[0]);
  }

  return map;
}

const normalize = (locale: string): string => locale.toLowerCase().replaceAll('_', '-');

/** Disk locales that differ from a Translify locale only by case or separator (`en_US` → `en-US`). */
export function suggestLocaleMap(diskLocales: string[], translifyLocales: string[]): Record<string, string> {
  const known: Set<string> = new Set(translifyLocales);
  const disk: Set<string> = new Set(diskLocales);
  const map: Record<string, string> = {};
  const targets: Set<string> = new Set();

  for (const locale of diskLocales) {
    if (known.has(locale)) continue;
    const target: string | undefined = translifyLocales.find((code) => normalize(code) === normalize(locale));
    // A bijection that cannot chain: loadConfig rejects anything else.
    if (target === undefined || targets.has(target) || disk.has(target)) continue;
    map[locale] = target;
    targets.add(target);
  }

  return map;
}

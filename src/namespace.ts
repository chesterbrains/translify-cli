import type { Config } from './config.js';

/** The flag; else the one namespace translify.json names (every rule has a fixed `namespace`, all equal); else undefined. */
export const configNamespace = (config: Config, flag?: string): string | undefined => {
  if (flag !== undefined) return flag;
  const names: Set<string | undefined> = new Set(config.files.map((rule) => rule.namespace));
  const [only] = names;

  return names.size === 1 ? only : undefined;
};

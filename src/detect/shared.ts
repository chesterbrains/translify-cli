import type { FileRule } from '../config.js';

export interface Detection {
  rules: FileRule[];
  /** Printed after "Found:", one line each; advice, never an error. */
  notes: string[];
}

export type Detector = (cwd: string) => Promise<Detection>;

export const NONE: Detection = { rules: [], notes: [] };

/** `MyApp_Web` → `myapp-web`; an empty result is the caller's problem (it picks a fallback). */
export const kebab = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/** Patterns are written with `/`; a Windows-edited path still becomes one. */
export const posixPath = (value: string): string => value.replaceAll('\\', '/').replace(/^(\.\/)+/, '');

/** 2 → `second`, 3 → `third`, then `4th`, `5th`… */
export const ordinal = (n: number): string => (n === 2 ? 'second' : n === 3 ? 'third' : `${n}th`);

/** Build output and vendored dependencies: their localisations are not the project's own. */
export const IGNORE: string[] = [
  '**/.build/**',
  '**/Pods/**',
  '**/Carthage/**',
  '**/node_modules/**',
  '**/DerivedData/**',
  '**/.git/**',
  '**/*.xcloc/**',
  '**/*.framework/**',
  '**/*.xcframework/**',
  '**/*.bundle/**',
];

/** ISO 639 two or three letters, then any BCP 47 subtags (script, region, variant); `isConfirmed` rejects false positives. */
export const LOCALE_TOKEN: RegExp = /^[a-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/;
/**
 * Whether Intl knows the two-letter language subtag of `code` (`de`, `pt-BR`); three letters are too permissive (`bar` is
 * Bavarian). A Node without Intl language data (small-icu) cannot tell, so any two-letter language is believed there.
 */
export const isKnownLanguage = (code: string): boolean => {
  const language: string = code.split(/[-_]/)[0] as string;
  if (language.length !== 2) return false;
  try {
    const names: Intl.DisplayNames = new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' });

    // `en` always has a name when the data is there; none means the data is missing, not that `language` is unknown.
    return names.of('en') === undefined || names.of(language) !== undefined;
  } catch {
    return true;
  }
};

import { readdir } from 'node:fs/promises';
import { join, posix } from 'node:path';
import fg from 'fast-glob';

import type { FileRule } from '../config.js';
import { kebab, NONE, ordinal, type Detection } from './shared.js';

const IGNORE: string[] = ['**/.build/**', '**/Pods/**', '**/node_modules/**', '**/DerivedData/**', '**/.git/**', '**/*.xcloc/**'];
/** `LOCALE` from config.ts, with `_` allowed: that is how the locales map is used. */
const LOCALE_FILE: RegExp = /^[A-Za-z]{2,3}([_-][A-Za-z0-9]{2,8})*$/;

const glob = async (cwd: string, pattern: string): Promise<string[]> =>
  (await fg(pattern, { cwd, onlyFiles: true, dot: false, ignore: IGNORE })).sort();

/** The one directory holding every `.xliff`, when each is named after a locale; else undefined. */
const existingDir = async (cwd: string): Promise<string | undefined> => {
  const xliffs: string[] = await glob(cwd, '**/*.xliff');
  if (xliffs.length === 0) return undefined;
  const dirs: Set<string> = new Set(xliffs.map((path) => posix.dirname(path)));
  if (dirs.size !== 1 || !xliffs.every((path) => LOCALE_FILE.test(posix.basename(path, '.xliff')))) return undefined;

  return [...dirs][0];
};

/** `localizable`, then `localizable-2` for a second catalog with the same basename. */
const namespaces = (catalogs: string[], notes: string[]): string[] => {
  const counts: Map<string, number> = new Map();
  const bases: Map<string, string> = new Map();

  return catalogs.map((catalog) => {
    const base: string = kebab(posix.basename(catalog, '.xcstrings')) || 'strings';
    const count: number = (counts.get(base) ?? 0) + 1;
    counts.set(base, count);
    if (count === 1) {
      bases.set(base, posix.basename(catalog));

      return base;
    }
    const namespace: string = `${base}-${count}`;
    notes.push(`Two catalogs are named ${bases.get(base) ?? catalog}: the ${ordinal(count)} one is namespace ${namespace}.`);

    return namespace;
  });
};

const PROJECT_MARKER: RegExp = /\.(xcodeproj|xcworkspace)$|^Package\.swift$/;

/**
 * The directory Xcode resolves `<file original>` against: the nearest ancestor of the catalog (at or
 * below `cwd`) holding an `.xcodeproj`, `.xcworkspace` or `Package.swift`; `.` when there is none.
 */
const projectRoot = async (cwd: string, catalog: string): Promise<string> => {
  for (let dir: string = posix.dirname(catalog); ; dir = posix.dirname(dir)) {
    let entries: string[];
    try {
      entries = await readdir(join(cwd, dir));
    } catch {
      entries = [];
    }
    if (entries.some((entry) => PROJECT_MARKER.test(entry))) return dir;
    if (dir === '.') return dir;
  }
};

const rule = (pattern: string, namespace: string, original: string): FileRule => ({
  pattern,
  format: 'xliff',
  namespace,
  xliffDialect: 'xcode',
  xliffOriginal: original,
});

/** Every `*.xcstrings` is a String Catalog; the XLIFF files Xcode imports live next to it, or will. */
export async function detectXcode(cwd: string): Promise<Detection> {
  const catalogs: string[] = await glob(cwd, '**/*.xcstrings');
  const only: string | undefined = catalogs[0];
  if (only === undefined) return NONE;

  const notes: string[] = [];
  const names: string[] = namespaces(catalogs, notes);
  const originals: string[] = [];
  const roots: Set<string> = new Set();
  for (const catalog of catalogs) {
    const root: string = await projectRoot(cwd, catalog);
    originals.push(root === '.' ? catalog : posix.relative(root, catalog));
    if (root !== '.') roots.add(root);
  }
  for (const root of roots) notes.push(`Xcode project in ${root}/: xliffOriginal is relative to it, as Xcode expects.`);

  if (catalogs.length === 1) {
    const dir: string | undefined = await existingDir(cwd);
    const pattern: string = dir === undefined ? 'Localization/{locale}.xliff' : dir === '.' ? '{locale}.xliff' : `${dir}/{locale}.xliff`;
    if (dir === undefined) {
      notes.push('No XLIFF files yet: `translify pull` creates Localization/<locale>.xliff; `xcodebuild -importLocalizations` reads them.');
    }

    return { rules: [rule(pattern, names[0] ?? 'strings', originals[0] ?? only)], notes };
  }

  return {
    rules: catalogs.map((catalog, index) =>
      rule(`Localization/${names[index] ?? 'strings'}/{locale}.xliff`, names[index] ?? 'strings', originals[index] ?? catalog),
    ),
    notes: ['Several String Catalogs: each gets its own folder under Localization/, created by `translify pull`.', ...notes],
  };
}

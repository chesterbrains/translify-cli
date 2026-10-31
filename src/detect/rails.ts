import { readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import fg from 'fast-glob';

import type { FileRule } from '../config.js';
import { compile } from '../patterns.js';
import { kebab, type Detection } from './shared.js';

const LOCALES_DIR: string = 'config/locales';
const IGNORE: string[] = ['**/vendor/**', '**/node_modules/**', '**/tmp/**'];
/** ISO 639 two or three letters, then optional script (4 letters), region (2 letters or 3 digits). */
const LOCALE_TOKEN: RegExp = /^[a-z]{2,3}(?:[-_](?:[A-Za-z]{4}|[A-Za-z]{2}|\d{3}))*$/;
/** Whether Intl knows the two-letter language subtag of `code` (`de`, `pt-BR`); three letters are too permissive (`bar` is Bavarian). */
const isKnownLanguage = (code: string): boolean => {
  const language: string = code.split(/[-_]/)[0] as string;
  if (language.length !== 2) return false;
  try {
    return new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' }).of(language) !== undefined;
  } catch {
    return false;
  }
};

/** Rails' own default: believed even when it is the only locale file of its shape. */
const DEFAULT_LOCALE: string = 'en';
const ROOT_KEY: RegExp = /^(?:"([^"]+)"|'([^']+)'|([^\s:#'"-][^\s:#]*)):(?:\s|$)/;
/** An app root sits at most two folders below the repo root (`apps/web`, `backend`). */
const APP_DEPTH: number = 2;
const APP_PREFIX: RegExp = new RegExp(`^((?:[^/]+/){0,${APP_DEPTH}}?)${LOCALES_DIR}/`);

/** Top-level keys of a YAML file, read line by line (no parser): comment, blank, directive, `---` and indented lines are not roots. */
const rootKeys = (text: string): string[] => {
  const keys: string[] = [];
  for (const line of text.replace(/^\u{FEFF}/u, '').split(/\r?\n/)) {
    if (
      line === '' ||
      /^\s/.test(line) ||
      line.startsWith('#') ||
      line.startsWith('%') ||
      line.startsWith('---') ||
      line.startsWith('...')
    ) {
      continue;
    }
    const match: RegExpExecArray | null = ROOT_KEY.exec(line);
    keys.push(match === null ? '' : (match[1] ?? match[2] ?? match[3] ?? ''));
  }

  return keys;
};

/** Path segments under `<base>`: the directories, and the file name split on `.` without its extension. */
const partsOf = (base: string, path: string): { dirs: string[]; stem: string[]; ext: string } => {
  const dirs: string[] = posix.relative(base, path).split('/');
  const file: string = dirs.pop() as string;
  const ext: string = posix.extname(file);

  return { dirs, stem: posix.basename(file, ext).split('.'), ext };
};

/**
 * A file whose locale is both a directory and part of its name (`en/en.yml`, `en/devise.en.yml`): a pattern holds
 * `{locale}` once, so `{locale}/en.yml` would read every locale's folder as the `en` file of one namespace.
 */
const isLocaleTwice = (base: string, path: string, locale: string): boolean => {
  const { dirs, stem } = partsOf(base, path);

  return dirs.includes(locale) && stem.includes(locale);
};

/**
 * Puts `{locale}` where `locale` sits in the path under `<base>`, the last occurrence winning; undefined when
 * the locale appears nowhere, or both in a directory and in the file name (`isLocaleTwice`).
 */
const shapeOf = (base: string, path: string, locale: string): string | undefined => {
  if (isLocaleTwice(base, path, locale)) return undefined;
  const { dirs, stem, ext } = partsOf(base, path);
  const dirAt: number = dirs.lastIndexOf(locale);
  if (dirAt !== -1) {
    dirs[dirAt] = '{locale}';

    return posix.join(base, ...dirs, `${stem.join('.')}${ext}`);
  }
  const at: number = stem.lastIndexOf(locale);
  if (at === -1) return undefined;
  stem[at] = '{locale}';

  return posix.join(base, ...dirs, `${stem.join('.')}${ext}`);
};

/**
 * Namespace candidates for a shape, best first: the file's own name (`user` for `models/user.{locale}.yml`), then the
 * last directory with it (`models-user`); a shape named only by directories takes the last one, a bare one `app`.
 */
const namespaceCandidates = (base: string, shape: string): string[] => {
  const { dirs, stem } = partsOf(base, shape);
  const named: string = kebab(stem.filter((part) => part !== '{locale}').join('-'));
  const folder: string = kebab(dirs.filter((part) => part !== '{locale}').slice(-1).join('-'));
  const candidates: string[] = (named === '' ? [folder] : folder === '' ? [named] : [named, `${folder}-${named}`]).filter(
    (candidate) => candidate !== '',
  );

  return candidates.length === 0 ? ['app'] : candidates;
};

/** Rails `config/locales/**` files with one `<locale>:` root matching their name become `yaml` / `rails` rules. */
export async function detectRails(cwd: string): Promise<Detection> {
  const prefixes: string = `{,${Array.from({ length: APP_DEPTH }, (_, n) => '*/'.repeat(n + 1)).join(',')}}`;
  const all: string[] = await fg(`${prefixes}${LOCALES_DIR}/**/*.{yml,yaml}`, { cwd, onlyFiles: true, ignore: IGNORE });
  const apps: Map<string, string[]> = new Map();
  for (const path of all) {
    const prefix: string | undefined = APP_PREFIX.exec(path)?.[1];
    if (prefix !== undefined) apps.set(prefix, [...(apps.get(prefix) ?? []), path]);
  }

  const shapes: Map<string, { base: string; locales: Set<string> }> = new Map();
  const skipped: string[] = [];
  const named: string[] = [];
  const unconfirmedFiles: Map<string, string[]> = new Map();
  for (const prefix of [...apps.keys()].sort()) {
    const [hasGemfile, hasApplication]: [string[], string[]] = await Promise.all([
      fg(`${prefix}Gemfile`, { cwd, onlyFiles: true }),
      fg(`${prefix}config/application.rb`, { cwd, onlyFiles: true }),
    ]);
    if (hasGemfile.length === 0 && hasApplication.length === 0) continue;

    const base: string = `${prefix}${LOCALES_DIR}`;
    for (const path of [...(apps.get(prefix) as string[])].sort()) {
      const keys: string[] = rootKeys(await readFile(join(cwd, path), 'utf8').catch(() => ''));
      const locale: string | undefined = keys.length === 1 ? keys[0] : undefined;
      const isLocale: boolean = locale !== undefined && LOCALE_TOKEN.test(locale);
      const shape: string | undefined = isLocale ? shapeOf(base, path, locale as string) : undefined;
      if (shape !== undefined) {
        const known = shapes.get(shape) ?? { base, locales: new Set<string>() };
        known.locales.add(locale as string);
        shapes.set(shape, known);
        unconfirmedFiles.set(shape, [...(unconfirmedFiles.get(shape) ?? []), path]);
      } else if (isLocale && isLocaleTwice(base, path, locale as string)) named.push(path);
      else skipped.push(path);
    }
  }

  // `foo.bar.yml` reads as locale `bar`; a shape is believed when two locales share it, or its one locale is a real two-letter language (`en`, `de`, `pt-BR`).
  const unconfirmed: string[] = [];
  for (const [shape, { locales }] of [...shapes]) {
    if (locales.size >= 2 || locales.has(DEFAULT_LOCALE) || [...locales].some(isKnownLanguage)) continue;
    unconfirmed.push(...(unconfirmedFiles.get(shape) as string[]));
    shapes.delete(shape);
  }

  const rules: FileRule[] = [];
  const taken: Set<string> = new Set();
  // Shallow shapes name first (`user.{locale}.yml` before `models/user.{locale}.yml`), then by pattern, so the result never depends on glob order.
  const depth = (pattern: string): number => partsOf((shapes.get(pattern) as { base: string }).base, pattern).dirs.length;
  for (const pattern of [...shapes.keys()].sort((a, b) => depth(a) - depth(b) || (a < b ? -1 : a > b ? 1 : 0))) {
    const candidates: string[] = namespaceCandidates((shapes.get(pattern) as { base: string }).base, pattern);
    let namespace: string | undefined = candidates.find((candidate) => !taken.has(candidate));
    if (namespace === undefined) {
      const base: string = candidates.at(-1) as string;
      namespace = base;
      for (let n = 2; taken.has(namespace); n++) namespace = `${base}-${n}`;
    }
    taken.add(namespace);
    rules.push({ pattern, format: 'yaml', yamlDialect: 'rails', namespace });
  }
  rules.sort((a, b) => (a.pattern < b.pattern ? -1 : a.pattern > b.pattern ? 1 : 0));
  const notes: string[] = [];
  if (skipped.length > 0) {
    notes.push(
      `Skipped Rails locale files that do not hold exactly one root key equal to the locale in their name: ${skipped.join(', ')}.`,
    );
  }
  if (unconfirmed.length > 0) {
    notes.push(
      `Skipped Rails files whose name part is not confirmed as a locale (a shape needs two locales or a two-letter language code): ${unconfirmed.join(', ')}.`,
    );
  }
  if (named.length > 0) {
    notes.push(
      `Skipped Rails locale files named after the locale inside a locale folder (a pattern holds {locale} once): ${named.join(', ')}. Rename them, e.g. en/en.yml to en/main.yml, and run init again.`,
    );
  }
  // `{locale}` matches any name, so a skipped file can still be read as a locale file by a proposed rule.
  for (const rule of rules) {
    const { regex } = compile(rule.pattern, false);
    const caught: string[] = [...skipped, ...unconfirmed, ...named].filter((path) => regex.test(path));
    if (caught.length > 0) {
      notes.push(
        `${rule.pattern} also matches ${caught.join(', ')}, and push will read them as locale files: rename or move them, or exclude them.`,
      );
    }
  }

  return { rules, notes };
}

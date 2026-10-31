import { readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import fg from 'fast-glob';

import type { FileRule } from '../config.js';
import { compile } from '../patterns.js';
import { kebab, NONE, type Detection } from './shared.js';

const LOCALES_DIR: string = 'config/locales';
const IGNORE: string[] = ['**/vendor/**', '**/node_modules/**', '**/tmp/**'];
const LOCALE_TOKEN: RegExp = /^[a-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/;
const ROOT_KEY: RegExp = /^(?:"([^"]+)"|'([^']+)'|([^\s:#'"-][^\s:#]*)):(?:\s|$)/;

/** Top-level keys of a YAML file, read line by line (no parser): comment, blank, `---` and indented lines are not roots. */
const rootKeys = (text: string): string[] => {
  const keys: string[] = [];
  for (const line of text.replace(/^\u{FEFF}/u, '').split(/\r?\n/)) {
    if (line === '' || /^\s/.test(line) || line.startsWith('#') || line.startsWith('---') || line.startsWith('...')) continue;
    const match: RegExpExecArray | null = ROOT_KEY.exec(line);
    keys.push(match === null ? '' : (match[1] ?? match[2] ?? match[3] ?? ''));
  }

  return keys;
};

/** Path segments under config/locales: the directories, and the file name split on `.` without its extension. */
const partsOf = (path: string): { dirs: string[]; stem: string[]; ext: string } => {
  const dirs: string[] = posix.relative(LOCALES_DIR, path).split('/');
  const file: string = dirs.pop() as string;
  const ext: string = posix.extname(file);

  return { dirs, stem: posix.basename(file, ext).split('.'), ext };
};

/**
 * A file whose locale is both a directory and part of its name (`en/en.yml`, `en/devise.en.yml`): a pattern holds
 * `{locale}` once, so `{locale}/en.yml` would read every locale's folder as the `en` file of one namespace.
 */
const isLocaleTwice = (path: string, locale: string): boolean => {
  const { dirs, stem } = partsOf(path);

  return dirs.includes(locale) && stem.includes(locale);
};

/**
 * Puts `{locale}` where `locale` sits in the path under config/locales, the last occurrence winning; undefined when
 * the locale appears nowhere, or both in a directory and in the file name (`isLocaleTwice`).
 */
const shapeOf = (path: string, locale: string): string | undefined => {
  if (isLocaleTwice(path, locale)) return undefined;
  const { dirs, stem, ext } = partsOf(path);
  const dirAt: number = dirs.lastIndexOf(locale);
  if (dirAt !== -1) {
    dirs[dirAt] = '{locale}';

    return posix.join(LOCALES_DIR, ...dirs, `${stem.join('.')}${ext}`);
  }
  const at: number = stem.lastIndexOf(locale);
  if (at === -1) return undefined;
  stem[at] = '{locale}';

  return posix.join(LOCALES_DIR, ...dirs, `${stem.join('.')}${ext}`);
};

const namespaceOf = (shape: string): string => {
  const relative: string = posix.relative(LOCALES_DIR, shape);
  const ext: string = posix.extname(relative);
  const parts: string[] = relative
    .slice(0, relative.length - ext.length)
    .split(/[/.]/)
    .filter((part) => part !== '{locale}');

  return kebab(parts.join('-')) || 'app';
};

/** Rails `config/locales/**` files with one `<locale>:` root matching their name become `yaml` / `rails` rules. */
export async function detectRails(cwd: string): Promise<Detection> {
  const [hasGemfile, hasApplication, paths]: [string[], string[], string[]] = await Promise.all([
    fg('Gemfile', { cwd, onlyFiles: true }),
    fg('config/application.rb', { cwd, onlyFiles: true }),
    fg(`${LOCALES_DIR}/**/*.{yml,yaml}`, {
      cwd,
      onlyFiles: true,
      ignore: IGNORE,
    }),
  ]);
  if ((hasGemfile.length === 0 && hasApplication.length === 0) || paths.length === 0) return NONE;

  const shapes: Set<string> = new Set();
  const skipped: string[] = [];
  const named: string[] = [];
  for (const path of [...paths].sort()) {
    const keys: string[] = rootKeys(await readFile(join(cwd, path), 'utf8').catch(() => ''));
    const locale: string | undefined = keys.length === 1 ? keys[0] : undefined;
    const isLocale: boolean = locale !== undefined && LOCALE_TOKEN.test(locale);
    const shape: string | undefined = isLocale ? shapeOf(path, locale as string) : undefined;
    if (shape !== undefined) shapes.add(shape);
    else if (isLocale && isLocaleTwice(path, locale as string)) named.push(path);
    else skipped.push(path);
  }

  const rules: FileRule[] = [];
  const taken: Set<string> = new Set();
  for (const pattern of [...shapes].sort()) {
    const base: string = namespaceOf(pattern);
    let namespace: string = base;
    for (let n = 2; taken.has(namespace); n++) namespace = `${base}-${n}`;
    taken.add(namespace);
    rules.push({ pattern, format: 'yaml', yamlDialect: 'rails', namespace });
  }
  const notes: string[] = [];
  if (skipped.length > 0) {
    notes.push(
      `Skipped Rails locale files that do not hold exactly one root key equal to the locale in their name: ${skipped.join(', ')}.`,
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
    const caught: string[] = [...skipped, ...named].filter((path) => regex.test(path));
    if (caught.length > 0) {
      notes.push(
        `${rule.pattern} also matches ${caught.join(', ')}, and push will read them as locale files: rename or move them, or exclude them.`,
      );
    }
  }

  return { rules, notes };
}

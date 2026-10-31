import { readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import fg from 'fast-glob';

import type { FileRule } from '../config.js';
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

/** Replaces the dot-separated segment of the file name equal to `locale`; undefined when none is. */
const shapeOf = (path: string, locale: string): string | undefined => {
  const ext: string = posix.extname(path);
  const segments: string[] = posix.basename(path, ext).split('.');
  const at: number = segments.lastIndexOf(locale);
  if (at === -1) return undefined;
  segments[at] = '{locale}';

  return posix.join(posix.dirname(path), `${segments.join('.')}${ext}`);
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
    fg(`${LOCALES_DIR}/**/*.{yml,yaml}`, { cwd, onlyFiles: true, dot: false, ignore: IGNORE }),
  ]);
  if ((hasGemfile.length === 0 && hasApplication.length === 0) || paths.length === 0) return NONE;

  const shapes: Set<string> = new Set();
  const skipped: string[] = [];
  for (const path of paths.sort()) {
    const keys: string[] = rootKeys(await readFile(join(cwd, path), 'utf8').catch(() => ''));
    const locale: string | undefined = keys.length === 1 ? keys[0] : undefined;
    const shape: string | undefined = locale !== undefined && LOCALE_TOKEN.test(locale) ? shapeOf(path, locale) : undefined;
    if (shape === undefined) skipped.push(path);
    else shapes.add(shape);
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
    notes.push(`Skipped Rails locale files that do not hold exactly one root key equal to the locale in their name: ${skipped.join(', ')}.`);
  }

  return { rules, notes };
}

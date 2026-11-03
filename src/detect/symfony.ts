import fg from 'fast-glob';
import { posix } from 'node:path';

import type { FileRule } from '../config.js';
import { globPrefix, isKnownLanguage, kebab, LOCALE_TOKEN, NONE, type Detection } from './shared.js';

const TRANSLATIONS_DIR: string = 'translations';
const IGNORE: string[] = ['**/vendor/**', '**/node_modules/**', '**/var/**'];
/** An app root sits at most two folders below the repo root, as for Rails. */
const APP_DEPTH: number = 2;
const APP_PREFIX: RegExp = new RegExp(`^((?:[^/]+/){0,${APP_DEPTH}}?)${TRANSLATIONS_DIR}/`);
const NAMESPACE: RegExp = /^[a-z0-9-]{1,64}$/;
/** `<domain>.<locale>.<ext>` or `<domain>+intl-icu.<locale>.<ext>`. */
const FILE_NAME: RegExp = /^([^.+]+)(\+intl-icu)?\.([^.]+)\.(yml|yaml)$/;

interface Entry {
  path: string;
  prefix: string;
  domain: string;
  isIcu: boolean;
  locale: string;
  ext: string;
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const parse = (path: string): Entry | undefined => {
  const match: RegExpExecArray | null = FILE_NAME.exec(posix.basename(path));
  const prefix: string | undefined = APP_PREFIX.exec(path)?.[1];
  if (match === null || prefix === undefined) return undefined;
  const locale: string = match[3] as string;
  if (!LOCALE_TOKEN.test(locale) || !isKnownLanguage(locale)) return undefined;

  return { path, prefix, domain: match[1] as string, isIcu: match[2] !== undefined, locale, ext: match[4] as string };
};

/** Symfony `translations/<domain>[+intl-icu].<locale>.yaml` files become `yaml` / `symfony` and `symfony-icu` rules. */
export async function detectSymfony(cwd: string): Promise<Detection> {
  const prefixes: string = `{,${Array.from({ length: APP_DEPTH }, (_, n) => '*/'.repeat(n + 1)).join(',')}}`;
  const all: string[] = await fg(`${prefixes}${TRANSLATIONS_DIR}/*.{yml,yaml}`, { cwd, onlyFiles: true, ignore: IGNORE });
  const entries: Entry[] = [];
  const apps: Map<string, boolean> = new Map();
  for (const path of all.sort(byText)) {
    const entry: Entry | undefined = parse(path);
    if (entry === undefined) continue;
    if (!apps.has(entry.prefix)) {
      const markers: string[][] = await Promise.all([
        fg(`${globPrefix(entry.prefix)}composer.json`, { cwd, onlyFiles: true }),
        fg(`${globPrefix(entry.prefix)}symfony.lock`, { cwd, onlyFiles: true }),
      ]);
      apps.set(entry.prefix, markers.some((found) => found.length > 0));
    }
    if (apps.get(entry.prefix) === true) entries.push(entry);
  }
  if (entries.length === 0) return NONE;

  const rules: FileRule[] = [];
  const notes: string[] = [];
  const groups: Map<string, Entry[]> = new Map();
  for (const entry of entries) {
    const key: string = `${entry.prefix}\0${entry.ext}`;
    const group: Entry[] | undefined = groups.get(key);
    if (group === undefined) groups.set(key, [entry]);
    else group.push(entry);
  }

  for (const key of [...groups.keys()].sort(byText)) {
    const group: Entry[] = groups.get(key) as Entry[];
    const { prefix, ext } = group[0] as Entry;
    const dir: string = `${prefix}${TRANSLATIONS_DIR}`;
    const legacy: Set<string> = new Set();
    const icu: Set<string> = new Set();
    const invalid: Set<string> = new Set();
    for (const entry of group) {
      if (!NAMESPACE.test(entry.domain)) {
        if (!invalid.has(entry.domain)) {
          invalid.add(entry.domain);
          const name: string = entry.isIcu ? `${entry.domain}+intl-icu` : entry.domain;
          const dialect: string = entry.isIcu ? 'symfony-icu' : 'symfony';
          notes.push(
            `${entry.path} is domain "${entry.domain}", which is not a valid namespace: add { "pattern": "${dir}/${name}.{locale}.${ext}", "format": "yaml", "yamlDialect": "${dialect}", "namespace": "${kebab(entry.domain.replace(/([a-z0-9])([A-Z])/g, '$1-$2'))}" } by hand.`,
          );
        }
        continue;
      }
      (entry.isIcu ? icu : legacy).add(entry.domain);
    }

    const both: string[] = [...legacy].filter((domain) => icu.has(domain)).sort(byText);
    for (const domain of both) {
      const of = (isIcu: boolean): string[] =>
        group.filter((entry) => entry.domain === domain && entry.isIcu === isIcu).map((entry) => entry.locale).sort(byText);
      const legacyLocales: string[] = of(false);
      const icuLocales: string[] = of(true);
      const shared: string | undefined = legacyLocales.find((locale) => icuLocales.includes(locale));
      const l: string = shared ?? (legacyLocales[0] as string);
      const i: string = shared ?? (icuLocales[0] as string);
      notes.push(
        `Domain ${domain} has both ${domain}.${l}.${ext} and ${domain}+intl-icu.${i}.${ext}; Translify keeps one style per domain: move the legacy messages into the ICU file or change the rule.`,
      );
    }
    if ([...legacy].some((domain) => !icu.has(domain))) {
      rules.push({ pattern: `${dir}/{namespace}.{locale}.${ext}`, format: 'yaml', yamlDialect: 'symfony', jsonStyle: 'flat' });
    }
    if (icu.size > 0) {
      rules.push({ pattern: `${dir}/{namespace}+intl-icu.{locale}.${ext}`, format: 'yaml', yamlDialect: 'symfony-icu' });
    }
  }

  return { rules, notes };
}

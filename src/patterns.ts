import fg from 'fast-glob';

import { CliError, EXIT } from './errors.js';
import type { Config, FileRule } from './config.js';

/** What the server knows and the files do not: the project's default locale (Android's `values/`). */
export interface PathContext {
  defaultLocale?: string;
}

export interface Match {
  path: string;
  locale: string;
  namespace: string;
  rule: FileRule;
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Patterns are written with `/`; tolerate `\` so a Windows-edited config still matches. */
const posix = (value: string): string => value.replaceAll('\\', '/');

const ANDROID_MISSING_DEFAULT: string = 'Android rules need the project default locale; log in or check the key';

/** `pt-BR` → `pt-rBR`; a script, a 3-letter language or a variant → `b+pt+Latn`. Plain `xx` stays. */
export const toAndroidQualifier = (code: string): string => {
  const subtags: string[] = code.split('-');
  if (subtags.length === 1 && /^[A-Za-z]{2}$/.test(code)) return code;
  if (subtags.length === 2 && /^[A-Za-z]{2}$/.test(subtags[0]!) && /^[A-Za-z]{2}$/.test(subtags[1]!)) return `${subtags[0]}-r${subtags[1]}`;

  return `b+${subtags.join('+')}`;
};

export const fromAndroidQualifier = (qualifier: string): string =>
  qualifier.startsWith('b+') ? qualifier.slice(2).split('+').join('-') : qualifier.replace(/^([A-Za-z]{2})-r([A-Za-z]{2})$/, '$1-$2');

/** A locale qualifier, not `night`, `land`, `v21` or `sw600dp`: 2 letters with an optional region, or BCP 47 `b+…`. */
const ANDROID_LOCALE: string = '(?<locale>[a-z]{2}(?:-r[A-Z]{2})?|b\\+[A-Za-z0-9+]+)';

/**
 * `locales/{locale}/{namespace}.json` → a glob and a regex with named groups. An Android rule's `-{locale}`
 * is optional (the default locale lives in plain `values/`) and its locale is a resource qualifier.
 */
const compile = (pattern: string, android: boolean): { glob: string; regex: RegExp } => {
  const parts: string[] = posix(pattern).split(/(\{locale\}|\{namespace\})/);
  // `values-{locale}`: the dash belongs to the optional group, so it leaves the literal text.
  const optional = (index: number): boolean => android && parts[index + 1] === '{locale}' && parts[index]!.endsWith('-');
  const glob: string = parts
    .map((part, index) => (part === '{locale}' || part === '{namespace}' ? '*' : optional(index) ? part.slice(0, -1) : part))
    .join('');
  const regex: RegExp = new RegExp(
    `^${parts
      .map((part, index) => {
        if (part === '{namespace}') return '(?<namespace>[a-z0-9-]{1,64})';
        if (part === '{locale}') {
          if (!android) return '(?<locale>[A-Za-z0-9_-]+)';

          return parts[index - 1]?.endsWith('-') ? `(?:-${ANDROID_LOCALE})?` : ANDROID_LOCALE;
        }

        return escape(optional(index) ? part.slice(0, -1) : part);
      })
      .join('')}$`,
  );

  return { glob, regex };
};

/** Unmapped locales pass through; the server rejects an unknown one rather than creating it. */
export const toTranslifyLocale = (fsLocale: string, config: Config): string => config.locales[fsLocale] ?? fsLocale;

export const toFsLocale = (code: string, config: Config): string =>
  Object.entries(config.locales).find(([, mapped]) => mapped === code)?.[0] ?? code;

export async function findFiles(config: Config, cwd: string, context: PathContext = {}): Promise<Match[]> {
  const matches: Match[] = [];
  /** Android: the qualifier each path carried, '' for plain `values/`. */
  const qualifiers: Map<string, string> = new Map();

  for (const rule of config.files) {
    const android: boolean = rule.format === 'android';
    if (android && context.defaultLocale === undefined) throw new CliError(EXIT.failed, ANDROID_MISSING_DEFAULT);
    const { glob, regex } = compile(rule.pattern, android);
    const paths: string[] = await fg(glob, { cwd, onlyFiles: true, dot: false });

    for (const path of paths.map(posix).sort()) {
      const groups = regex.exec(path)?.groups;
      if (groups === undefined || (groups.locale === undefined && !android)) continue;
      const namespace: string | undefined = groups.namespace ?? rule.namespace;
      if (namespace === undefined) continue;
      const locale: string =
        groups.locale === undefined
          ? (context.defaultLocale as string)
          : toTranslifyLocale(android ? fromAndroidQualifier(groups.locale) : groups.locale, config);

      if (android) qualifiers.set(path, groups.locale ?? '');
      matches.push({ path, locale, namespace, rule });
    }
  }

  // One file per (locale, namespace) cell, one rule per file; otherwise push sends a cell twice and pull skips one.
  const byPath = new Map<string, Match>();
  const byCell = new Map<string, Match>();
  for (const match of matches) {
    const samePath: Match | undefined = byPath.get(match.path);
    if (samePath !== undefined) {
      throw new CliError(EXIT.failed, `${match.path} is matched by more than one files rule.`);
    }
    const cell = `${match.locale}\u0000${match.namespace}`;
    const sameCell: Match | undefined = byCell.get(cell);
    if (sameCell !== undefined) {
      const mine: string | undefined = qualifiers.get(match.path);
      const theirs: string | undefined = qualifiers.get(sameCell.path);
      if (mine !== undefined && theirs !== undefined && (mine === '') !== (theirs === '')) {
        const [plain, named]: [Match, Match] = mine === '' ? [match, sameCell] : [sameCell, match];
        throw new CliError(
          EXIT.failed,
          `${plain.path} and ${named.path} both hold the default locale ${match.locale}: Android reads values/ as the default, so remove values-${qualifiers.get(named.path)}/ or change the project default locale`,
        );
      }
      throw new CliError(
        EXIT.failed,
        `${sameCell.path} and ${match.path} both map to locale ${match.locale}, namespace ${match.namespace}. Fix the "locales" map or remove one file.`,
      );
    }
    byPath.set(match.path, match);
    byCell.set(cell, match);
  }

  return matches;
}

export function pathFor(rule: FileRule, translifyLocale: string, namespace: string, config: Config, context: PathContext = {}): string {
  const pattern: string = posix(rule.pattern).replaceAll('{namespace}', namespace);
  if (rule.format !== 'android') return pattern.replaceAll('{locale}', toFsLocale(translifyLocale, config));
  if (context.defaultLocale === undefined) throw new CliError(EXIT.failed, ANDROID_MISSING_DEFAULT);

  return translifyLocale === context.defaultLocale
    ? pattern.replace(/-?\{locale\}/, '')
    : pattern.replaceAll('{locale}', toAndroidQualifier(toFsLocale(translifyLocale, config)));
}

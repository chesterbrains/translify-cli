import fg from 'fast-glob';

import { CliError, EXIT } from './errors.js';
import type { Config, FileRule } from './config.js';

export interface Match {
  path: string;
  locale: string;
  namespace: string;
  rule: FileRule;
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Patterns are written with `/`; tolerate `\` so a Windows-edited config still matches. */
const posix = (value: string): string => value.replaceAll('\\', '/');

/** `locales/{locale}/{namespace}.json` → a glob and a regex with named groups. */
const compile = (pattern: string): { glob: string; regex: RegExp } => {
  const parts: string[] = posix(pattern).split(/(\{locale\}|\{namespace\})/);
  const glob: string = parts.map((part) => (part === '{locale}' || part === '{namespace}' ? '*' : part)).join('');
  const regex: RegExp = new RegExp(
    `^${parts
      .map((part) =>
        part === '{locale}'
          ? '(?<locale>[A-Za-z0-9_-]+)'
          : part === '{namespace}'
            ? '(?<namespace>[a-z0-9-]{1,64})'
            : escape(part),
      )
      .join('')}$`,
  );

  return { glob, regex };
};

/** Unmapped locales pass through; the server rejects an unknown one rather than creating it. */
export const toTranslifyLocale = (fsLocale: string, config: Config): string => config.locales[fsLocale] ?? fsLocale;

export const toFsLocale = (code: string, config: Config): string =>
  Object.entries(config.locales).find(([, mapped]) => mapped === code)?.[0] ?? code;

export async function findFiles(config: Config, cwd: string): Promise<Match[]> {
  const matches: Match[] = [];

  for (const rule of config.files) {
    const { glob, regex } = compile(rule.pattern);
    const paths: string[] = await fg(glob, { cwd, onlyFiles: true, dot: false });

    for (const path of paths.map(posix).sort()) {
      const groups = regex.exec(path)?.groups;
      if (groups?.locale === undefined) continue;
      const namespace: string | undefined = groups.namespace ?? rule.namespace;
      if (namespace === undefined) continue;

      matches.push({ path, locale: toTranslifyLocale(groups.locale, config), namespace, rule });
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

export function pathFor(rule: FileRule, translifyLocale: string, namespace: string, config: Config): string {
  return posix(rule.pattern)
    .replaceAll('{locale}', toFsLocale(translifyLocale, config))
    .replaceAll('{namespace}', namespace);
}

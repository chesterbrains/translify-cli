import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { FileRule } from '../config.js';
import { kebab, NONE, posixPath, type Detection } from './shared.js';

const DEFAULT_PATTERN: string = 'src/locale/messages.{locale}.xlf';

type Translation = string | string[] | { translation?: string | string[] };
interface AngularI18n {
  sourceLocale?: string | { code?: string };
  locales?: Record<string, Translation>;
}
interface AngularProject {
  i18n?: AngularI18n;
}
interface AngularJson {
  projects?: Record<string, AngularProject>;
}

const firstPath = (value: Translation): string | undefined => {
  const raw: unknown = typeof value === 'string' || Array.isArray(value) ? value : value.translation;
  const first: unknown = Array.isArray(raw) ? raw[0] : raw;

  return typeof first === 'string' ? first : undefined;
};

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The last occurrence of `code` bounded by non-alphanumerics, so `es` in `resources/` is not it. */
const toPattern = (path: string, code: string): string | undefined => {
  const bounded: RegExp = new RegExp(`(?<![A-Za-z0-9])${escape(code)}(?![A-Za-z0-9])`, 'g');
  const matches: RegExpExecArray[] = [...path.matchAll(bounded)];
  const last: RegExpExecArray | undefined = matches.at(-1);
  if (last === undefined) return undefined;

  return `${path.slice(0, last.index)}{locale}${path.slice(last.index + code.length)}`;
};

const rule = (pattern: string, namespace: string): FileRule => ({ pattern, format: 'xliff', namespace, xliffDialect: 'angular' });

/** `angular.json` with an `i18n` block per project; the translation paths give the pattern. */
export async function detectAngular(cwd: string): Promise<Detection> {
  let raw: string;
  try {
    raw = await readFile(join(cwd, 'angular.json'), 'utf8');
  } catch {
    return NONE;
  }
  let json: AngularJson;
  try {
    json = JSON.parse(raw) as AngularJson;
  } catch {
    return { rules: [], notes: ['angular.json is not valid JSON, skipped.'] };
  }
  const projects: [string, AngularProject][] = Object.entries(json.projects ?? {});
  const first: [string, AngularProject] | undefined = projects[0];
  if (first === undefined) return NONE;

  const rules: FileRule[] = [];
  const notes: string[] = [];
  const seen: Set<string> = new Set();
  let sourceLocale: string | undefined;
  for (const [name, project] of projects) {
    const i18n: AngularI18n | undefined = project.i18n;
    if (i18n === undefined) continue;
    const namespace: string = kebab(name) || 'app';
    const source: string | undefined = typeof i18n.sourceLocale === 'string' ? i18n.sourceLocale : i18n.sourceLocale?.code;
    if (source !== undefined) {
      sourceLocale ??= source;
      notes.push(`Angular source locale for ${name}: ${source}.`);
    }
    for (const [code, value] of Object.entries(i18n.locales ?? {})) {
      const path: string | undefined = firstPath(value);
      if (path === undefined) continue;
      const clean: string = posixPath(path);
      const pattern: string | undefined = toPattern(clean, code);
      if (pattern === undefined) {
        notes.push(`${clean} does not contain its locale code ${code}; add that rule by hand.`);
        continue;
      }
      if (seen.has(pattern)) continue;
      seen.add(pattern);
      rules.push(rule(pattern, namespace));
    }
  }

  if (rules.length === 0) {
    rules.push(rule(DEFAULT_PATTERN, kebab(first[0]) || 'app'));
    notes.push('angular.json has no usable i18n locales: the rule assumes the default src/locale/messages.<locale>.xlf layout.');
  }
  notes.push(
    `\`ng extract-i18n\` writes messages.xlf with no locale in its name; run it with --format=xlf2 --out-file messages.${sourceLocale ?? '<sourceLocale>'}.xlf so the source file matches the rule.`,
  );

  return { rules, notes };
}

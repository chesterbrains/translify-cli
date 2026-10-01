import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import fg from 'fast-glob';

import type { Config, FileRule } from '../config.js';
import type { ExitCode } from '../errors.js';
import type { Match } from '../patterns.js';
import { CliError, EXIT } from '../errors.js';
import { findFiles } from '../patterns.js';

const SCHEMA_URL: string = 'https://unpkg.com/@chesterbrains/translify-cli/schema/translify.schema.json';
const I18NEXT_ROOTS: string[] = ['locales', 'public/locales', 'src/locales', 'src/i18n'];
const EXAMPLE_RULE: FileRule = { pattern: 'locales/{locale}/{namespace}.json', format: 'json', jsonStyle: 'nested' };

const unquote = (value: string): string =>
  value.replace(/^["']|["']$/g, '').replace(/^(\.\/)+/, '').replace(/\/+$/, '');

async function detectFlutter(cwd: string): Promise<FileRule[]> {
  let yaml: string | undefined;
  try {
    yaml = await readFile(join(cwd, 'l10n.yaml'), 'utf8');
  } catch {
    yaml = undefined;
  }

  if (yaml === undefined) {
    const arbs: string[] = await fg('lib/l10n/*.arb', { cwd, onlyFiles: true });

    return arbs.length > 0 ? [{ pattern: 'lib/l10n/app_{locale}.arb', format: 'arb', namespace: 'app' }] : [];
  }

  const dir: string = unquote(/^arb-dir:\s*(\S+)/m.exec(yaml)?.[1] ?? 'lib/l10n');
  const template: string = unquote(/^template-arb-file:\s*(\S+)/m.exec(yaml)?.[1] ?? 'app_en.arb');
  const prefix: string = /^(.*?)_[a-z]{2,3}(?:[_-](?:[A-Z]{2}|[0-9]{3}|[A-Z][a-z]{3}))*\.arb$/.exec(template)?.[1] ?? 'app';

  return [{ pattern: `${dir}/${prefix}_{locale}.arb`, format: 'arb', namespace: 'app' }];
}

/** Recognises i18next and Flutter layouts; an empty list means "unknown, write an example". */
export async function detectLayout(cwd: string): Promise<FileRule[]> {
  const rules: FileRule[] = [];

  for (const root of I18NEXT_ROOTS) {
    const found: string[] = await fg(`${root}/*/*.json`, { cwd, onlyFiles: true });
    if (found.length > 0) rules.push({ pattern: `${root}/{locale}/{namespace}.json`, format: 'json', jsonStyle: 'nested' });
  }

  return [...rules, ...(await detectFlutter(cwd))];
}

const normalize = (locale: string): string => locale.toLowerCase().replaceAll('_', '-');

/** Disk locales that differ from a Translify locale only by case or separator (`en_US` → `en-US`). */
export function suggestLocaleMap(diskLocales: string[], translifyLocales: string[]): Record<string, string> {
  const known: Set<string> = new Set(translifyLocales);
  const disk: Set<string> = new Set(diskLocales);
  const map: Record<string, string> = {};
  const targets: Set<string> = new Set();

  for (const locale of diskLocales) {
    if (known.has(locale)) continue;
    const target: string | undefined = translifyLocales.find((code) => normalize(code) === normalize(locale));
    // A bijection that cannot chain: loadConfig rejects anything else.
    if (target === undefined || targets.has(target) || disk.has(target)) continue;
    map[locale] = target;
    targets.add(target);
  }

  return map;
}

export interface WhoamiInfo {
  project: { name: string; slug: string; defaultLocale: string | null };
  locales: string[];
}

export interface InitDeps {
  cwd: string;
  isTty: boolean;
  out: (line: string) => void;
  apiUrlDefault: string;
  prompt: {
    input: (message: string, defaultValue: string) => Promise<string>;
    confirm: (message: string, defaultValue: boolean) => Promise<boolean>;
    /** Picks one option; the first is the default. */
    choose: (message: string, options: string[]) => Promise<string>;
  };
  /** Undefined when no key is available or the call fails: init then simply skips the locale hints. */
  fetchWhoami: (apiUrl: string) => Promise<WhoamiInfo | undefined>;
}

const isHttpUrl = (value: string): boolean => {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
};

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);

    return true;
  } catch {
    return false;
  }
}

export async function runInit(deps: InitDeps): Promise<ExitCode> {
  if (!deps.isTty) {
    deps.out('`translify init` needs an interactive terminal. Write translify.json by hand in CI.');

    return EXIT.failed;
  }

  const target: string = join(deps.cwd, 'translify.json');
  if ((await exists(target)) && !(await deps.prompt.confirm('translify.json already exists. Overwrite it?', false))) {
    deps.out('Left translify.json unchanged.');

    return EXIT.failed;
  }

  const detected: FileRule[] = await detectLayout(deps.cwd);
  if (detected.length === 0) {
    deps.out(`No i18next or Flutter layout found in ${deps.cwd} (detection looks only in the current directory). Wrote an example rule (${EXAMPLE_RULE.pattern}): edit files[] to match your project.`);
  } else {
    deps.out(`Found: ${detected.map((rule) => `${rule.pattern} (${rule.format})`).join(', ')}`);
  }
  let files: FileRule[] = detected.length > 0 ? detected : [EXAMPLE_RULE];
  if (detected.length > 1) {
    const chosen: string = await deps.prompt.choose('Several layouts found. Which one holds your translations?', detected.map((rule) => rule.pattern));
    files = detected.filter((rule) => rule.pattern === chosen);
    if (files.length === 0) files = [detected[0] as FileRule];
    deps.out(`Dropped: ${detected.filter((rule) => !files.includes(rule)).map((rule) => rule.pattern).join(', ')}`);
  }

  const apiUrl: string = (await deps.prompt.input('Translify API URL', deps.apiUrlDefault)).trim();
  if (!isHttpUrl(apiUrl)) {
    deps.out('The API URL must start with http:// or https://. Nothing was written.');

    return EXIT.failed;
  }

  // A config that cannot resolve its own files would fail on the first push or pull: refuse to write it.
  let matches: Match[];
  try {
    matches = await findFiles({ apiUrl, files, locales: {} }, deps.cwd);
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    deps.out(`${error.message} Nothing was written.`);

    return EXIT.failed;
  }

  let locales: Record<string, string> = {};
  const me: WhoamiInfo | undefined = await deps.fetchWhoami(apiUrl);
  if (me !== undefined) {
    deps.out(`Project: ${me.project.name}, default locale ${me.project.defaultLocale ?? 'none'}; locales: ${me.locales.join(', ')}`);
    locales = await suggestMap(deps, matches, me.locales);
  }

  const config: Config & { $schema: string } = { $schema: SCHEMA_URL, apiUrl, files, locales };
  // `locales` is omitted when empty; the schema defaults it.
  const body: Record<string, unknown> = { ...config };
  if (Object.keys(locales).length === 0) delete body.locales;
  await writeFile(target, `${JSON.stringify(body, null, 2)}\n`);
  deps.out('Wrote translify.json. The key is not stored there: run `translify login` or set TRANSLIFY_SECRET_KEY.');

  return EXIT.ok;
}

async function suggestMap(deps: InitDeps, matches: Match[], translifyLocales: string[]): Promise<Record<string, string>> {
  const diskLocales: string[] = [...new Set(matches.map((match) => match.locale))];

  const missing: string[] = diskLocales.filter((locale) => !translifyLocales.includes(locale));
  const map: Record<string, string> = suggestLocaleMap(diskLocales, translifyLocales);
  for (const locale of missing.filter((entry) => map[entry] === undefined)) {
    deps.out(`Locale ${locale} on disk is not enabled in the project; push will reject it.`);
  }
  if (Object.keys(map).length === 0) return {};

  const text: string = Object.entries(map).map(([from, to]) => `${from} → ${to}`).join(', ');

  return (await deps.prompt.confirm(`Map disk locales to Translify codes (${text})?`, true)) ? map : {};
}

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Config, FileRule } from '../config.js';
import type { ExitCode } from '../errors.js';
import type { Match } from '../patterns.js';
import { detectLayout, type Detection } from '../detect/index.js';
import { suggestLocaleMap } from '../detect/locales.js';
import { CliError, EXIT } from '../errors.js';
import { findFiles } from '../patterns.js';

const SCHEMA_URL: string = 'https://unpkg.com/@chesterbrains/translify-cli/schema/translify.schema.json';
const EXAMPLE_RULE: FileRule = { pattern: 'locales/{locale}/{namespace}.json', format: 'json', jsonStyle: 'nested' };

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

  const detection: Detection = await detectLayout(deps.cwd);
  const detected: FileRule[] = detection.rules;
  if (detected.length === 0) {
    deps.out(`No i18next, Flutter, Angular or Xcode layout found in ${deps.cwd} (detection looks only in the current directory). Wrote an example rule (${EXAMPLE_RULE.pattern}): edit files[] to match your project.`);
  } else {
    deps.out(`Found: ${detected.map((rule) => `${rule.pattern} (${rule.format})`).join(', ')}`);
  }
  for (const note of detection.notes) deps.out(note);
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

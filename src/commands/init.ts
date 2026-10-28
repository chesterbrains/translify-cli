import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Config, FileRule } from '../config.js';
import type { ExitCode } from '../errors.js';
import type { Match } from '../patterns.js';
import { assertSecret } from '../credentials.js';
import { detectLayout, type Detection } from '../detect/index.js';
import { suggestLocaleMap } from '../detect/locales.js';
import { CliError, EXIT } from '../errors.js';
import { findFiles } from '../patterns.js';

const SCHEMA_URL: string = 'https://unpkg.com/@chesterbrains/translify-cli/schema/translify.schema.json';
const EXAMPLE_RULE: FileRule = { pattern: 'locales/{locale}/{namespace}.json', format: 'json', jsonStyle: 'nested' };
const NO_KEY_LINE: string = 'Wrote translify.json. The key is not stored there: run `translify login` or set TRANSLIFY_SECRET_KEY.';

export interface WhoamiInfo {
  project: { name: string; slug: string; defaultLocale: string | null };
  key: { scopes: string[] };
  locales: string[];
}

export interface InitDeps {
  cwd: string;
  isTty: boolean;
  /** --yes: no prompts, detected defaults, never overwrites. */
  yes: boolean;
  /** --api-url: skips the prompt. */
  apiUrl?: string;
  apiUrlDefault: string;
  out: (line: string) => void;
  prompt: {
    input: (message: string, defaultValue: string) => Promise<string>;
    confirm: (message: string, defaultValue: boolean) => Promise<boolean>;
    /** Multi-select; every option starts checked. Resolves to the chosen options in the given order. */
    checkbox: (message: string, options: string[]) => Promise<string[]>;
    /** Masked; an empty string means skip. */
    secret: (message: string) => Promise<string>;
  };
  /** The key already on this machine, or undefined; throws CliError for a malformed one. */
  findKey: () => Promise<string | undefined>;
  /** Stores an accepted key; resolves to the file path. */
  saveKey: (key: string) => Promise<string>;
  /** Throws CliError (exit 2 on a rejected key, 4 on a network failure). */
  fetchWhoami: (apiUrl: string, key: string) => Promise<WhoamiInfo>;
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

const label = (rule: FileRule): string => (rule.xliffDialect === undefined ? rule.pattern : `${rule.pattern} (${rule.xliffDialect})`);

export async function runInit(deps: InitDeps): Promise<ExitCode> {
  if (!deps.isTty && !deps.yes) {
    deps.out('`translify init` needs an interactive terminal. Pass `--yes` to take the detected defaults, or write translify.json by hand.');

    return EXIT.failed;
  }

  const target: string = join(deps.cwd, 'translify.json');
  if (await exists(target)) {
    if (deps.yes) {
      deps.out('translify.json already exists. Delete it first.');

      return EXIT.failed;
    }
    if (!(await deps.prompt.confirm('translify.json already exists. Overwrite it?', false))) {
      deps.out('Left translify.json unchanged.');

      return EXIT.failed;
    }
  }

  const apiUrl: string = (
    deps.apiUrl ?? (deps.yes ? deps.apiUrlDefault : await deps.prompt.input('Translify API URL', deps.apiUrlDefault))
  ).trim();
  if (!isHttpUrl(apiUrl)) {
    deps.out('The API URL must start with http:// or https://. Nothing was written.');

    return EXIT.failed;
  }

  // A typed key that is rejected throws here (exit 2): nothing is written and nothing is saved.
  const me: WhoamiInfo | undefined = await identify(deps, apiUrl);
  if (me !== undefined) {
    deps.out(`Project: ${me.project.name}, default locale ${me.project.defaultLocale ?? 'none'}; locales: ${me.locales.join(', ')}`);
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
  if (detected.length > 1 && !deps.yes) {
    const chosen: Set<string> = new Set(await deps.prompt.checkbox('Which layouts hold your translations?', detected.map(label)));
    files = detected.filter((rule) => chosen.has(label(rule)));
    if (files.length === 0) {
      deps.out('Nothing selected. Nothing was written.');

      return EXIT.failed;
    }
    const dropped: FileRule[] = detected.filter((rule) => !files.includes(rule));
    if (dropped.length > 0) deps.out(`Dropped: ${dropped.map((rule) => rule.pattern).join(', ')}`);
  }

  // A config that cannot resolve its own files would fail on the first push or pull: refuse to write it.
  let matches: Match[];
  try {
    matches = await findFiles({ apiUrl, files, locales: {} }, deps.cwd, {
      // Without a key the default locale is unknown; init only checks that the pattern resolves.
      defaultLocale: me === undefined ? 'und' : (me.project.defaultLocale ?? undefined),
    });
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    deps.out(`${error.message} Nothing was written.`);

    return EXIT.failed;
  }

  const locales: Record<string, string> = me === undefined ? {} : await suggestMap(deps, matches, me.locales);

  const config: Config & { $schema: string } = { $schema: SCHEMA_URL, apiUrl, files, locales };
  // `locales` is omitted when empty; the schema defaults it.
  const body: Record<string, unknown> = { ...config };
  if (Object.keys(locales).length === 0) delete body.locales;
  const text: string = `${JSON.stringify(body, null, 2)}\n`;
  deps.out(text.trimEnd());
  if (!deps.yes && !(await deps.prompt.confirm('Write translify.json?', true))) {
    deps.out('Nothing was written.');

    return EXIT.failed;
  }
  await writeFile(target, text);
  deps.out(me === undefined ? NO_KEY_LINE : 'Wrote translify.json.');

  return EXIT.ok;
}

/**
 * The project this machine's key belongs to. A stored key that fails only costs the locale hints;
 * a typed key that fails stops init (the error propagates), so a wrong key is never saved.
 */
async function identify(deps: InitDeps, apiUrl: string): Promise<WhoamiInfo | undefined> {
  const stored: string | undefined = await deps.findKey();
  if (stored !== undefined) {
    try {
      return await deps.fetchWhoami(apiUrl, stored);
    } catch (error) {
      if (!(error instanceof CliError)) throw error;
      deps.out(
        error.exitCode === EXIT.auth
          ? 'Stored key was rejected; run `translify login`. Continuing without project info.'
          : `Could not reach Translify (${error.message}). Continuing without project info.`,
      );

      return undefined;
    }
  }
  if (deps.yes) return undefined;

  const typed: string = (await deps.prompt.secret('Secret key (sk_…), Enter to skip')).trim();
  if (typed === '') return undefined;
  // Before any network call, and the error never echoes the value.
  assertSecret(typed);
  const me: WhoamiInfo = await deps.fetchWhoami(apiUrl, typed);
  const path: string = await deps.saveKey(typed);
  deps.out(`Logged in to ${me.project.name} (${me.project.slug}) with scopes ${me.key.scopes.join(', ')}. Saved to ${path}.`);

  return me;
}

async function suggestMap(deps: InitDeps, matches: Match[], translifyLocales: string[]): Promise<Record<string, string>> {
  const diskLocales: string[] = [...new Set(matches.map((match) => match.locale))];

  const missing: string[] = diskLocales.filter((locale) => !translifyLocales.includes(locale));
  const map: Record<string, string> = suggestLocaleMap(diskLocales, translifyLocales);
  for (const locale of missing.filter((entry) => map[entry] === undefined)) {
    deps.out(`Locale ${locale} on disk is not enabled in the project; push will reject it.`);
  }
  if (Object.keys(map).length === 0) return {};
  if (deps.yes) return map;

  const text: string = Object.entries(map).map(([from, to]) => `${from} → ${to}`).join(', ');

  return (await deps.prompt.confirm(`Map disk locales to Translify codes (${text})?`, true)) ? map : {};
}

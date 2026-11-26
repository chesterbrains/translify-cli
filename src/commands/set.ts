import { mkdir, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

import type { Config, FileRule } from '../config.js';
import { pathContext } from '../context.js';
import { CliError, EXIT, type ExitCode } from '../errors.js';
import { BUSY, withFileLock, type LockOptions } from '../file-lock.js';
import { writeFileAtomic } from '../file-write.js';
import type { Api } from '../http.js';
import { patchJson, type PatchResult } from '../json-patch.js';
import { configNamespace } from '../namespace.js';
import { findFiles, pathFor, toTranslifyLocale, type Match, type PathContext } from '../patterns.js';
import { explainKeyError, isMissingRoute, KEY_ROUTES_UNSUPPORTED } from './get.js';
import type { LintIssue } from './lint.js';
import { WIRE_STATUS, type PushStatusFlag } from './push.js';

export interface SetResponse {
  namespace: string;
  key: string;
  locale: string;
  isSource: boolean;
  outcome: 'created' | 'updated' | 'unchanged';
  keyCreated: boolean;
  keyRestored: boolean;
  status: 'DRAFT' | 'NEEDS_REVIEW' | 'APPROVED';
  statusDowngraded: boolean;
  issueSeverity: 'ERROR' | 'WARNING' | null;
  issues: LintIssue[] | null;
  staleReset: number;
}

export interface FileOutcome {
  path: string | null;
  action: 'patched' | 'created' | 'unchanged' | 'skipped';
  reason?: string;
}

export interface SetOptions {
  namespace?: string;
  status?: PushStatusFlag;
  /** Commander sets this to false for `--no-write`. */
  write?: boolean;
  json?: boolean;
}

export interface SetDeps {
  cwd: string;
  config: Config;
  api: Api;
  out: (line: string) => void;
  err: (line: string) => void;
  /** Undefined when stdin is a terminal. */
  readStdin: (() => Promise<string>) | undefined;
  /** Lock timings for the local patch; the defaults outside tests. */
  lock?: LockOptions;
}

/**
 * The file for a cell: (a) a file already matched on disk, whatever its format; else (b) the first json rule that
 * can produce a path; else (c) the first rule of any format that can; else undefined.
 */
export function targetFile(
  matches: Match[],
  config: Config,
  context: PathContext,
  locale: string,
  namespace: string,
): { path: string; rule: FileRule; exists: boolean } | undefined {
  const existing: Match | undefined = matches.find((m) => m.locale === locale && m.namespace === namespace);
  if (existing !== undefined) return { path: existing.path, rule: existing.rule, exists: true };

  // A namespace a fixed-namespace rule owns is not also written by a `{namespace}` rule (as in pull).
  const claimed: Set<string> = new Set(config.files.flatMap((rule) => (rule.namespace === undefined ? [] : [rule.namespace])));
  const covers = (rule: FileRule): boolean =>
    rule.namespace === namespace || (rule.namespace === undefined && rule.pattern.includes('{namespace}') && !claimed.has(namespace));
  const rule: FileRule | undefined = config.files.find((r) => r.format === 'json' && covers(r)) ?? config.files.find(covers);

  return rule === undefined ? undefined : { path: pathFor(rule, locale, namespace, config, context), rule, exists: false };
}

const verbOf = (res: SetResponse): string =>
  res.keyCreated ? 'Created' : res.keyRestored ? 'Restored' : res.outcome === 'unchanged' ? 'Unchanged' : 'Updated';

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** What sits on the key's path: the key itself held as a non-text value (usually an object of other keys), or a value above it. */
const clash = (path: string, at: string | undefined, key: string): string =>
  at === key
    ? `${path} has "${key}" as something other than a text entry (usually an object holding other keys), and a nested JSON file cannot also keep "${key}" as a key`
    : `${path} holds a value at "${at}", and a nested JSON file cannot keep "${key}" beside it`;

const skippedLine = (patch: { reason: 'invalid' | 'blocked' | 'ambiguous'; at?: string }, path: string, key: string): string => {
  switch (patch.reason) {
    case 'invalid':
      return `${path} is not valid JSON; run \`translify pull\` to sync the file.`;
    case 'blocked':
      return `${clash(path, patch.at, key)}; nothing written locally. Set "jsonStyle": "flat" on this files rule to keep both.`;
    case 'ambiguous':
      return `${path} has "${patch.at}" more than once; fix the file, then run \`translify pull\`.`;
  }
};

/** The files on disk and what their patterns need, looked up once and shared by the check and the patch. */
interface Located {
  context: PathContext;
  matches: Match[];
}

const locate = async (deps: SetDeps): Promise<Located> => {
  const context: PathContext = await pathContext(deps.config, deps.api);

  return { context, matches: await findFiles(deps.config, deps.cwd, context) };
};

const insideProject = (cwd: string, path: string): string | undefined => {
  const absolute: string = resolve(cwd, path);
  const rel: string = relative(resolve(cwd), absolute);

  return rel === '' || rel.startsWith('..') || isAbsolute(rel) ? undefined : absolute;
};

const readIfPresent = async (absolute: string): Promise<string | undefined> => {
  try {
    return await readFile(absolute, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;

    return undefined;
  }
};

const refusedLine = (patch: { reason: 'invalid' | 'blocked' | 'ambiguous'; at?: string }, path: string, key: string): string => {
  const tail = 'Nothing was sent to Translify and nothing was written.';
  const noWrite = 'pass --no-write to update Translify only';
  switch (patch.reason) {
    case 'invalid':
      return `${path} is not valid JSON. ${tail} Fix the file or run \`translify pull\`, or ${noWrite}.`;
    case 'blocked':
      return `${clash(path, patch.at, key)}. ${tail} Set "jsonStyle": "flat" on this files rule to keep both, or ${noWrite}.`;
    case 'ambiguous':
      return `${path} has "${patch.at}" more than once. ${tail} Fix the file, or ${noWrite}.`;
  }
};

/**
 * Before the request: refuse when the local JSON file could not take the entry, so the server and the file never
 * end up out of step. Runs the same patcher as the write, in memory. Anything it cannot judge (no rule, another
 * format, a namespace only the server can name with several files to choose from, a lookup failure) is left to
 * `patchLocal`, which reports after the write as before. With `--json` a refusal also prints the `file` outcome
 * (`response: null`) on stdout, so a script reads the reason the same way as after a write.
 */
async function preflight(
  key: string,
  value: string,
  locale: string,
  namespace: string | undefined,
  json: boolean,
  deps: SetDeps,
): Promise<Located | undefined> {
  let located: Located;
  let path: string;
  let patch: PatchResult;
  try {
    located = await locate(deps);
    let target: { path: string; rule: FileRule } | undefined;
    if (namespace !== undefined) target = targetFile(located.matches, deps.config, located.context, locale, namespace);
    else {
      const candidates: Match[] = located.matches.filter((m) => m.locale === locale);
      target = candidates.length === 1 ? candidates[0] : undefined;
    }
    if (target === undefined || target.rule.format !== 'json') return located;
    const absolute: string | undefined = insideProject(deps.cwd, target.path);
    if (absolute === undefined) return located;
    path = target.path;
    patch = patchJson(await readIfPresent(absolute), key, value, target.rule.jsonStyle ?? 'nested');
  } catch {
    return undefined;
  }
  if (patch.action === 'skipped') {
    const file: FileOutcome = { path, action: 'skipped', reason: patch.reason };
    if (json) deps.out(JSON.stringify({ response: null, file }));
    // The file was picked as the only one for the locale; the key may live in a namespace with no file here.
    const guessed: string = namespace === undefined ? ` If "${key}" belongs to another namespace, name it with --namespace.` : '';
    throw new CliError(EXIT.failed, refusedLine(patch, path, key) + guessed);
  }

  return located;
}

/** Patch the local file after the server accepted the write; every local problem is an outcome, never a throw. */
async function patchLocal(
  res: SetResponse,
  value: string,
  sent: { locale: string; namespace: string | undefined },
  deps: SetDeps,
  known: Located | undefined,
): Promise<{ file: FileOutcome; line: string }> {
  let path: string | null = null;
  try {
    if (res.locale !== sent.locale || (sent.namespace !== undefined && res.namespace !== sent.namespace)) {
      return {
        file: { path: null, action: 'skipped', reason: 'mismatch' },
        line: `The server answered for ${res.locale}/${res.namespace}, not what was asked; nothing written locally.`,
      };
    }
    const { context, matches }: Located = known ?? (await locate(deps));
    const target = targetFile(matches, deps.config, context, res.locale, res.namespace);
    if (target === undefined) {
      return {
        file: { path: null, action: 'skipped', reason: 'no-rule' },
        line: `No files rule covers ${res.locale}/${res.namespace}; nothing written locally.`,
      };
    }
    path = target.path;
    if (target.rule.format !== 'json') {
      return {
        file: { path, action: 'skipped', reason: 'format' },
        line: `Local patching is not supported for ${target.rule.format} yet; run \`translify pull\` to sync the file.`,
      };
    }

    const absolute: string | undefined = insideProject(deps.cwd, path);
    if (absolute === undefined) {
      return {
        file: { path: null, action: 'skipped', reason: 'outside' },
        line: `Refusing to write ${path}: it resolves outside the project directory.`,
      };
    }
    const file: string = path;
    const style: 'nested' | 'flat' = target.rule.jsonStyle ?? 'nested';
    // Read, patch and write under the file's lock: two `set` commands at once would otherwise both read the old
    // text and the last writer would drop the other's entry.
    const done = await withFileLock(
      absolute,
      async (): Promise<{ file: FileOutcome; line: string }> => {
        const patch: PatchResult = patchJson(await readIfPresent(absolute), res.key, value, style);
        if (patch.action === 'skipped') return { file: { path: file, action: 'skipped', reason: patch.reason }, line: skippedLine(patch, file, res.key) };
        if (patch.action === 'unchanged') return { file: { path: file, action: 'unchanged' }, line: `${file} already up to date.` };

        await mkdir(dirname(absolute), { recursive: true });
        await writeFileAtomic(absolute, patch.text);

        return { file: { path: file, action: patch.action }, line: `${patch.action === 'created' ? 'Created' : 'Updated'} ${file}.` };
      },
      deps.lock,
    );
    if (done === BUSY) {
      return {
        file: { path, action: 'skipped', reason: 'busy' },
        line: `${path} is being written by another translify process; nothing written locally. Run \`translify pull\` to sync the file.`,
      };
    }

    return done;
  } catch (error) {
    return {
      file: { path, action: 'skipped', reason: 'io' },
      line: path === null ? `Could not locate the local file: ${message(error)}` : `Could not write ${path}: ${message(error)}`,
    };
  }
}

export async function runSet(key: string, locale: string, value: string, opts: SetOptions, deps: SetDeps): Promise<ExitCode> {
  let text: string = value;
  if (value === '-') {
    if (deps.readStdin === undefined) {
      throw new CliError(EXIT.failed, 'Reading the value from stdin (-) needs piped input, e.g. `echo "text" | translify set <key> <locale> -`.');
    }
    text = (await deps.readStdin()).replace(/\r?\n$/, '');
  }
  if (text === '') {
    throw new CliError(EXIT.failed, 'An empty value is refused: clearing a translation is not supported. Clear it in Translify.');
  }

  const namespace: string | undefined = configNamespace(deps.config, opts.namespace);
  const sentLocale: string = toTranslifyLocale(locale, deps.config);
  const body: Record<string, string> = { key, locale: sentLocale, value: text };
  if (namespace !== undefined) body.namespace = namespace;
  if (opts.status !== undefined) body.status = WIRE_STATUS[opts.status];

  const located: Located | undefined = opts.write === false ? undefined : await preflight(key, text, sentLocale, namespace, opts.json === true, deps);

  let res: SetResponse;
  try {
    res = await deps.api.put<SetResponse>('/cli/v1/translation', body);
  } catch (error) {
    if (isMissingRoute(error)) throw new CliError(EXIT.failed, KEY_ROUTES_UNSUPPORTED);
    throw explainKeyError(error, key);
  }

  const local: { file: FileOutcome; line: string | undefined } =
    opts.write === false ? { file: { path: null, action: 'skipped', reason: 'no-write' }, line: undefined } : await patchLocal(res, text, { locale: sentLocale, namespace }, deps, located);

  if (opts.json === true) {
    deps.out(JSON.stringify({ response: res, file: local.file }));

    return EXIT.ok;
  }

  deps.out(`${verbOf(res)} ${res.key} (${res.locale}) in namespace ${res.namespace}. Status: ${res.status.toLowerCase().replaceAll('_', '-')}.`);
  if (res.staleReset > 0) deps.out(`${res.staleReset} approved translation(s) moved back to needs-review.`);
  if (res.statusDowngraded) deps.out('Requested approved, landed needs-review: the translation has placeholder errors.');
  for (const issue of res.issues ?? []) {
    const detail: string = issue.arg !== undefined ? ` ${issue.arg}` : issue.categories !== undefined && issue.categories.length > 0 ? ` ${issue.categories.join(', ')}` : '';
    deps.out(`warning: placeholder ${issue.severity.toLowerCase()}: ${issue.code}${detail}`);
  }
  if (local.line !== undefined) deps.out(local.line);

  return EXIT.ok;
}

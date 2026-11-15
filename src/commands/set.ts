import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { Config, FileRule } from '../config.js';
import { pathContext } from '../context.js';
import { CliError, EXIT, type ExitCode } from '../errors.js';
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

/** Patch the local file after the server accepted the write; every local problem is an outcome, never a throw. */
async function patchLocal(res: SetResponse, value: string, deps: SetDeps): Promise<{ file: FileOutcome; line: string }> {
  let path: string | null = null;
  try {
    const context: PathContext = await pathContext(deps.config, deps.api);
    const target = targetFile(await findFiles(deps.config, deps.cwd, context), deps.config, context, res.locale, res.namespace);
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

    const absolute: string = join(deps.cwd, path);
    let text: string | undefined;
    try {
      text = await readFile(absolute, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const patch: PatchResult = patchJson(text, res.key, value, target.rule.jsonStyle ?? 'nested');
    if (patch.action === 'skipped') {
      return {
        file: { path, action: 'skipped', reason: patch.reason },
        line:
          patch.reason === 'invalid'
            ? `${path} is not valid JSON; run \`translify pull\` to sync the file.`
            : `${path} holds a value at "${patch.at}"; run \`translify pull\` to sync the file.`,
      };
    }
    if (patch.action === 'unchanged') return { file: { path, action: 'unchanged' }, line: `${path} already up to date.` };

    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, patch.text, 'utf8');

    return { file: { path, action: patch.action }, line: `${patch.action === 'created' ? 'Created' : 'Updated'} ${path}.` };
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
  const body: Record<string, string> = { key, locale: toTranslifyLocale(locale, deps.config), value: text };
  if (namespace !== undefined) body.namespace = namespace;
  if (opts.status !== undefined) body.status = WIRE_STATUS[opts.status];

  let res: SetResponse;
  try {
    res = await deps.api.put<SetResponse>('/cli/v1/translation', body);
  } catch (error) {
    if (isMissingRoute(error)) throw new CliError(EXIT.failed, KEY_ROUTES_UNSUPPORTED);
    throw explainKeyError(error, key);
  }

  const local: { file: FileOutcome; line: string | undefined } =
    opts.write === false ? { file: { path: null, action: 'skipped', reason: 'no-write' }, line: undefined } : await patchLocal(res, text, deps);

  if (opts.json === true) {
    deps.out(JSON.stringify({ response: res, file: local.file }));

    return EXIT.ok;
  }

  deps.out(`${verbOf(res)} ${res.key} (${res.locale}) in namespace ${res.namespace}. Status: ${res.status.toLowerCase().replaceAll('_', '-')}.`);
  if (res.staleReset > 0) deps.out(`${res.staleReset} approved translation(s) moved back to needs-review.`);
  if (res.statusDowngraded) deps.out('Requested approved, landed needs-review: the translation has placeholder errors.');
  for (const issue of res.issues ?? []) {
    deps.out(`warning: placeholder ${issue.severity.toLowerCase()}: ${issue.code}${issue.arg === undefined ? '' : ` ${issue.arg}`}`);
  }
  if (local.line !== undefined) deps.out(local.line);

  return EXIT.ok;
}

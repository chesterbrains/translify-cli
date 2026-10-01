import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

import type { Config } from '../config.js';
import type { ExitCode } from '../errors.js';
import type { Api } from '../http.js';
import { CliError, EXIT } from '../errors.js';
import { pathFor, toFsLocale, toTranslifyLocale } from '../patterns.js';

interface PullResponse {
  files: Array<{ locale: string; namespace: string; format: string; content: string }>;
  warnings: string[];
}

export interface PullOptions {
  from?: string;
  locale?: string;
  namespace?: string;
  /** `status`: compare only, write nothing. */
  check?: boolean;
  json?: boolean;
}

export interface PullDeps {
  cwd: string;
  config: Config;
  api: Api;
  out: (line: string) => void;
}

const readOrUndefined = async (path: string): Promise<string | undefined> =>
  readFile(path, 'utf8').catch(() => undefined);

const NESTED_CONFLICT: RegExp = /nested JSON cannot hold both/;

/**
 * Flutter's gen_l10n requires `@@locale` to match the file name, and only the CLI knows the disk
 * mapping. Rewrites the value in place (key order kept) with the server's own formatting so the
 * output is byte-stable; content that is not a JSON object is left alone.
 */
const withDiskLocale = (content: string, translifyLocale: string, config: Config): string => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return content;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return content;
  const doc: Record<string, unknown> = parsed as Record<string, unknown>;
  if (typeof doc['@@locale'] !== 'string') return content;
  doc['@@locale'] = toFsLocale(translifyLocale, config);

  return `${JSON.stringify(doc, null, 2)}\n`;
};

/** A Windows checkout (autocrlf, BOM) must not count as drift. */
const normalizeEol = (text: string): string => text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');

export async function runPull(opts: PullOptions, deps: PullDeps): Promise<ExitCode> {
  const changed: string[] = [];
  const created: string[] = [];
  const responses: PullResponse[] = [];
  const lines: string[] = [];
  let flatHinted = false;
  // Phase 1 plans every write; nothing touches disk until every request and check has passed.
  const plan: Array<{ path: string; absolute: string; content: string }> = [];
  const seen: Map<string, string> = new Map<string, string>();

  // Namespaces a fixed-namespace rule owns must not also be written by a `{namespace}` rule.
  const claimed: Set<string> = new Set(
    deps.config.files.flatMap((rule) => (rule.namespace === undefined ? [] : [rule.namespace])),
  );

  for (const rule of deps.config.files) {
    if (opts.namespace !== undefined && rule.namespace !== undefined && rule.namespace !== opts.namespace) continue;
    const wildcard: boolean = rule.namespace === undefined;
    if (wildcard && opts.namespace !== undefined && claimed.has(opts.namespace)) continue;

    const query: Record<string, string> = { format: rule.format };
    if (rule.format === 'json' && rule.jsonStyle !== undefined) query.jsonStyle = rule.jsonStyle;
    if (opts.from !== undefined) query.from = opts.from;
    if (opts.locale !== undefined) query.locales = toTranslifyLocale(opts.locale, deps.config);
    const namespace: string | undefined = rule.namespace ?? opts.namespace;
    if (namespace !== undefined) query.namespaces = namespace;

    const res: PullResponse = await deps.api.get<PullResponse>('/cli/v1/pull', query);
    responses.push(res);
    for (const warning of res.warnings) {
      lines.push(`warning: ${warning}`);
      if (!flatHinted && NESTED_CONFLICT.test(warning)) {
        flatHinted = true;
        lines.push('hint: set "jsonStyle": "flat" on this files rule in translify.json to keep both keys.');
      }
    }

    for (const file of res.files) {
      if (wildcard && claimed.has(file.namespace)) continue;

      const path: string = pathFor(rule, file.locale, file.namespace, deps.config);
      const absolute: string = resolve(deps.cwd, path);
      const rel: string = relative(resolve(deps.cwd), absolute);
      if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
        throw new CliError(EXIT.failed, `Refusing to write ${path}: it resolves outside the project directory.`);
      }

      // Two server locales can back-map to one disk locale; writing both would clobber one every run.
      const cell = `${file.locale}/${file.namespace}`;
      const other: string | undefined = seen.get(absolute);
      if (other !== undefined) {
        throw new CliError(
          EXIT.failed,
          `${path} would be written for both ${other} and ${cell}. Fix the "locales" map so each Translify locale has its own file.`,
        );
      }
      seen.set(absolute, cell);

      const content: string = rule.format === 'arb' ? withDiskLocale(file.content, file.locale, deps.config) : file.content;
      const existing: string | undefined = await readOrUndefined(absolute);
      if (existing !== undefined && (existing === content || normalizeEol(existing) === content)) continue;

      (existing === undefined ? created : changed).push(path);
      plan.push({ path, absolute, content });
    }
  }

  if (!opts.check) {
    for (const item of plan) {
      await mkdir(dirname(item.absolute), { recursive: true });
      await writeFile(item.absolute, item.content);
    }
  }

  const drift: string[] = [...changed, ...created];
  if (opts.json) {
    deps.out(JSON.stringify({ responses, summary: { check: opts.check === true, changed: drift, created } }));
  } else {
    for (const line of lines) deps.out(line);
    if (drift.length === 0) deps.out(opts.check ? 'Up to date.' : 'Nothing to update.');
    else {
      const rows: string[] = [
        ...changed.map((path) => `  ${path}`),
        ...created.map((path) => `  ${path} (new)`),
      ];
      deps.out(`${opts.check ? 'Out of date' : 'Updated'}:\n${rows.join('\n')}`);
    }
  }

  return opts.check && drift.length > 0 ? EXIT.failed : EXIT.ok;
}

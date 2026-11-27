import type { Config } from '../config.js';
import { isMissingRoute, type Api } from '../http.js';
import { CliError, EXIT, type ExitCode } from '../errors.js';
import { toTranslifyLocale } from '../patterns.js';
import { renderLint } from '../render.js';

/** The server's `GET /cli/v1/lint` body (BE lint spec §2.3). */
export type LintSeverity = 'ERROR' | 'WARNING';

export interface LintIssue {
  /** One of the BE's ISSUE_CODES; a newer server may send one this CLI does not know. */
  code: string;
  severity: LintSeverity;
  arg?: string;
  categories?: string[];
  message?: string;
  offset?: number | null;
}

export interface LintCell {
  namespace: string;
  key: string;
  locale: string;
  severity: LintSeverity;
  value: string;
  issues: LintIssue[];
}

/** A key that is also the dotted path above other keys of its namespace (`cart` above `cart.title`). */
export interface LintKeyConflict {
  namespace: string;
  key: string;
  /** The keys below it, sorted; the server names at most 20. */
  below: string[];
  belowCount: number;
}

export interface LintResponse {
  summary: {
    errors: number;
    warnings: number;
    locales: Array<{ locale: string; errors: number; warnings: number }>;
    /** Absent on a server older than the key-conflict report. Never part of `errors` or `warnings`. */
    keyConflicts?: number;
  };
  cells: LintCell[];
  truncated: boolean;
  /** Absent on an older server. */
  keyConflicts?: LintKeyConflict[];
  keyConflictsTruncated?: boolean;
}

export const LINT_SEVERITIES = ['error', 'warning'] as const;

export const LINT_UNSUPPORTED: string = 'This Translify server does not support lint yet.';

export interface LintOptions {
  namespace?: string;
  /** As named on disk; mapped through translify.json "locales". */
  locale?: string;
  severity?: (typeof LINT_SEVERITIES)[number];
  maxWarnings?: string;
  json?: boolean;
}

export interface LintDeps {
  api: Api;
  config: Config;
  out: (line: string) => void;
}

/**
 * What this repo would pull: the flag, else the whole project when any rule is a
 * `{namespace}` wildcard, else the fixed namespaces. Undefined means no filter.
 */
export const lintNamespaces = (config: Config, flag?: string): string | undefined => {
  if (flag !== undefined) return flag;
  if (config.files.some((rule) => rule.namespace === undefined)) return undefined;
  const fixed: string[] = [...new Set(config.files.flatMap((rule) => (rule.namespace === undefined ? [] : [rule.namespace])))].sort();

  return fixed.length === 0 ? undefined : fixed.join(',');
};

export const parseMaxWarnings = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) throw new CliError(EXIT.failed, '--max-warnings must be a whole number, 0 or more.');

  return Number(raw);
};

export async function runLint(opts: LintOptions, deps: LintDeps): Promise<ExitCode> {
  const maxWarnings: number | undefined = parseMaxWarnings(opts.maxWarnings);

  const query: Record<string, string> = {};
  const namespaces: string | undefined = lintNamespaces(deps.config, opts.namespace);
  if (namespaces !== undefined) query.namespaces = namespaces;
  if (opts.locale !== undefined) query.locales = toTranslifyLocale(opts.locale, deps.config);
  if (opts.severity !== undefined) query.severity = opts.severity.toUpperCase();

  let res: LintResponse;
  try {
    res = await deps.api.get<LintResponse>('/cli/v1/lint', query);
  } catch (error) {
    if (isMissingRoute(error)) throw new CliError(EXIT.failed, LINT_UNSUPPORTED);
    throw error;
  }

  const { errors, warnings } = res.summary;
  deps.out(
    opts.json === true
      ? // `keyConflicts` only when the server reports them: an older server's output stays byte for byte what it was.
        JSON.stringify({
          response: res,
          summary: { errors, warnings, truncated: res.truncated, ...(res.summary.keyConflicts === undefined ? {} : { keyConflicts: res.summary.keyConflicts }) },
        })
      : renderLint(res, deps.config, { severity: opts.severity }),
  );

  // Key conflicts are reported, never judged: they do not change the exit code.
  return errors > 0 || (maxWarnings !== undefined && warnings > maxWarnings) ? EXIT.issues : EXIT.ok;
}

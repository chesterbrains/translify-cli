import type { Config } from '../config.js';
import type { Api } from '../http.js';
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

export interface LintResponse {
  summary: { errors: number; warnings: number; locales: Array<{ locale: string; errors: number; warnings: number }> };
  cells: LintCell[];
  truncated: boolean;
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

/** Nest's own 404 for an unknown route has no `code`; every CLI error the server sends has one. */
const isMissingRoute = (error: unknown): boolean => {
  if (!(error instanceof CliError) || typeof error.details !== 'object' || error.details === null) return false;
  const body = error.details as { statusCode?: unknown; code?: unknown };

  return body.statusCode === 404 && body.code === undefined;
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
      ? JSON.stringify({ response: res, summary: { errors, warnings, truncated: res.truncated } })
      : renderLint(res, deps.config, { severity: opts.severity }),
  );

  return errors > 0 || (maxWarnings !== undefined && warnings > maxWarnings) ? EXIT.issues : EXIT.ok;
}

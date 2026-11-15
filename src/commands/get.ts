import type { Config } from '../config.js';
import { CliError, EXIT, type ExitCode } from '../errors.js';
import type { Api } from '../http.js';
import { configNamespace } from '../namespace.js';
import { toTranslifyLocale } from '../patterns.js';

export interface KeyCell {
  locale: string;
  isDefault: boolean;
  value: string | null;
  status: string | null;
  issueSeverity: 'ERROR' | 'WARNING' | null;
}

/** The server's `GET /cli/v1/key` body; cells arrive ordered (default locale first, then by code). */
export interface GetKeyResponse {
  namespace: string;
  key: string;
  description: string | null;
  cells: KeyCell[];
}

export interface GetOptions {
  namespace?: string;
  json?: boolean;
}

export interface GetDeps {
  api: Api;
  config: Config;
  out: (line: string) => void;
  err: (line: string) => void;
}

export const KEY_ROUTES_UNSUPPORTED: string = 'This Translify server does not support get and set yet.';

/** Nest's own 404 for an unknown route has no `code`; every CLI error the server sends has one. */
export const isMissingRoute = (error: unknown): boolean => {
  if (!(error instanceof CliError) || typeof error.details !== 'object' || error.details === null) return false;
  const body = error.details as { statusCode?: unknown; code?: unknown };

  return body.statusCode === 404 && body.code === undefined;
};

const keyMessage = (key: string, body: { code?: unknown; archived?: unknown; namespaces?: unknown; archivedNamespaces?: unknown; defaultLocale?: unknown }): string | undefined => {
  switch (body.code) {
    case 'KEY_NOT_FOUND':
      return `Key '${key}' not found.${body.archived === true ? ' It is in the trash; restore it in Translify or set its source text.' : ''}`;
    case 'NAMESPACE_AMBIGUOUS':
      return `Key '${key}' exists in namespaces ${Array.isArray(body.namespaces) ? body.namespaces.map(String).join(', ') : String(body.namespaces)}. Re-run with --namespace <ns>.`;
    case 'NAMESPACE_REQUIRED':
      return `'${key}' is a new key: say where it lives with --namespace <ns>.${
        Array.isArray(body.archivedNamespaces) && body.archivedNamespaces.length > 0
          ? ` It is in the trash in namespace ${body.archivedNamespaces.map(String).join(', ')}: pass --namespace <ns> to restore it.`
          : ''
      }`;
    case 'SOURCE_REQUIRED':
      return typeof body.defaultLocale === 'string'
        ? `Key '${key}' does not exist. Set its source text (${body.defaultLocale}) first.`
        : `Key '${key}' does not exist. This project has no default locale; set one in Translify first.`;
    case 'KEY_ARCHIVED':
      return `Key '${key}' is in the trash. Restore it in Translify, or set its source text to bring it back.`;
    default:
      return undefined;
  }
};

/** The server's message does not carry the key reliably: rewrite the key-specific refusals, pass everything else through. */
export function explainKeyError(error: unknown, key: string): unknown {
  if (!(error instanceof CliError) || typeof error.details !== 'object' || error.details === null) return error;
  const message: string | undefined = keyMessage(key, error.details);

  return message === undefined ? error : new CliError(error.exitCode, message, error.details);
}

const oneLine = (value: string): string => value.replace(/[\r\n\t]/g, (c) => (c === '\n' ? '\\n' : c === '\r' ? '\\r' : '\\t'));

const table = (res: GetKeyResponse): string => {
  const rows: string[][] = [
    ['LOCALE', 'STATUS', 'ISSUES', 'VALUE'],
    ...res.cells.map((cell) => [
      cell.locale,
      cell.status ?? '-',
      cell.issueSeverity === null ? '' : cell.issueSeverity.toLowerCase(),
      cell.value === null ? '(empty)' : oneLine(cell.value),
    ]),
  ];
  const widths: number[] = [0, 1, 2].map((i) => Math.max(...rows.map((row) => row[i]!.length)));
  const lines: string[] = rows.map((row) =>
    row
      .map((cell, i) => (i < 3 ? cell.padEnd(widths[i]!) : cell))
      .join('  ')
      .trimEnd(),
  );

  return ['Namespace: ' + res.namespace, 'Key:       ' + res.key, '', ...lines].join('\n');
};

export async function runGet(key: string, locale: string | undefined, opts: GetOptions, deps: GetDeps): Promise<ExitCode> {
  const query: Record<string, string> = { key };
  const namespace: string | undefined = configNamespace(deps.config, opts.namespace);
  if (namespace !== undefined) query.namespace = namespace;
  const wanted: string | undefined = locale === undefined ? undefined : toTranslifyLocale(locale, deps.config);

  let res: GetKeyResponse;
  try {
    res = await deps.api.get<GetKeyResponse>('/cli/v1/key', query);
  } catch (error) {
    if (isMissingRoute(error)) throw new CliError(EXIT.failed, KEY_ROUTES_UNSUPPORTED);
    throw explainKeyError(error, key);
  }

  if (wanted === undefined) {
    deps.out(opts.json === true ? JSON.stringify(res) : table(res));

    return EXIT.ok;
  }

  const cell: KeyCell | undefined = res.cells.find((c) => c.locale === wanted);
  if (cell === undefined) throw new CliError(EXIT.failed, `Locale ${wanted} is not an enabled locale of this project.`);
  if (opts.json === true) deps.out(JSON.stringify(res));
  if (cell.value === null) {
    if (opts.json !== true) deps.err(`No ${wanted} translation for ${key}.`);

    return EXIT.failed;
  }
  if (opts.json !== true) deps.out(cell.value);

  return EXIT.ok;
}

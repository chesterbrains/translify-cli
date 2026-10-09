import type { Config } from '../config.js';
import type { Api } from '../http.js';
import type { IssueCell } from '../render.js';
import { CliError, EXIT, type ExitCode } from '../errors.js';
import { renderIssueCells } from '../render.js';

interface PublishResponse {
  environmentId: string;
  publishedCount: number;
  publishedAt: string;
  /** Absent on servers older than review state; read as 0. */
  carriedOverCount?: number;
  withheldCount?: number;
  /** Absent on servers older than the publish error gate; read as 0. */
  errorCount?: number;
}

/** The 422 `INVALID_CELLS` body: up to 100 cells, `total` counts them all. */
interface InvalidCellsBody {
  code: 'INVALID_CELLS';
  total: number;
  cells: IssueCell[];
}

export interface PublishDeps {
  api: Api;
  out: (line: string) => void;
  /** Maps locales to their names on disk in a refusal; without it the server's codes print as-is. */
  config?: Config;
  json?: boolean;
  /** Exit `EXIT.withheld` when the gate held back any cell; the publish itself still went through. */
  failOnWithheld?: boolean;
  /** Publish even when translations with placeholder errors would go live. */
  allowErrors?: boolean;
}

const isInvalidCells = (details: unknown): details is InvalidCellsBody =>
  typeof details === 'object' && details !== null && (details as { code?: unknown }).code === 'INVALID_CELLS';

/** The server's one-line refusal, the cells grouped like `lint`, and the way out. */
const refusal = (body: InvalidCellsBody, config: Config | undefined): CliError => {
  const cells: IssueCell[] = Array.isArray(body.cells) ? body.cells : [];
  const lines: string[] = [
    `Publish refused: ${body.total} translation(s) with placeholder errors would go live. Nothing was published.`,
    ...renderIssueCells(cells, config),
  ];
  if (body.total > cells.length) lines.push(`Showing first ${cells.length} of ${body.total}.`);
  lines.push('Fix them (translify lint lists every issue) or re-run with --allow-errors.');

  return new CliError(EXIT.issues, lines.join('\n'), body);
};

export async function runPublish(environment: string, deps: PublishDeps): Promise<ExitCode> {
  // Only send the flag when it is set: a server older than the gate rejects unknown fields.
  const request: Record<string, unknown> = deps.allowErrors === true ? { environment, allowErrors: true } : { environment };
  const res: PublishResponse = await deps.api.post<PublishResponse>('/cli/v1/publish', request).catch((error: unknown) => {
    if (error instanceof CliError && isInvalidCells(error.details)) throw refusal(error.details, deps.config);
    throw error;
  });
  const carriedOverCount: number = res.carriedOverCount ?? 0;
  const withheldCount: number = res.withheldCount ?? 0;
  const errorCount: number = res.errorCount ?? 0;
  // An ungated environment reports 0 / 0; keep its output as it was before review state.
  const gate: string =
    carriedOverCount > 0 || withheldCount > 0 ? ` ${carriedOverCount} carried over, ${withheldCount} withheld.` : '';
  const errors: string = errorCount > 0 ? ` ${errorCount} with placeholder errors.` : '';
  deps.out(
    deps.json === true
      ? JSON.stringify({
          response: res,
          summary: { environment, publishedCount: res.publishedCount, carriedOverCount, withheldCount, errorCount },
        })
      : `Published ${res.publishedCount} translation(s) to ${environment}.${gate}${errors}`,
  );

  return deps.failOnWithheld === true && withheldCount > 0 ? EXIT.withheld : EXIT.ok;
}

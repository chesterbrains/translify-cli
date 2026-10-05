import type { ExitCode } from '../errors.js';
import type { Api } from '../http.js';
import { EXIT } from '../errors.js';

interface PublishResponse {
  environmentId: string;
  publishedCount: number;
  publishedAt: string;
  /** Absent on servers older than review state; read as 0. */
  carriedOverCount?: number;
  withheldCount?: number;
}

export interface PublishDeps {
  api: Api;
  out: (line: string) => void;
  json?: boolean;
  /** Exit `EXIT.withheld` when the gate held back any cell; the publish itself still went through. */
  failOnWithheld?: boolean;
}

export async function runPublish(environment: string, deps: PublishDeps): Promise<ExitCode> {
  const res: PublishResponse = await deps.api.post<PublishResponse>('/cli/v1/publish', { environment });
  const carriedOverCount: number = res.carriedOverCount ?? 0;
  const withheldCount: number = res.withheldCount ?? 0;
  // An ungated environment reports 0 / 0; keep its output as it was before review state.
  const gate: string =
    carriedOverCount > 0 || withheldCount > 0 ? ` ${carriedOverCount} carried over, ${withheldCount} withheld.` : '';
  deps.out(
    deps.json === true
      ? JSON.stringify({
          response: res,
          summary: { environment, publishedCount: res.publishedCount, carriedOverCount, withheldCount },
        })
      : `Published ${res.publishedCount} translation(s) to ${environment}.${gate}`,
  );

  return deps.failOnWithheld === true && withheldCount > 0 ? EXIT.withheld : EXIT.ok;
}

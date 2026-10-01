import type { ExitCode } from '../errors.js';
import type { Api } from '../http.js';
import { EXIT } from '../errors.js';

interface PublishResponse {
  environmentId: string;
  publishedCount: number;
  publishedAt: string;
}

export interface PublishDeps {
  api: Api;
  out: (line: string) => void;
  json?: boolean;
}

export async function runPublish(environment: string, deps: PublishDeps): Promise<ExitCode> {
  const res: PublishResponse = await deps.api.post<PublishResponse>('/cli/v1/publish', { environment });
  deps.out(
    deps.json === true
      ? JSON.stringify({ response: res, summary: { environment, publishedCount: res.publishedCount } })
      : `Published ${res.publishedCount} translation(s) to ${environment}.`,
  );

  return EXIT.ok;
}

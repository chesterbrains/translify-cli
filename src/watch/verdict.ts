import { CliError } from '../errors.js';

/**
 * What a watch does with a failed request:
 * - `stop`: retrying cannot fix it (the key, the CLI version, an archived project); the watch ends.
 * - `retry`: nothing wrong with the files (network, server, rate limit, a transaction conflict); the same push goes again after a backoff.
 * - `wait`: the server refused these files (validation, size, quota); nothing is sent until one of them changes.
 */
export type WatchVerdict = 'stop' | 'retry' | 'wait';

const codeOf = (error: CliError): string | undefined => {
  const details: unknown = error.details;
  if (typeof details !== 'object' || details === null) return undefined;
  const code: unknown = (details as { code?: unknown }).code;

  return typeof code === 'string' ? code : undefined;
};

/** Anything that is not a `CliError` is a bug and is rethrown. */
export const watchVerdict = (error: unknown): WatchVerdict => {
  if (!(error instanceof CliError)) throw error;
  const { status } = error;
  // No answer at all: the network, or the request timed out.
  if (status === undefined) return 'retry';
  if (status === 401 || status === 403 || status === 426 || codeOf(error) === 'PROJECT_ARCHIVED') return 'stop';
  // Every 409 a plain push can get is transient: a transaction conflict, or a key archived or gone mid-push.
  // 408: a proxy gave up waiting, which says nothing about the files.
  if (status === 408 || status === 409 || status === 429 || status >= 500) return 'retry';

  return 'wait';
};

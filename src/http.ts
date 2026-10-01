import { CliError, EXIT, type ExitCode } from './errors.js';
import { USER_AGENT } from './version.js';

interface ErrorBody {
  code?: string;
  message?: string | string[];
  [extra: string]: unknown;
}

const NOT_JSON: unique symbol = Symbol('notJson');
const MAX_RETRIES: number = 3;
const MAX_WAIT_MS: number = 60_000;
const UPGRADE: string =
  'npm i -g @chesterbrains/translify-cli@latest, or for the standalone binary: curl -fsSL https://github.com/chesterbrains/translify-cli/releases/latest/download/install.sh | sh';
const sleep = async (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Exit code by the body's `code` first; the status only decides for a code we do not know. */
const CODE_EXIT: Record<string, ExitCode> = {
  VALIDATION_FAILED: EXIT.failed,
  LOCALE_NOT_FOUND: EXIT.failed,
  NAMESPACE_NOT_FOUND: EXIT.failed,
  ORPHANS_PUBLISHED: EXIT.failed,
  JSON_STYLE_REQUIRES_JSON: EXIT.failed,
  BAD_REQUEST: EXIT.failed,
  ENVIRONMENT_NOT_FOUND: EXIT.failed,
  ENVIRONMENT_ARCHIVED: EXIT.failed,
  PROJECT_ARCHIVED: EXIT.failed,
  SECRET_KEY_IN_URL: EXIT.failed,
  KEY_INVALID: EXIT.auth,
  KEY_REVOKED: EXIT.auth,
  KEY_WRONG_KIND: EXIT.auth,
  SCOPE_MISSING: EXIT.auth,
  QUOTA_EXCEEDED: EXIT.quota,
  INTERNAL_ERROR: EXIT.network,
  DATABASE_ERROR: EXIT.network,
  PUSH_TOO_LARGE: EXIT.network,
  CLI_TOO_OLD: EXIT.network,
  TRANSACTION_CONFLICT: EXIT.network,
  RATE_LIMITED: EXIT.network,
};

const exitFor = (status: number, code: string | undefined): ExitCode => {
  const byCode: ExitCode | undefined = code === undefined ? undefined : CODE_EXIT[code];
  if (byCode !== undefined) return byCode;
  if (status === 401 || status === 403) return EXIT.auth;
  if (status === 402) return EXIT.quota;
  if (status === 413 || status === 426 || status === 429 || status >= 500) return EXIT.network;

  return EXIT.failed;
};

const list = (value: unknown): string => (Array.isArray(value) ? value.map(String).join(', ') : String(value));

const validationLines = (errors: unknown): string => {
  if (!Array.isArray(errors) || errors.length === 0) return '';

  return errors
    .map((raw: unknown): string => {
      const e: Record<string, unknown> = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
      const where: string = `${String(e.file ?? '?')}${e.line === undefined ? '' : `:${String(e.line)}`}`;

      return `${where}${e.key === undefined ? '' : ` ${String(e.key)}`}: ${String(e.reason ?? 'invalid')}`;
    })
    .join('\n');
};

const describeBody = (status: number, body: ErrorBody): string => {
  const text: string = Array.isArray(body.message) ? body.message.join('; ') : (body.message ?? '');

  switch (body.code) {
    case 'KEY_INVALID':
      return 'The key was not recognised. Check TRANSLIFY_SECRET_KEY.';
    case 'KEY_REVOKED':
      return 'This key was revoked. Create a new secret key in Translify.';
    case 'KEY_WRONG_KIND':
      return 'This is not a secret key. The CLI needs an sk_ key.';
    case 'SCOPE_MISSING':
      return `This key lacks the ${String(body.required)} scope. Create a key that has it.`;
    case 'QUOTA_EXCEEDED':
      return `Plan limit reached for ${String(body.dimension)}: ${String(body.current)} of ${String(body.limit)} used.`;
    case 'PUSH_TOO_LARGE':
      return `Push too large (${String(body.entries ?? body.bytes)} over the limit of ${String(body.limit)}). Split it with --namespace.`;
    case 'CLI_TOO_OLD':
      return `This CLI is too old; ${String(body.minimum)} or newer is required. Upgrade: ${UPGRADE}`;
    case 'VALIDATION_FAILED': {
      const lines: string = validationLines(body.errors);

      return lines === '' ? text || 'The push was rejected; nothing was written.' : `The push was rejected; nothing was written.\n${lines}`;
    }
    case 'LOCALE_NOT_FOUND':
      return `Unknown locale(s): ${list(body.locales)}. They are not enabled in this project.`;
    case 'NAMESPACE_NOT_FOUND':
      return `Unknown namespace(s): ${list(body.namespaces)}.`;
    case 'ORPHANS_PUBLISHED': {
      const keys: string = list(body.keys);
      const more: string = typeof body.total === 'number' ? ` (${body.total} in total)` : '';

      return `Published keys would be pruned: ${keys}${more}. Unpublish them first, or drop --prune.`;
    }
    case 'TRANSACTION_CONFLICT':
      return 'The server hit a transaction conflict. Try again.';
    case 'RATE_LIMITED':
      return 'Rate limited by the server; gave up after retries. Try again shortly.';
    default:
      if (status >= 500) return `Translify server error (${status}). Try again shortly.`;
      if (status === 429) return 'Rate limited by the server; gave up after retries. Try again shortly.';

      return text || `HTTP ${status}${body.code === undefined ? '' : ` ${body.code}`}`;
  }
};

const explain = (status: number, body: ErrorBody): CliError =>
  new CliError(exitFor(status, body.code), describeBody(status, body), body);

/** Retry-After is delta-seconds or an HTTP date; anything else falls back to exponential backoff. Capped. */
export const retryDelayMs = (header: string | null, attempt: number, now: number = Date.now()): number => {
  let ms: number = 2 ** attempt * 1000;
  if (header !== null && header.trim() !== '') {
    const seconds: number = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) ms = seconds * 1000;
    else {
      const date: number = Date.parse(header);
      if (!Number.isNaN(date)) ms = Math.max(0, date - now);
    }
  }

  return Math.min(ms, MAX_WAIT_MS);
};

const safeJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 200), [NOT_JSON]: true };
  }
};

export class Api {
  constructor(
    private readonly apiUrl: string,
    private readonly key: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async get<T>(path: string, query: Record<string, string> = {}): Promise<T> {
    const search: string = new URLSearchParams(query).toString();

    return this.send<T>(`${path}${search ? `?${search}` : ''}`, { method: 'GET' });
  }

  async post<T>(path: string, body: FormData | object): Promise<T> {
    return body instanceof FormData
      ? this.send<T>(path, { method: 'POST', body })
      : this.send<T>(path, {
          method: 'POST',
          body: JSON.stringify(body),
          headers: { 'content-type': 'application/json' },
        });
  }

  private async send<T>(path: string, init: Omit<RequestInit, 'headers'> & { headers?: Record<string, string> }): Promise<T> {
    const url: string = `${this.apiUrl.replace(/\/$/, '')}${path}`;
    const headers: Record<string, string> = {
      ...init.headers,
      authorization: `Bearer ${this.key}`,
      'user-agent': USER_AGENT,
      accept: 'application/json',
    };

    for (let attempt = 0; ; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetchImpl(url, { ...init, headers });
      } catch {
        // The cause is dropped on purpose: it can carry the request URL or headers.
        throw new CliError(EXIT.network, `Could not reach ${this.apiUrl}. Check apiUrl and your connection.`);
      }

      if (response.status === 429 && attempt < MAX_RETRIES) {
        await sleep(retryDelayMs(response.headers.get('retry-after'), attempt));
        continue;
      }

      const text: string = await response.text();
      const body: unknown = text === '' ? {} : safeJson(text);
      if (response.ok) {
        if (typeof body === 'object' && body !== null && NOT_JSON in body) {
          throw new CliError(
            EXIT.network,
            `Unexpected non-JSON response from ${this.apiUrl}; check apiUrl in translify.json.`,
          );
        }

        return body as T;
      }

      throw explain(response.status, (typeof body === 'object' && body !== null ? body : {}) as ErrorBody);
    }
  }
}

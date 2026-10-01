import { describe, expect, it, vi } from 'vitest';

import { CliError } from './errors.js';
import { Api, retryDelayMs } from './http.js';

const reply = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const fail = async (status: number, body: unknown): Promise<CliError> => {
  const fetchImpl = vi.fn().mockResolvedValue(reply(status, body));

  return (await new Api('https://x/api', 'sk_abc', fetchImpl).get('/x').catch((caught: unknown) => caught)) as CliError;
};

describe('Api', () => {
  it('sends the bearer key and the CLI user agent', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(reply(200, { ok: true }));
    await new Api('https://x/api', 'sk_abc', fetchImpl).get('/cli/v1/whoami');

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://x/api/cli/v1/whoami');
    expect(init.headers.authorization).toBe('Bearer sk_abc');
    expect(init.headers['user-agent']).toMatch(/^translify-cli\/\d+\.\d+\.\d+$/);
  });

  it('retries a 429 up to 3 times honouring Retry-After', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(reply(429, {}, { 'retry-after': '1' }))
      .mockResolvedValueOnce(reply(429, {}))
      .mockResolvedValueOnce(reply(200, { ok: 1 }));
    const promise = new Api('https://x/api', 'sk_abc', fetchImpl).get('/cli/v1/whoami');
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toEqual({ ok: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it('gives up after 3 retries with exit 4', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn().mockImplementation(async () => reply(429, { code: 'RATE_LIMITED' }));
    const promise = new Api('https://x/api', 'sk_abc', fetchImpl)
      .get('/x')
      .catch((caught: unknown) => caught);
    await vi.runAllTimersAsync();

    expect(((await promise) as CliError).exitCode).toBe(4);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    vi.useRealTimers();
  });

  it('computes Retry-After from seconds, dates and garbage, capped', () => {
    expect(retryDelayMs('2', 0)).toBe(2000);
    expect(retryDelayMs(new Date(10_000).toUTCString(), 0, 4000)).toBe(6000);
    expect(retryDelayMs('nope', 2)).toBe(4000);
    expect(retryDelayMs(null, 0)).toBe(1000);
    expect(retryDelayMs('3600', 0)).toBe(60_000);
  });

  it.each([
    [401, { code: 'KEY_INVALID' }, 2, /not recognised/],
    [401, { code: 'KEY_REVOKED' }, 2, /revoked/i],
    [401, { code: 'KEY_WRONG_KIND' }, 2, /sk_/],
    [403, { code: 'SCOPE_MISSING', required: 'PUSH' }, 2, /PUSH/],
    [402, { code: 'QUOTA_EXCEEDED', dimension: 'translationKeys', limit: 10, current: 10 }, 3, /10/],
    [413, { code: 'PUSH_TOO_LARGE', entries: 20001, limit: 20000 }, 4, /--namespace/],
    [426, { code: 'CLI_TOO_OLD', minimum: '0.2.0' }, 4, /npm i -g @chesterbrains\/translify-cli@latest[\s\S]*0\.2\.0|0\.2\.0[\s\S]*npm i -g @chesterbrains\/translify-cli@latest/],
    [
      422,
      {
        code: 'VALIDATION_FAILED',
        errors: [
          { file: 'a.json', reason: 'invalidKey', key: 'x y' },
          { file: 'b.arb', line: 3, reason: 'bad' },
        ],
      },
      1,
      /a\.json x y: invalidKey\nb\.arb:3: bad/,
    ],
    [422, { code: 'LOCALE_NOT_FOUND', locales: ['xx', 'yy'] }, 1, /xx, yy/],
    [422, { code: 'NAMESPACE_NOT_FOUND', namespaces: ['nope'] }, 1, /nope/],
    [409, { code: 'ORPHANS_PUBLISHED', keys: ['web:a', 'web:b'], total: 2 }, 1, /web:a, web:b[\s\S]*Unpublish[\s\S]*--prune/],
    [400, { code: 'JSON_STYLE_REQUIRES_JSON' }, 1, /HTTP 400 JSON_STYLE_REQUIRES_JSON/],
    [400, { code: 'BAD_REQUEST', message: ['a must be b'] }, 1, /a must be b/],
    [404, { code: 'ENVIRONMENT_NOT_FOUND', message: 'no env' }, 1, /no env/],
    [400, { code: 'ENVIRONMENT_ARCHIVED' }, 1, /ENVIRONMENT_ARCHIVED/],
    [400, { code: 'PROJECT_ARCHIVED' }, 1, /PROJECT_ARCHIVED/],
    [500, { code: 'INTERNAL_ERROR' }, 4, /server/i],
    [500, { code: 'DATABASE_ERROR' }, 4, /server/i],
    [503, {}, 4, /server/i],
    [409, { code: 'TRANSACTION_CONFLICT' }, 4, /conflict/i],
    [400, { code: 'SOMETHING_NEW' }, 1, /SOMETHING_NEW/],
    [401, {}, 2, /HTTP 401/],
    [402, {}, 3, /HTTP 402/],
  ])('maps %i %j to exit %i', async (status, body, exit, message) => {
    const error = await fail(status, body);

    expect(error).toBeInstanceOf(CliError);
    expect(error.exitCode).toBe(exit);
    expect(error.message).toMatch(message);
  });

  it('lets the code beat the status', async () => {
    expect((await fail(422, { code: 'KEY_INVALID' })).exitCode).toBe(2);
  });

  it('maps a network failure to exit 4 without leaking the key', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('fetch failed sk_abc'));
    const error = (await new Api('https://x/api', 'sk_abc', fetchImpl).get('/x').catch((caught: unknown) => caught)) as CliError;
    expect(error.exitCode).toBe(4);
    expect(error.message).not.toContain('sk_abc');
  });

  it('posts JSON with a content type and FormData without one', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => reply(200, {}));
    const api = new Api('https://x/api/', 'sk_abc', fetchImpl);
    await api.post('/p', { a: 1 });
    await api.post('/p', new FormData());

    expect(fetchImpl.mock.calls[0]![1].headers['content-type']).toBe('application/json');
    expect(fetchImpl.mock.calls[1]![1].headers['content-type']).toBeUndefined();
    expect(fetchImpl.mock.calls[0]![0]).toBe('https://x/api/p');
  });
});

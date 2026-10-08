import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it, vi } from 'vitest';

import type { Config } from '../config.js';
import { CliError, EXIT } from '../errors.js';
import { LINT_UNSUPPORTED, lintNamespaces, parseMaxWarnings, runLint, type LintResponse } from './lint.js';

const rule = (namespace?: string) => ({
  pattern: namespace === undefined ? 'locales/{locale}/{namespace}.json' : `locales/{locale}/${namespace}.json`,
  format: 'json' as const,
  jsonStyle: 'nested' as const,
  ...(namespace === undefined ? {} : { namespace }),
});
const config = (files: ReturnType<typeof rule>[], locales: Record<string, string> = {}): Config =>
  ({ apiUrl: 'http://x', files, locales }) as unknown as Config;

const CLEAN: LintResponse = { summary: { errors: 0, warnings: 0, locales: [{ locale: 'en', errors: 0, warnings: 0 }] }, cells: [], truncated: false };
const ERRORS: LintResponse = { summary: { errors: 1, warnings: 0, locales: [{ locale: 'it', errors: 1, warnings: 0 }] }, cells: [], truncated: false };
const WARNINGS: LintResponse = { summary: { errors: 0, warnings: 2, locales: [{ locale: 'pl', errors: 0, warnings: 2 }] }, cells: [], truncated: false };

const run = async (res: LintResponse, opts: Parameters<typeof runLint>[0] = {}, cfg: Config = config([rule()])) => {
  const get = vi.fn().mockResolvedValue(res);
  const out: string[] = [];
  const code = await runLint(opts, { api: { get } as never, config: cfg, out: (line) => out.push(line) });

  return { code, get, out: stripVTControlCharacters(out.join('\n')) };
};

describe('lintNamespaces', () => {
  it('is the sorted, de-duplicated union when every rule has a fixed namespace', () => {
    expect(lintNamespaces(config([rule('shop'), rule('admin'), rule('shop')]))).toBe('admin,shop');
  });

  it('is undefined (whole project) when any rule uses {namespace}', () => {
    expect(lintNamespaces(config([rule('shop'), rule()]))).toBeUndefined();
  });

  it('is undefined with no rules', () => {
    expect(lintNamespaces(config([]))).toBeUndefined();
  });

  it('the --namespace flag wins', () => {
    expect(lintNamespaces(config([rule('shop'), rule()]), 'admin')).toBe('admin');
  });
});

describe('parseMaxWarnings', () => {
  it('accepts whole numbers from 0', () => {
    expect(parseMaxWarnings(undefined)).toBeUndefined();
    expect(parseMaxWarnings('0')).toBe(0);
    expect(parseMaxWarnings('25')).toBe(25);
  });

  it.each(['-1', '1.5', 'abc', ''])('refuses %j with exit 1', (raw) => {
    expect(() => parseMaxWarnings(raw)).toThrow(CliError);
    try {
      parseMaxWarnings(raw);
    } catch (error) {
      expect((error as CliError).exitCode).toBe(EXIT.failed);
    }
  });
});

describe('runLint', () => {
  it('sends one request with namespaces, the mapped locale, and the upper-cased severity', async () => {
    const { get } = await run(CLEAN, { locale: 'it_IT', severity: 'error' }, config([rule('shop')], { it_IT: 'it' }));

    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith('/cli/v1/lint', { namespaces: 'shop', locales: 'it', severity: 'ERROR' });
  });

  it('omits every filter when the config has a wildcard rule and no flags are given', async () => {
    const { get } = await run(CLEAN);

    expect(get).toHaveBeenCalledWith('/cli/v1/lint', {});
  });

  it('exits 0 on a clean project', async () => {
    const { code, out } = await run(CLEAN);

    expect(code).toBe(EXIT.ok);
    expect(out).toBe('✔ No issues in 1 locale(s).');
  });

  it('exits 6 when there are errors', async () => {
    expect((await run(ERRORS)).code).toBe(6);
    expect(EXIT.issues).toBe(6);
  });

  it('exits 0 on warnings unless --max-warnings is exceeded', async () => {
    expect((await run(WARNINGS)).code).toBe(EXIT.ok);
    expect((await run(WARNINGS, { maxWarnings: '2' })).code).toBe(EXIT.ok);
    expect((await run(WARNINGS, { maxWarnings: '1' })).code).toBe(EXIT.issues);
    expect((await run(WARNINGS, { maxWarnings: '0' })).code).toBe(EXIT.issues);
  });

  it('--severity error with --max-warnings 0 fails on hidden warnings and says why', async () => {
    const { code, out } = await run(WARNINGS, { severity: 'error', maxWarnings: '0' });

    expect(code).toBe(EXIT.issues);
    expect(out).toContain('0 errors, 2 warnings');
  });

  it('refuses a bad --max-warnings before any request', async () => {
    const get = vi.fn();
    await expect(
      runLint({ maxWarnings: 'x' }, { api: { get } as never, config: config([rule()]), out: () => undefined }),
    ).rejects.toMatchObject({ exitCode: EXIT.failed });
    expect(get).not.toHaveBeenCalled();
  });

  it('--json prints one document: the response plus a summary', async () => {
    const get = vi.fn().mockResolvedValue(ERRORS);
    const out: string[] = [];
    const code = await runLint({ json: true }, { api: { get } as never, config: config([rule()]), out: (line) => out.push(line) });

    expect(code).toBe(EXIT.issues);
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0]!)).toEqual({ response: ERRORS, summary: { errors: 1, warnings: 0, truncated: false } });
  });

  it('explains a server too old for lint (plain 404, no code)', async () => {
    const get = vi.fn().mockRejectedValue(
      new CliError(EXIT.failed, 'Cannot GET /api/cli/v1/lint', { statusCode: 404, message: 'Cannot GET /api/cli/v1/lint', error: 'Not Found' }),
    );

    await expect(
      runLint({}, { api: { get } as never, config: config([rule()]), out: () => undefined }),
    ).rejects.toMatchObject({ exitCode: EXIT.failed, message: LINT_UNSUPPORTED });
  });

  it('passes through a 404 or 422 that carries a code, such as an unknown namespace', async () => {
    const coded = new CliError(EXIT.failed, 'Unknown namespace(s): shpo.', { statusCode: 422, code: 'NAMESPACE_NOT_FOUND' });
    const get = vi.fn().mockRejectedValue(coded);

    await expect(
      runLint({ namespace: 'shpo' }, { api: { get } as never, config: config([rule()]), out: () => undefined }),
    ).rejects.toBe(coded);
  });
});

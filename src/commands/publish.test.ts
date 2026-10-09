import { stripVTControlCharacters } from 'node:util';

import { describe, expect, it, vi } from 'vitest';

import type { Config } from '../config.js';
import { CliError } from '../errors.js';

import { runPublish } from './publish.js';

const RESPONSE = { environmentId: 'e1', publishedCount: 42, publishedAt: '2026-10-01T10:00:00.000Z' };

describe('runPublish', () => {
  it('posts the environment and prints the count', async () => {
    const post = vi.fn().mockResolvedValue(RESPONSE);
    const out: string[] = [];
    const code = await runPublish('production', { api: { post } as never, out: (line) => out.push(line) });

    expect(code).toBe(0);
    expect(post).toHaveBeenCalledWith('/cli/v1/publish', { environment: 'production' });
    expect(out.join('\n')).toMatch(/Published 42 translation\(s\) to production/);
  });

  it('--json prints the raw response plus a summary', async () => {
    const post = vi.fn().mockResolvedValue(RESPONSE);
    const out: string[] = [];
    await runPublish('staging', { api: { post } as never, out: (line) => out.push(line), json: true });

    expect(JSON.parse(out[0]!)).toEqual({
      response: RESPONSE,
      summary: { environment: 'staging', publishedCount: 42, carriedOverCount: 0, withheldCount: 0, errorCount: 0 },
    });
  });

  it('reports carried-over and withheld counts when a gated environment has them', async () => {
    const post = vi.fn().mockResolvedValue({ ...RESPONSE, carriedOverCount: 14, withheldCount: 3 });
    const out: string[] = [];
    const code = await runPublish('production', { api: { post } as never, out: (line) => out.push(line) });

    expect(code).toBe(0);
    expect(out.join('\n')).toBe('Published 42 translation(s) to production. 14 carried over, 3 withheld.');
  });

  it('prints no gate counts when both are 0 or missing (older server)', async () => {
    for (const res of [{ ...RESPONSE, carriedOverCount: 0, withheldCount: 0 }, RESPONSE]) {
      const out: string[] = [];
      await runPublish('production', { api: { post: vi.fn().mockResolvedValue(res) } as never, out: (line) => out.push(line) });

      expect(out.join('\n')).toBe('Published 42 translation(s) to production.');
    }
  });

  it('--fail-on-withheld exits 5 after printing when cells were withheld', async () => {
    const post = vi.fn().mockResolvedValue({ ...RESPONSE, carriedOverCount: 0, withheldCount: 3 });
    const out: string[] = [];
    const code = await runPublish('production', {
      api: { post } as never,
      out: (line) => out.push(line),
      failOnWithheld: true,
    });

    expect(code).toBe(5);
    expect(out.join('\n')).toMatch(/3 withheld/);
  });

  it('--fail-on-withheld exits 0 when nothing was withheld', async () => {
    const post = vi.fn().mockResolvedValue({ ...RESPONSE, carriedOverCount: 2, withheldCount: 0 });
    const code = await runPublish('production', { api: { post } as never, out: () => undefined, failOnWithheld: true });

    expect(code).toBe(0);
  });

  it('withheld cells without --fail-on-withheld still exit 0', async () => {
    const post = vi.fn().mockResolvedValue({ ...RESPONSE, carriedOverCount: 0, withheldCount: 3 });

    expect(await runPublish('production', { api: { post } as never, out: () => undefined })).toBe(0);
  });

  it('--json summary carries the gate and error counts, 0 when missing', async () => {
    const post = vi.fn().mockResolvedValue(RESPONSE);
    const out: string[] = [];
    await runPublish('staging', { api: { post } as never, out: (line) => out.push(line), json: true });

    expect(JSON.parse(out[0]!).summary).toEqual({
      environment: 'staging',
      publishedCount: 42,
      carriedOverCount: 0,
      withheldCount: 0,
      errorCount: 0,
    });
  });

  it('--allow-errors sends allowErrors; without it the body is unchanged', async () => {
    const post = vi.fn().mockResolvedValue(RESPONSE);
    await runPublish('production', { api: { post } as never, out: () => undefined, allowErrors: true });

    expect(post).toHaveBeenCalledWith('/cli/v1/publish', { environment: 'production', allowErrors: true });
  });

  it('reports translations published with placeholder errors, in text and JSON', async () => {
    const res = { ...RESPONSE, errorCount: 2 };
    const out: string[] = [];
    await runPublish('production', { api: { post: vi.fn().mockResolvedValue(res) } as never, out: (line) => out.push(line) });
    await runPublish('production', {
      api: { post: vi.fn().mockResolvedValue(res) } as never,
      out: (line) => out.push(line),
      json: true,
    });

    expect(out[0]).toBe('Published 42 translation(s) to production. 2 with placeholder errors.');
    expect(JSON.parse(out[1]!).summary).toMatchObject({ errorCount: 2 });
  });

  describe('refused with INVALID_CELLS', () => {
    const config = { apiUrl: 'http://x', files: [], locales: { it_IT: 'it' } } as unknown as Config;
    const missing = { code: 'PLACEHOLDER_MISSING', severity: 'ERROR', arg: 'name' };
    const body = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
      statusCode: 422,
      code: 'INVALID_CELLS',
      message: '2 cell(s) have placeholder errors',
      total: 2,
      cells: [
        { namespace: 'shop', key: 'cart.title', locale: 'it', issues: [missing] },
        { namespace: 'shop', key: 'cart.total', locale: 'en', issues: [{ code: 'ICU_INVALID', severity: 'ERROR', message: 'EXPECT_ARGUMENT_CLOSING_BRACE' }] },
      ],
      ...over,
    });
    const refuse = async (b: Record<string, unknown>): Promise<CliError> =>
      (await runPublish('production', {
        api: { post: vi.fn().mockRejectedValue(new CliError(6, 'raw', b)) } as never,
        out: () => undefined,
        config,
      }).catch((caught: unknown) => caught)) as CliError;

    it('exits 6 and lists the cells with the locale as named on disk', async () => {
      const error: CliError = await refuse(body());

      expect(error).toBeInstanceOf(CliError);
      expect(error.exitCode).toBe(6);
      const text: string = stripVTControlCharacters(error.message);
      expect(text).toContain('Publish refused: 2 translation(s) with placeholder errors would go live. Nothing was published.');
      expect(text).toMatch(/shop\n {2}cart\.title\n {4}it_IT +error +missing placeholder \{name\}/);
      expect(text).toMatch(/ {2}cart\.total\n {4}en +error +invalid ICU: EXPECT_ARGUMENT_CLOSING_BRACE/);
      expect(text).toContain('Fix them (translify lint lists every issue) or re-run with --allow-errors.');
      expect(text).not.toContain('Showing first');
    });

    it('says how many it could not list when the server capped the cells', async () => {
      const text: string = stripVTControlCharacters((await refuse(body({ total: 250 }))).message);

      expect(text).toContain('Showing first 2 of 250.');
    });

    it('passes any other error through untouched', async () => {
      const other: CliError = new CliError(1, 'No environment nope', { code: 'ENVIRONMENT_NOT_FOUND' });
      const caught: unknown = await runPublish('nope', {
        api: { post: vi.fn().mockRejectedValue(other) } as never,
        out: () => undefined,
        config,
      }).catch((e: unknown) => e);

      expect(caught).toBe(other);
    });
  });
});

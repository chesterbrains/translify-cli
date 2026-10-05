import { describe, expect, it, vi } from 'vitest';

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
      summary: { environment: 'staging', publishedCount: 42, carriedOverCount: 0, withheldCount: 0 },
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

  it('--json summary carries the gate counts, 0 when missing', async () => {
    const post = vi.fn().mockResolvedValue(RESPONSE);
    const out: string[] = [];
    await runPublish('staging', { api: { post } as never, out: (line) => out.push(line), json: true });

    expect(JSON.parse(out[0]!).summary).toEqual({
      environment: 'staging',
      publishedCount: 42,
      carriedOverCount: 0,
      withheldCount: 0,
    });
  });
});

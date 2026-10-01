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
      summary: { environment: 'staging', publishedCount: 42 },
    });
  });
});

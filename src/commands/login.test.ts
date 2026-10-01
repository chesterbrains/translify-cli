import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { runLogin, type LoginDeps } from './login.js';

const setup = async (
  key: string,
  fetchImpl: typeof fetch,
  isTty = true,
): Promise<{ d: LoginDeps; out: string[]; home: string }> => {
  const home: string = await mkdtemp(join(tmpdir(), 'tfy-home-'));
  const out: string[] = [];
  const d: LoginDeps = {
    isTty,
    promptSecret: async () => key,
    out: (line) => out.push(line),
    apiUrl: 'https://example.test/api',
    env: { XDG_CONFIG_HOME: home },
    fetchImpl,
  };

  return { d, out, home };
};

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status });

describe('runLogin', () => {
  it('checks the key, prints project and scopes, saves it, never echoes it', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      json(200, { project: { name: 'Acme', slug: 'acme', defaultLocale: 'en' }, key: { name: 'ci', prefix: 'sk_abc', scopes: ['PULL', 'PUSH'] }, locales: ['en'] }),
    );
    const { d, out, home } = await setup('sk_secretvalue', fetchImpl as never);

    expect(await runLogin(d)).toBe(0);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://example.test/api/cli/v1/whoami');
    const path: string = join(home, 'translify', 'credentials');
    expect(await readFile(path, 'utf8')).toBe('sk_secretvalue\n');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const text: string = out.join('\n');
    expect(text).toContain('Logged in to Acme (acme) with scopes PULL, PUSH. Saved to');
    expect(text).toContain(path);
    expect(text).not.toContain('sk_secretvalue');
  });

  it('refuses a pk_ key before any network call', async () => {
    const fetchImpl = vi.fn();
    const { d } = await setup('pk_publishable', fetchImpl as never);

    await expect(runLogin(d)).rejects.toMatchObject({ exitCode: 2, message: expect.stringMatching(/delivery/) });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses any non-sk_ value without calling fetch', async () => {
    const fetchImpl = vi.fn();
    const { d } = await setup('garbage', fetchImpl as never);

    await expect(runLogin(d)).rejects.toMatchObject({ exitCode: 2 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([401, 403])('does not save the key on %i', async (status) => {
    const fetchImpl = vi.fn().mockResolvedValue(json(status, { code: 'KEY_INVALID' }));
    const { d, home } = await setup('sk_secretvalue', fetchImpl as never);

    await expect(runLogin(d)).rejects.toMatchObject({ exitCode: 2 });
    await expect(stat(join(home, 'translify', 'credentials'))).rejects.toThrow();
  });

  it('needs a TTY and never prompts without one', async () => {
    const fetchImpl = vi.fn();
    const { d, out } = await setup('sk_x', fetchImpl as never, false);
    const promptSecret = vi.fn();

    expect(await runLogin({ ...d, promptSecret })).toBe(1);
    expect(promptSecret).not.toHaveBeenCalled();
    expect(out.join('\n')).toMatch(/TRANSLIFY_SECRET_KEY/);
  });
});

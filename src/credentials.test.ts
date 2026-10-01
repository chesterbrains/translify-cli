import { mkdtemp, readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { credentialsPath, resolveKey, saveKey } from './credentials.js';
import { CliError } from './errors.js';

const tempEnv = async (): Promise<{ XDG_CONFIG_HOME: string }> => ({
  XDG_CONFIG_HOME: await mkdtemp(join(tmpdir(), 'tfy-home-')),
});

describe('credentials', () => {
  it('prefers the env var', async () => {
    expect(await resolveKey({ TRANSLIFY_SECRET_KEY: 'sk_env' })).toBe('sk_env');
  });

  it('prefers the env var over the file', async () => {
    const env = await tempEnv();
    await saveKey('sk_saved', env);
    expect(await resolveKey({ ...env, TRANSLIFY_SECRET_KEY: 'sk_env' })).toBe('sk_env');
  });

  it('refuses a publishable key with a hint', async () => {
    await expect(resolveKey({ TRANSLIFY_SECRET_KEY: 'pk_abc' })).rejects.toThrow(/pk_ keys are for delivery/);
  });

  it('refuses a non-sk_ value without echoing it', async () => {
    const error = (await resolveKey({ TRANSLIFY_SECRET_KEY: 'hunter2' }).catch((e: unknown) => e)) as CliError;
    expect(error.exitCode).toBe(2);
    expect(error.message).not.toContain('hunter2');
  });

  it('exits 2 when there is no key anywhere', async () => {
    const error = (await resolveKey(await tempEnv()).catch((e: unknown) => e)) as CliError;
    expect(error.exitCode).toBe(2);
    expect(error.message).toMatch(/TRANSLIFY_SECRET_KEY/);
  });

  it('refuses a bad stored value', async () => {
    const env = await tempEnv();
    const path = credentialsPath(env);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, 'nonsense\n');
    await expect(resolveKey(env)).rejects.toThrow(/sk_/);
  });

  it('saves with 0600 in a 0700 directory and reads it back', async () => {
    const env = await tempEnv();
    const path = await saveKey('sk_saved', env);

    expect(path).toBe(credentialsPath(env));
    expect((await readFile(path, 'utf8')).trim()).toBe('sk_saved');
    if (process.platform !== 'win32') {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
    }
    expect(await resolveKey(env)).toBe('sk_saved');
  });

  it('refuses to save a non-secret key', async () => {
    await expect(saveKey('pk_x', await tempEnv())).rejects.toThrow(/pk_ keys are for delivery/);
  });
});

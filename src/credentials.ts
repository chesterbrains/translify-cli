import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

import { CliError, EXIT } from './errors.js';

type Env = Record<string, string | undefined>;

export function credentialsPath(env: Env = process.env): string {
  // Empty or relative values would resolve against the cwd (often a repo); ignore them, as the XDG spec says.
  const absolute = (value: string | undefined): string | undefined =>
    value !== undefined && isAbsolute(value) ? value : undefined;
  const appData: string | undefined = absolute(env.APPDATA);
  if (process.platform === 'win32' && appData !== undefined) return join(appData, 'translify', 'credentials');

  return join(absolute(env.XDG_CONFIG_HOME) ?? join(homedir(), '.config'), 'translify', 'credentials');
}

// Messages never echo the value: a mistyped key is still a secret.
const assertSecret = (key: string): string => {
  if (key.startsWith('pk_')) {
    throw new CliError(
      EXIT.auth,
      'That is a publishable key: pk_ keys are for delivery. Create a secret (sk_) key in Translify.',
    );
  }
  if (!key.startsWith('sk_')) throw new CliError(EXIT.auth, 'Not a Translify secret key (expected sk_...).');

  return key;
};

export async function resolveKey(env: Env = process.env): Promise<string> {
  const fromEnv: string | undefined = env.TRANSLIFY_SECRET_KEY?.trim();
  if (fromEnv) return assertSecret(fromEnv);

  let stored: string;
  try {
    stored = (await readFile(credentialsPath(env), 'utf8')).trim();
  } catch {
    throw new CliError(EXIT.auth, 'No key. Set TRANSLIFY_SECRET_KEY or run `translify login`.');
  }
  if (stored === '') throw new CliError(EXIT.auth, 'No key. Set TRANSLIFY_SECRET_KEY or run `translify login`.');

  return assertSecret(stored);
}

export async function saveKey(key: string, env: Env = process.env): Promise<string> {
  const path: string = credentialsPath(env);
  const secret: string = assertSecret(key.trim());
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  // Temp file created 0600, then renamed over the target: never world-readable, never truncated.
  const temp: string = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temp, `${secret}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }

  return path;
}

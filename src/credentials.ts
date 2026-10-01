import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { CliError, EXIT } from './errors.js';

type Env = Record<string, string | undefined>;

export function credentialsPath(env: Env = process.env): string {
  if (process.platform === 'win32' && env.APPDATA !== undefined) return join(env.APPDATA, 'translify', 'credentials');

  return join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'translify', 'credentials');
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
  await writeFile(path, `${secret}\n`, { mode: 0o600 });
  await chmod(path, 0o600);

  return path;
}

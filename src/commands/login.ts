import type { ExitCode } from '../errors.js';
import { assertSecret, saveKey } from '../credentials.js';
import { EXIT } from '../errors.js';
import { Api } from '../http.js';

interface LoginWhoami {
  project: { name: string; slug: string };
  key: { scopes: string[] };
}

export interface LoginDeps {
  isTty: boolean;
  /** Masked input; resolves to what the user typed. */
  promptSecret: () => Promise<string>;
  out: (line: string) => void;
  apiUrl: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

export async function runLogin(deps: LoginDeps): Promise<ExitCode> {
  if (!deps.isTty) {
    deps.out('`translify login` needs an interactive terminal. In CI, set TRANSLIFY_SECRET_KEY instead.');

    return EXIT.failed;
  }

  const key: string = (await deps.promptSecret()).trim();
  // Before any network call, and the error never echoes the value.
  assertSecret(key);

  const api: Api = new Api(deps.apiUrl, key, deps.fetchImpl);
  // A 401/403 throws here, so a rejected key is never saved.
  const me: LoginWhoami = await api.get<LoginWhoami>('/cli/v1/whoami');
  const path: string = await saveKey(key, deps.env);
  deps.out(`Logged in to ${me.project.name} (${me.project.slug}) with scopes ${me.key.scopes.join(', ')}. Saved to ${path}.`);

  return EXIT.ok;
}

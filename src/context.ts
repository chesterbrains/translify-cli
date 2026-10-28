import type { Config } from './config.js';
import type { Api } from './http.js';
import type { PathContext } from './patterns.js';

interface WhoamiDefault {
  project: { defaultLocale: string | null };
}

/** Android's `values/` is the default locale, which only the server knows: one `whoami`, only for such rules. */
export async function pathContext(config: Config, api: Api): Promise<PathContext> {
  if (!config.files.some((rule) => rule.format === 'android')) return {};
  const { project }: WhoamiDefault = await api.get<WhoamiDefault>('/cli/v1/whoami');

  return { defaultLocale: project.defaultLocale ?? undefined };
}

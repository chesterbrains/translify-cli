import type { Config } from './config.js';
import type { Api } from './http.js';
import type { PathContext } from './patterns.js';

interface WhoamiContext {
  project?: { defaultLocale: string | null };
  /** Enabled locale codes; absent on an older server. */
  locales?: string[];
}

/**
 * One `whoami`, only when a rule needs it: Android's `values/` is the default locale, which only the server knows,
 * and an aliased Rails YAML pull sends only the aliases of locales the project has.
 */
export async function pathContext(config: Config, api: Api): Promise<PathContext> {
  const android: boolean = config.files.some((rule) => rule.format === 'android');
  const rails: boolean = Object.keys(config.locales).length > 0 && config.files.some((rule) => rule.format === 'yaml');
  if (!android && !rails) return {};

  let me: WhoamiContext;
  try {
    me = await api.get<WhoamiContext>('/cli/v1/whoami');
  } catch (error) {
    // Only the alias filter is optional; Android cannot work without the default locale.
    if (android) throw error;

    return {};
  }

  return {
    ...(android ? { defaultLocale: me.project?.defaultLocale ?? undefined } : {}),
    ...(Array.isArray(me.locales) ? { locales: me.locales } : {}),
  };
}

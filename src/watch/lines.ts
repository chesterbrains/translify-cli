import type { PushResponse } from '../commands/push.js';
import { safeCount, safeText } from '../safe-text.js';

const two = (value: number): string => String(value).padStart(2, '0');

/** Local `HH:MM:SS`. */
export const stamp = (date: Date): string => `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;

/** Lines under a stamped one start below its text: the width of `HH:MM:SS `. */
export const INDENT: string = ' '.repeat(9);

const keysUpdatedOf = (res: PushResponse): number => Number(res.keysUpdated) || 0;
const keysUpdatedText = (count: number): string => `${safeCount(count)} key(s) updated (description or metadata)`;

/** `app: 2 created, 1 updated`, from the source locale's counts; `app: unchanged` when it wrote nothing or the locale is absent. */
export const pushLine = (namespace: string, res: PushResponse, sourceLocale: string): string => {
  // Read defensively: a proxy's 200 is not always the server's answer.
  const counts: PushResponse['locales'][string] | undefined = res.locales?.[sourceLocale];
  const parts: string[] = [];
  if (counts !== undefined && counts.created !== 0) parts.push(`${safeCount(counts.created)} created`);
  if (counts !== undefined && counts.updated !== 0) parts.push(`${safeCount(counts.updated)} updated`);
  // The one write the cell counts do not show: without it a description-only save would read as unchanged.
  if (keysUpdatedOf(res) > 0) parts.push(keysUpdatedText(keysUpdatedOf(res)));

  return `${safeText(namespace)}: ${parts.length === 0 ? 'unchanged' : parts.join(', ')}`;
};

/** What a push has to add beyond its counts; the wording of the plain push where one exists. */
export const followUps = (res: PushResponse): string[] => {
  const lines: string[] = (Array.isArray(res.warnings) ? res.warnings : []).map((warning) => `warning: ${safeText(warning)}`);
  const stale: number = res.staleReset ?? 0;
  if (stale > 0) lines.push(`${safeCount(stale)} approved translation(s) went back to review because their source text changed.`);
  const restored: number = res.keysRestored ?? 0;
  if (restored > 0) lines.push(`Restored ${safeCount(restored)} key(s) from the trash.`);

  return lines;
};

export const orphanNote = (namespace: string, count: number): string =>
  `${count} key(s) in Translify are not in your source files (${safeText(namespace)}). Run translify push --prune when done.`;

/** One line for the push of everything a watch starts with. */
export const startSummary = (results: PushResponse[], sourceLocale: string): string => {
  const sum = (field: 'created' | 'updated' | 'unchanged'): number =>
    results.reduce((total, res) => total + (Number(res.locales?.[sourceLocale]?.[field]) || 0), 0);

  const keys: number = results.reduce((total, res) => total + keysUpdatedOf(res), 0);

  return `pushed ${results.length} namespace(s): ${sum('created')} created, ${sum('updated')} updated, ${sum('unchanged')} unchanged${
    keys > 0 ? `, ${keysUpdatedText(keys)}` : ''
  }`;
};

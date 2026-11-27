import type { ExitCode } from '../errors.js';
import type { PathContext } from '../patterns.js';
import type { SessionDeps, TickResult } from '../watch/session.js';
import type { PushOptions } from './push.js';
import { EXIT } from '../errors.js';
import { findFiles } from '../patterns.js';
import { safeText } from '../safe-text.js';
import { WatchSession } from '../watch/session.js';

export const DEFAULT_DEBOUNCE_MS: number = 2000;
export const MIN_DEBOUNCE_MS: number = 500;
export const TICK_MS: number = 500;
/** What a second Ctrl-C exits with: 128 + SIGINT. */
const INTERRUPTED: number = 130;

export interface WatchDeps extends Omit<SessionDeps, 'stopping'> {
  /** Epoch milliseconds, comparable with a file's `mtimeMs`. */
  now: () => number;
  /** `done` resolves after `ms`, or at once when `wake` is called. */
  sleep: (ms: number) => { done: Promise<void>; wake: () => void };
  /** Registers the handler for SIGINT and SIGTERM; returns a function that removes it. */
  onSignal: (handler: () => void) => () => void;
  /** `process.exit`. */
  exit: (code: number) => void;
}

interface Whoami {
  project?: { defaultLocale: string | null };
  locales?: string[];
}

const REFUSED: Array<[keyof PushOptions, string, string]> = [
  ['prune', '--prune', 'nothing is archived without a person confirming it'],
  ['overwriteTargets', '--overwrite-targets', 'a watch pushes source files only and never overwrites translations'],
  ['dryRun', '--dry-run', 'a watch exists to write'],
  ['json', '--json', 'a watch prints lines as it goes, not one document'],
];

const debounceOf = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return DEFAULT_DEBOUNCE_MS;
  if (!/^\d+$/.test(raw)) return undefined;
  const ms: number = Number(raw);

  return ms >= MIN_DEBOUNCE_MS ? ms : undefined;
};

/** The refusal line, or undefined when the flags are fine. */
export const watchRefusal = (opts: PushOptions): string | undefined => {
  if (opts.watch !== true) return opts.debounce === undefined ? undefined : '--debounce needs --watch.';
  for (const [flag, name, why] of REFUSED) {
    if (opts[flag] === true) return `--watch cannot be combined with ${name}: ${why}.`;
  }
  if (debounceOf(opts.debounce) === undefined) {
    return `--debounce must be a whole number of milliseconds, at least ${MIN_DEBOUNCE_MS}.`;
  }

  return undefined;
};

/** Poll every 500 ms, but never spend more than a tenth of the time globbing (a `**` over a big tree). */
export const tickDelay = (lastScanMs: number): number => Math.max(TICK_MS, Math.ceil(lastScanMs * 10));

/**
 * `translify push --watch`: push every source-locale file once, then again whenever one changes, until a
 * signal. The state and every rule live in `WatchSession`; this owns the clock, the sleep and the signals.
 */
export async function runWatch(opts: PushOptions, deps: WatchDeps): Promise<ExitCode> {
  const refusal: string | undefined = watchRefusal(opts);
  if (refusal !== undefined) {
    deps.err(refusal);

    return EXIT.failed;
  }

  const me: Whoami = await deps.api.get<Whoami>('/cli/v1/whoami');
  const defaultLocale: string | null = me.project?.defaultLocale ?? null;
  if (defaultLocale === null) {
    deps.err('This project has no default locale; set one in Translify, then run translify push --watch again.');

    return EXIT.failed;
  }
  const context: PathContext = { defaultLocale, ...(Array.isArray(me.locales) ? { locales: me.locales } : {}) };

  // A broken rule set fails here as it does for a plain push; once the watch runs, the same error only skips a poll.
  await (deps.find ?? findFiles)(deps.config, deps.cwd, context);

  let stopping: boolean = false;
  let wake: () => void = () => undefined;
  const session: WatchSession = new WatchSession(
    { namespace: opts.namespace, status: opts.status, debounceMs: debounceOf(opts.debounce) ?? DEFAULT_DEBOUNCE_MS },
    { ...deps, stopping: () => stopping },
    { defaultLocale, context },
  );

  await session.scan(deps.now());
  // Something broke between the check above and the first poll, and the poll has said what.
  if (session.problem !== undefined) return EXIT.failed;
  if (session.files.length === 0) {
    const scope: string = opts.namespace === undefined ? '' : ` for namespace "${opts.namespace}"`;
    deps.err(`No files matched the translify.json patterns for the source locale ${safeText(defaultLocale)}${scope}.`);

    return EXIT.failed;
  }

  const removeHandlers: () => void = deps.onSignal(() => {
    // The second signal does not wait for anything.
    if (stopping) deps.exit(INTERRUPTED);
    stopping = true;
    wake();
  });
  try {
    const namespaces: number = new Set(session.files.map((match) => match.namespace)).size;
    deps.out(`Watching ${session.files.length} source file(s) (${safeText(defaultLocale)}) in ${namespaces} namespace(s). Ctrl-C to stop.`);

    let result: TickResult = await session.tick(deps.now(), true);
    while (result === 'continue' && !stopping) {
      const nap = deps.sleep(tickDelay(session.lastScanMs));
      wake = nap.wake;
      await nap.done;
      if (stopping) break;
      result = await session.tick(deps.now());
    }

    return result === 'continue' ? EXIT.ok : result;
  } finally {
    removeHandlers();
  }
}

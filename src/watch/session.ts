import { createHash } from 'node:crypto';

import type { PushResponse, PushStatusFlag, Upload } from '../commands/push.js';
import type { Config } from '../config.js';
import type { ExitCode } from '../errors.js';
import type { Api } from '../http.js';
import type { Match, PathContext } from '../patterns.js';
import { buildForm, PUSH_PATH } from '../commands/push.js';
import { CliError, EXIT } from '../errors.js';
import { findFiles } from '../patterns.js';
import { safeText } from '../safe-text.js';
import { followUps, INDENT, orphanNote, pushLine, stamp, startSummary } from './lines.js';
import { watchVerdict } from './verdict.js';

export interface WatchOptions {
  namespace?: string;
  status?: PushStatusFlag;
  /** Quiet time after the last change before a push. */
  debounceMs: number;
}

export interface FileStat {
  mtimeMs: number;
  size: number;
}

export interface SessionDeps {
  cwd: string;
  config: Config;
  api: Api;
  out: (line: string) => void;
  err: (line: string) => void;
  /** Wall clock for the line prefix only; all logic uses the `nowMs` passed in. */
  clock: () => Date;
  /** Undefined when the file is missing. Paths are relative to `cwd`, as `findFiles` returns them. */
  stat: (path: string) => Promise<FileStat | undefined>;
  /** Rejects when the file is missing or unreadable. */
  read: (path: string) => Promise<Uint8Array<ArrayBuffer>>;
  /** True once a stop signal arrived: no new request is started. */
  stopping: () => boolean;
  /** `findFiles`, replaceable in tests. */
  find?: typeof findFiles;
}

interface Seen extends FileStat {
  hash: string;
  namespace: string;
  /** Not there at the last poll. Gone for good only when the next poll misses it too. */
  missing?: boolean;
}

/** One push pass: its time, and the backoff it has set, if any. */
interface Attempt {
  nowMs: number;
  retry: { step: number; delay: number } | undefined;
}

interface Whoami {
  project?: { defaultLocale: string | null };
}

/** `continue`, or the exit code the watch ends with. */
export type TickResult = 'continue' | ExitCode;

/** Wait before the same push is sent again; the last one repeats. */
export const BACKOFF_MS: readonly number[] = [2000, 5000, 15_000, 30_000];

/** A file this young may be saved again inside the file system's mtime granularity: never trust its stat. */
const YOUNG_MS: number = 3000;

export const hashOf = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/**
 * Everything a watch remembers. Time is a number the caller passes (epoch milliseconds, comparable with
 * a file's `mtimeMs`), so the loop that owns the real clock stays outside and tests need no timers.
 */
export class WatchSession {
  /** Namespaces with a change not yet pushed (or refused). */
  readonly dirty: Set<string> = new Set();
  /** Source matches of the last clean scan. */
  files: readonly Match[] = [];
  /** How long the last scan took, for the loop's stretch. */
  lastScanMs: number = 0;
  /** Why the last poll could not list the files (a rule clash, a file-system error); undefined after a clean one. */
  problem: string | undefined;

  /** What the last scan saw, by path. */
  private seen: Map<string, Seen> = new Map();
  private lastChangeAt: number = 0;
  private retryAttempt: number = 0;
  private retryAt: number = 0;
  /** Paths already reported as unreadable. */
  private readonly unreadable: Set<string> = new Set();
  /** Per namespace, the hash of each file last sent and answered (accepted or refused): those bytes are not sent again. */
  private readonly attempted: Map<string, Map<string, string>> = new Map();
  /** Per namespace, the orphan count last told. */
  private readonly orphans: Map<string, number> = new Map();

  constructor(
    private readonly opts: WatchOptions,
    private readonly deps: SessionDeps,
    private readonly source: { defaultLocale: string; context: PathContext },
  ) {}

  private line(text: string): string {
    return `${stamp(this.deps.clock())} ${text}`;
  }

  /** One poll: re-glob, stat, hash what moved. Returns the namespaces it marked dirty. */
  async scan(nowMs: number): Promise<string[]> {
    const started: number = performance.now();
    try {
      return await this.poll(nowMs);
    } finally {
      this.lastScanMs = performance.now() - started;
    }
  }

  private async poll(nowMs: number): Promise<string[]> {
    let matches: Match[];
    try {
      matches = (await (this.deps.find ?? findFiles)(this.deps.config, this.deps.cwd, this.source.context)).filter(
        (match) =>
          match.locale === this.source.defaultLocale && (this.opts.namespace === undefined || match.namespace === this.opts.namespace),
      );
    } catch (error) {
      // A rule clash, or the file system itself (a folder unreadable mid-checkout): never the end of the watch.
      const message: string =
        error instanceof CliError ? error.message : `Could not list the project files: ${error instanceof Error ? error.message : String(error)}`;
      // It would otherwise print on every poll: say it once, and again only when it changes or comes back.
      if (message !== this.problem) this.deps.err(this.line(message));
      this.problem = message;

      return [];
    }
    this.problem = undefined;

    const next: Map<string, Seen> = new Map();
    const kept: Match[] = [];
    const marked: Set<string> = new Set();
    for (const match of matches) {
      const stat: FileStat | undefined = await this.deps.stat(match.path);
      // Gone between the glob and the stat: the same as not matched.
      if (stat === undefined) continue;
      const before: Seen | undefined = this.seen.get(match.path);
      const settled: boolean =
        before !== undefined && before.mtimeMs === stat.mtimeMs && before.size === stat.size && nowMs - stat.mtimeMs >= YOUNG_MS;
      let hash: string;
      if (settled) hash = before!.hash;
      else {
        try {
          hash = hashOf(await this.deps.read(match.path));
        } catch (error) {
          this.cannotRead(match.path, error);
          // Keep what was known; a later poll that can read it sees the change.
          if (before !== undefined) {
            next.set(match.path, { ...before, missing: false });
            kept.push(match);
          }
          continue;
        }
        this.unreadable.delete(match.path);
      }
      next.set(match.path, { ...stat, hash, namespace: match.namespace });
      kept.push(match);
      if (before === undefined || before.hash !== hash) marked.add(match.namespace);
    }

    const present: Set<string> = new Set([...next.values()].map((file) => file.namespace));
    const emptied: Set<string> = new Set();
    const waiting: Array<[string, Seen]> = [];
    for (const [path, before] of this.seen) {
      if (next.has(path)) continue;
      // One miss may be the gap between a delete and a write (an editor, a checkout): wait for the next poll.
      if (before.missing !== true) waiting.push([path, { ...before, missing: true }]);
      else if (present.has(before.namespace)) marked.add(before.namespace);
      else emptied.add(before.namespace);
    }
    for (const [path, file] of waiting) next.set(path, file);
    for (const namespace of emptied) {
      // Another of its files may still be waiting for its second miss.
      if (waiting.some(([, file]) => file.namespace === namespace)) continue;
      // Its last source file went away: nothing to push, and an empty push would only list every key as an orphan.
      this.dirty.delete(namespace);
      this.deps.out(this.line(`${safeText(namespace)}: no source file left, nothing pushed`));
    }

    this.seen = next;
    this.files = kept;
    if (marked.size > 0) {
      for (const namespace of marked) this.dirty.add(namespace);
      this.lastChangeAt = nowMs;
      // A new save is a new push: whatever was being retried starts over.
      this.retryAttempt = 0;
      this.retryAt = 0;
    }

    return [...marked];
  }

  /** Said once per path, until it was read again. */
  private cannotRead(path: string, error: unknown): void {
    if (this.unreadable.has(path)) return;
    this.unreadable.add(path);
    const code: unknown = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
    const why: string = typeof code === 'string' ? code : error instanceof Error ? error.message : String(error);
    this.deps.err(this.line(`${safeText(path)} cannot be read (${safeText(why)}); it is not pushed until it can be.`));
  }

  /** One poll, then a push when one is due. `immediate` skips the quiet period: the push a watch starts with. */
  async tick(nowMs: number, immediate: boolean = false): Promise<TickResult> {
    await this.scan(nowMs);
    // The file list could not be read (the poll said why): pushing from the previous one could send half a state.
    if (this.problem !== undefined || this.deps.stopping()) return 'continue';
    if (this.dirty.size === 0 || nowMs < this.retryAt) return 'continue';
    if (!immediate && nowMs - this.lastChangeAt < this.opts.debounceMs) return 'continue';

    return this.pass(nowMs, immediate);
  }

  private async pass(nowMs: number, immediate: boolean): Promise<TickResult> {
    const attempt: Attempt = { nowMs, retry: undefined };
    // Read again before every pass: after a default switch these files would go up as targets of the new default.
    let me: Whoami;
    try {
      me = await this.deps.api.get<Whoami>('/cli/v1/whoami');
    } catch (error) {
      const outcome: TickResult | 'next' = this.failed(undefined, error, attempt);

      return outcome === 'next' ? 'continue' : outcome;
    }
    const current: string | null = me.project?.defaultLocale ?? null;
    if (current !== this.source.defaultLocale) {
      this.deps.err(
        this.line(
          `The project's default locale changed from ${safeText(this.source.defaultLocale)} to ${safeText(String(current))}; stopping. Run translify push --watch again.`,
        ),
      );

      return EXIT.failed;
    }

    const pushed: PushResponse[] = [];
    const extras: string[] = [];
    let result: TickResult = 'continue';
    for (const namespace of [...this.dirty].sort()) {
      if (this.deps.stopping()) break;
      const uploads: Upload[] | undefined = await this.uploadsOf(namespace);
      if (uploads === undefined) continue;
      const hashes: Map<string, string> = new Map(uploads.map((upload) => [upload.match.path, hashOf(upload.bytes)]));
      if (this.sameAsAttempted(namespace, hashes)) {
        // Changed and changed back: nothing to say.
        this.dirty.delete(namespace);
        continue;
      }

      let res: PushResponse;
      try {
        res = await this.deps.api.post<PushResponse>(PUSH_PATH, buildForm(uploads, { status: this.opts.status }, false, false));
      } catch (error) {
        const outcome: TickResult | 'next' = this.failed({ namespace, hashes }, error, attempt);
        // Refused, or to be retried: either way the next namespace still goes. Only a stop ends the pass.
        if (outcome === 'next' || outcome === 'continue') continue;
        result = outcome;
        break;
      }

      this.attempted.set(namespace, hashes);
      this.dirty.delete(namespace);
      const notes: string[] = [...followUps(res), ...this.orphanLines(namespace, res)].map((text) => `${INDENT}${text}`);
      if (immediate) {
        pushed.push(res);
        extras.push(...notes);
      } else {
        this.deps.out(this.line(pushLine(namespace, res, this.source.defaultLocale)));
        for (const note of notes) this.deps.out(note);
      }
    }
    if (pushed.length > 0) {
      this.deps.out(this.line(startSummary(pushed, this.source.defaultLocale)));
      for (const note of extras) this.deps.out(note);
    }
    // The backoff grows while something keeps failing, whatever else went through meanwhile.
    if (attempt.retry === undefined) this.retryAttempt = 0;

    return result;
  }

  /** The namespace's source files as read now, or undefined when there is none or one cannot be read. */
  private async uploadsOf(namespace: string): Promise<Upload[] | undefined> {
    const matches: Match[] = this.files.filter((match) => match.namespace === namespace);
    const uploads: Upload[] = [];
    for (const [index, match] of matches.entries()) {
      try {
        uploads.push({ match, field: `file${index}`, bytes: await this.deps.read(match.path) });
      } catch (error) {
        // Gone or unreadable since the poll (an editor mid-save). Not pushed now, and forgotten as seen, so the
        // next poll that can read it marks the namespace again even when the bytes are the ones seen before.
        this.cannotRead(match.path, error);
        this.dirty.delete(namespace);
        for (const file of matches) this.seen.delete(file.path);

        return undefined;
      }
    }
    if (uploads.length === 0) {
      this.dirty.delete(namespace);

      return undefined;
    }

    return uploads;
  }

  private sameAsAttempted(namespace: string, hashes: Map<string, string>): boolean {
    const before: Map<string, string> | undefined = this.attempted.get(namespace);

    return before !== undefined && before.size === hashes.size && [...hashes].every(([path, hash]) => before.get(path) === hash);
  }

  private orphanLines(namespace: string, res: PushResponse): string[] {
    const count: number = Array.isArray(res.orphans) ? res.orphans.length : 0;
    if (count === (this.orphans.get(namespace) ?? 0)) return [];
    this.orphans.set(namespace, count);

    return count === 0 ? [] : [orphanNote(namespace, count)];
  }

  /**
   * A failed request, by `watchVerdict`. `next`: these files were refused and are not sent again until they
   * change. `continue`: nothing wrong with the files; they stay dirty and the pass runs again after a backoff,
   * set once per pass. An exit code: the watch ends. `pushing` is absent for the whoami read.
   */
  private failed(
    pushing: { namespace: string; hashes: Map<string, string> } | undefined,
    error: unknown,
    attempt: Attempt,
  ): TickResult | 'next' {
    const verdict = watchVerdict(error);
    // `watchVerdict` rethrows anything else; the message is the CLI's own wording, already safe to print.
    const { message, exitCode } = error as CliError;
    const [first = '', ...rest] = message.split('\n');
    const say = (head: string): void => {
      this.deps.err(this.line([head, ...rest.map((row) => `${INDENT}${row}`)].join('\n')));
    };
    const labelled: string = `${pushing === undefined ? '' : `${safeText(pushing.namespace)}: `}${first}`;
    if (verdict === 'stop') {
      say(first);

      return exitCode;
    }
    if (verdict === 'wait' && pushing !== undefined) {
      this.attempted.set(pushing.namespace, pushing.hashes);
      this.dirty.delete(pushing.namespace);
      say(labelled);

      return 'next';
    }

    if (attempt.retry === undefined) {
      const step: number = this.retryAttempt;
      const delay: number = BACKOFF_MS[Math.min(step, BACKOFF_MS.length - 1)]!;
      this.retryAttempt += 1;
      this.retryAt = attempt.nowMs + delay;
      attempt.retry = { step, delay };
    }
    const { step, delay } = attempt.retry;
    const last: number = BACKOFF_MS.length - 1;
    // Leaving: no promise of a retry. Past the last step the same line would repeat every 30 s for as long as it lasts.
    if (this.deps.stopping()) say(labelled);
    else if (step < last) say(`${labelled} Retrying in ${delay / 1000} s.`);
    else if (step === last) say(`${labelled} Retrying every ${delay / 1000} s.`);

    return 'continue';
  }
}

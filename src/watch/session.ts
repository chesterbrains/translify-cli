import { createHash } from 'node:crypto';

import type { PushStatusFlag } from '../commands/push.js';
import type { Config } from '../config.js';
import type { Api } from '../http.js';
import type { Match, PathContext } from '../patterns.js';
import { CliError } from '../errors.js';
import { findFiles } from '../patterns.js';
import { safeText } from '../safe-text.js';
import { stamp } from './lines.js';

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
}

interface Seen extends FileStat {
  hash: string;
  namespace: string;
}

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

  /** What the last scan saw, by path. */
  protected seen: Map<string, Seen> = new Map();
  protected lastChangeAt: number = 0;
  protected retryAttempt: number = 0;
  protected retryAt: number = 0;
  private scanError: string | undefined;

  constructor(
    protected readonly opts: WatchOptions,
    protected readonly deps: SessionDeps,
    protected readonly source: { defaultLocale: string; context: PathContext },
  ) {}

  protected line(text: string): string {
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
      matches = (await findFiles(this.deps.config, this.deps.cwd, this.source.context)).filter(
        (match) =>
          match.locale === this.source.defaultLocale && (this.opts.namespace === undefined || match.namespace === this.opts.namespace),
      );
    } catch (error) {
      if (!(error instanceof CliError)) throw error;
      // The same clash would otherwise print on every poll: say it once, and again only when it changes.
      if (error.message !== this.scanError) this.deps.err(this.line(error.message));
      this.scanError = error.message;

      return [];
    }
    this.scanError = undefined;

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
        } catch {
          // Unreadable right now (mid-save, permissions): keep what was known, a later poll sees the change.
          if (before !== undefined) {
            next.set(match.path, before);
            kept.push(match);
          }
          continue;
        }
      }
      next.set(match.path, { ...stat, hash, namespace: match.namespace });
      kept.push(match);
      if (before === undefined || before.hash !== hash) marked.add(match.namespace);
    }

    const remaining: Set<string> = new Set([...next.values()].map((file) => file.namespace));
    const emptied: Set<string> = new Set();
    for (const [path, before] of this.seen) {
      if (next.has(path)) continue;
      if (remaining.has(before.namespace)) marked.add(before.namespace);
      else emptied.add(before.namespace);
    }
    for (const namespace of emptied) {
      // Its last source file went away: nothing to push, and an empty push would only list every key as an orphan.
      this.forget(namespace);
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

  /** A namespace that has no source file any more. */
  protected forget(namespace: string): void {
    this.dirty.delete(namespace);
  }
}

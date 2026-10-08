// Minimal for Task 6.2; Task 6.3 owns this file and extends it.
export const EXIT = { ok: 0, failed: 1, auth: 2, quota: 3, network: 4, withheld: 5, issues: 6 } as const;
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** Every expected failure. `index.ts` prints `message` and exits with `exitCode`; anything else is a bug. */
export class CliError extends Error {
  constructor(
    readonly exitCode: ExitCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/** Shared by the local check in `pull` and the server's `APPROVED_ONLY_REQUIRES_WORKING`. */
export const ONLY_APPROVED_NEEDS_WORKING: string =
  '--only-approved works with --from working only; environments already apply the review gate.';

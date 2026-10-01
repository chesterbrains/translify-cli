// Minimal for Task 6.2; Task 6.3 owns this file and extends it.
export const EXIT = { ok: 0, failed: 1, auth: 2, quota: 3, network: 4 } as const;
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

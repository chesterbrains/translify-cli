/** The server's `GET /cli/v1/lint` body (BE lint spec §2.3). */
export type LintSeverity = 'ERROR' | 'WARNING';

export interface LintIssue {
  /** One of the BE's ISSUE_CODES; a newer server may send one this CLI does not know. */
  code: string;
  severity: LintSeverity;
  arg?: string;
  categories?: string[];
  message?: string;
  offset?: number | null;
}

export interface LintCell {
  namespace: string;
  key: string;
  locale: string;
  severity: LintSeverity;
  value: string;
  issues: LintIssue[];
}

export interface LintResponse {
  summary: { errors: number; warnings: number; locales: Array<{ locale: string; errors: number; warnings: number }> };
  cells: LintCell[];
  truncated: boolean;
}

export const LINT_SEVERITIES = ['error', 'warning'] as const;

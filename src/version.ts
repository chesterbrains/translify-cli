// Must equal package.json "version"; src/version.test.ts fails when they drift.
export const VERSION: string = '0.1.1';
export const USER_AGENT: string = `translify-cli/${VERSION}`;

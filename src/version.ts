// Must equal package.json "version"; src/version.test.ts fails when they drift.
export const VERSION: string = '0.4.0';
export const USER_AGENT: string = `translify-cli/${VERSION}`;

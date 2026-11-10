/**
 * Safety guard for anything that writes test data (the Jest API tests, the browser-test helper): they create and delete
 * orders, admin accounts and settings, so they must never run against the live database.
 * They only run when DATABASE_URL points at this machine, unless ALLOW_REMOTE_TEST_DB=yes is set on purpose.
 */
export function assertLocalDatabase(url = process.env.DATABASE_URL ?? '', what = 'These tests'): void {
  if (process.env.ALLOW_REMOTE_TEST_DB === 'yes') return;
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    /* an unreadable URL is treated as not local */
  }
  const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host);
  if (!local) {
    throw new Error(
      `${what} write test data, and DATABASE_URL points at a remote database (${host || 'unreadable'}). ` +
        'Refusing to run. Point DATABASE_URL at a local scratch database (see .env.example), or set ALLOW_REMOTE_TEST_DB=yes if you really mean it.',
    );
  }
}

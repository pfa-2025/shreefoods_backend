/**
 * FRONTEND_URL may list several website addresses separated by commas, e.g.
 *   https://shreefoods.us,https://shreefoods-web.vercel.app
 * The first one is the main address (links in emails, cache refresh calls); every one of them is allowed to sign in
 * to the admin and call the API from a browser.
 */
export function frontendUrls(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

/** The main website address (no trailing slash). */
export function primaryFrontendUrl(raw: string): string {
  return frontendUrls(raw)[0] ?? '';
}

/** Browser origins (scheme + host + port) that may call the API. */
export function allowedOrigins(raw: string): string[] {
  return frontendUrls(raw).map((u) => new URL(u).origin);
}

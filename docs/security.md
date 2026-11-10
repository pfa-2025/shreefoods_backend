# Security review (Module 10)

What was checked, what enforces it, and what is knowingly left open. "Test" means an automated test in this repository that fails if the control breaks.

## Controls

| Area | What protects it | Test |
| --- | --- | --- |
| **Admin access** | Every `/api/v1/admin/*` route needs a valid server-side session, checked by `AdminAuthGuard` before anything else runs. | `backend/test/security.e2e-spec.ts` enumerates the app's *real* route table and requires 401 on every admin route without a session. A newly added unguarded route fails the build. |
| **Roles** | `OWNER` vs `STAFF`, enforced in the API (not the UI). Staff may work orders and mark dishes available; everything that changes public content, money settings or uploads is owner-only. | Same file: every admin route outside an explicit staff-allowed list must answer 403 to a staff session. |
| **Public surface** | Only reviewed routes are public (health, menu, site info, pages, announcements, quote, create order, order-by-token, report payment, uploaded files). | The same file fails if a non-admin route appears that is not on the reviewed list. |
| **Sessions** | Random 256-bit token in an `httpOnly`, `SameSite=Lax` cookie (`Secure` in production). Only an HMAC of the token is stored. 12-hour expiry. Logout and password reset delete sessions server-side. Deactivating an admin ends their session immediately. | `admin.e2e-spec.ts`, `cookie.spec.ts` |
| **CSRF** | Cookie auth is protected by `SameSite=Lax` plus a required custom header and matching `Origin` on every state-changing request (including login). | `security.e2e-spec.ts` (every admin write route), `admin.e2e-spec.ts` |
| **Login abuse** | 5 attempts/min per client on login, forgot-password and reset-password. Unknown email and wrong password give the same message and similar timing. Passwords: scrypt, 12+ characters. | `admin.e2e-spec.ts` (429 after 5) |
| **Ordering abuse** | 10 orders/min and 10 payment reports/min per client; 120 requests/min overall. | `security.e2e-spec.ts` |
| **CORS** | One allowed origin (`FRONTEND_URL`), with credentials. Everything else gets no CORS headers. The admin uses same-origin requests through the web app anyway. | `security.e2e-spec.ts` |
| **Input validation** | Every body, query and param is validated with Zod on the server; unknown fields are dropped. Bodies over 100 KB are rejected. Prices are integer cents. Totals and availability are always recomputed on the server. | `cart`, `orders`, `cms`, `security` e2e suites |
| **SQL injection** | Prisma only, with parameterised queries. A test fails if raw string-built SQL (`$queryRawUnsafe`, `Prisma.raw`) is ever added. SQL-looking input is tested as plain text. | `security.e2e-spec.ts` |
| **XSS** | React escapes output; no raw HTML rendering anywhere (a test fails if `dangerouslySetInnerHTML`/`innerHTML`/`eval` appear). Emails escape every customer value. Links from editable content must be on-site paths or http(s): enforced by the API **and** again in the website (`safeHref`). | `security-source.test.ts`, `safe-href.test.ts`, `email.templates.spec.ts`, CMS e2e |
| **Uploads** | Type decided from the file's bytes (JPEG/PNG/WebP only; SVG refused), 5 MB cap, random server-chosen filenames, files served with `nosniff` and a locked-down CSP, path traversal blocked, images in use can't be deleted. Owner-only. | `media.e2e-spec.ts`, `image-sniff.spec.ts`, `storage.spec.ts` |
| **Customer data** | The public order link returns no name, email, phone, address or notes. Admin screens and APIs require a session. Order links carry 192 bits of randomness, are `noindex`, send no `Referer`, and are served `no-store`. Customer emails are masked in logs. | `orders.e2e-spec.ts`, `email.e2e-spec.ts`, `quality.spec.ts` |
| **Payment integrity** | A customer can only *report* a payment. Only a signed-in staff member can mark it paid. Order progress is blocked until payment is verified. Cancelling a paid order requires confirming the refund. Duplicate submissions and concurrent staff clicks have exactly one effect. | `orders`, `live` e2e suites |
| **Errors** | One JSON error shape; unexpected errors return a generic message plus a request id (no stack, SQL or connection details). | `all-exceptions.filter.spec.ts`, `security.e2e-spec.ts` |
| **Headers** | API: Helmet defaults, no `X-Powered-By`. Web: `nosniff`, `frame-ancestors 'none'`, `X-Frame-Options`, `Permissions-Policy`, HSTS in production; `/admin` and `/order` are `no-store`. | `quality.spec.ts` |
| **Secrets** | Server secrets are never in `NEXT_PUBLIC_*` or client code (a test checks). `.env` files, uploads, saved test sessions and backups are git-ignored; a scan of everything git would commit found no secrets. Production refuses to start with the dev session secret, without Cloudinary, or without email settings. | `security-source.test.ts`, `env.spec.ts` |
| **Dependencies** | `npm audit --omit=dev`: web app 0 vulnerabilities; API patched (multer 2.5.0). See accepted risks. | n/a |

## Knowingly left open (accepted risks and limitations)

1. **Prisma tooling advisory (`deepmerge-ts`, "high").** It sits in Prisma's build-time configuration loader, which never processes user input, and the fix is a major Prisma upgrade. Revisit when moving to Prisma 7.
2. **No full script CSP.** Next.js needs per-request nonces for that, which would make every page dynamic. Mitigations: no raw HTML rendering, no user-supplied scripts, all dynamic links validated. The other CSP directives (framing, base-uri, object-src, form-action) are set.
3. **No two-factor sign-in** for admins. Strongly consider enabling it, or at least using a long unique password, for the owner account before launch.
4. **Manual payment trust.** Orders are paid by the customer scanning a QR code; staff confirm by hand. A customer can claim to have paid. Staff must check their account before verifying. This is a process control, not something software can remove.
5. **Anyone with an order link can see that order's items and total** (and tap "I've paid"). They cannot see personal details.
6. **Rate limits and the live-update channel live in memory.** Correct for one API instance. Running several needs shared storage (Redis) for rate limits and for the order-event bus.
7. **Client IP depends on `TRUST_PROXY_HOPS`.** If it doesn't match the real number of proxies in front of the API, rate limiting keys on the wrong address. Verify after deployment.
8. **No audit trail for CMS edits** (menu, prices, settings, QR). Order and payment actions are logged with who did them; content changes are not. A changed payment QR is the most sensitive edit.
9. **Tiny price window.** Prices are read when the order is created; a price edited in the milliseconds between quoting and creating could apply either value. Item prices are snapshotted on the order, so history is never rewritten.
10. **Customer details in `EmailLog`.** Message bodies are stored so failed emails can be retried. Delete old rows periodically (see `operations.md`).
11. **Cloudinary and Resend integrations are untested against live accounts.**

## Before launch (checklist)

- [ ] Change the owner password; use a long unique one. Remove the `e2e-*` test accounts (`npm run e2e:data -- cleanup`).
- [ ] Set a new `SESSION_SECRET` (32+ random bytes) and `REVALIDATE_SECRET` in production; never reuse development values.
- [ ] Production runs over HTTPS only (cookies are `Secure` when `NODE_ENV=production`).
- [ ] Replace the dummy payment QR with the real one and make a small test payment.
- [ ] Confirm `FRONTEND_URL` is the exact public website address (CORS and CSRF use it).
- [ ] Confirm `TRUST_PROXY_HOPS` matches the real proxy chain.
- [ ] Configure Cloudinary and Resend with live credentials and test both.
- [ ] Run a backup and a restore drill against production (`operations.md`).
- [ ] `npm audit --omit=dev` in both apps; run all test suites.

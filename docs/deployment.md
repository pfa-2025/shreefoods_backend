# Deployment guide

Two apps, deployed separately, plus three managed services.

| Piece | What it is | Where it runs |
| --- | --- | --- |
| `shreefoods_frontend` | Next.js website and admin | Any Node 22 host (Vercel is the simplest) |
| `shreefoods_backend` | NestJS API (`/api/v1`) | Any Node 22 host that keeps a process running (a VPS, Render, Railway, Fly). **Not** plain shared hosting. |
| Database | MySQL / MariaDB | Hostinger MySQL (remote access on) or any managed MySQL |
| Images | Cloudflare R2 bucket with public access | Cloudflare |
| Email | Resend | resend.com (verify your sending domain) |

The API keeps live order updates in memory, so run **one** API instance.

## 1. Database

1. Create the database and user (Hostinger: Databases → Management).
2. Allow the API host to connect (Hostinger: Databases → Remote MySQL). Use the API host's IP address, not "any host", once you know it.
3. Put the connection string in the API's `DATABASE_URL`, URL-encoding special characters (`@` → `%40`, `!` → `%21`), and keep the pool small on shared hosting:
   `mysql://USER:PASSWORD@HOST:3306/DBNAME?connection_limit=5`
4. Create the tables: `npx prisma migrate deploy`. If the database already contains tables that aren't ours, Prisma refuses (`P3005`). Run the SQL in `prisma/migrations/*/migration.sql` yourself, then mark each as applied with `npx prisma migrate resolve --applied <migration folder name>`.
5. First install only: `npm run db:seed` (sample menu and settings), then `npm run admin:create -- you@example.com "Your Name" OWNER`.

## 2. API environment

| Variable | Required | Notes |
| --- | --- | --- |
| `NODE_ENV` | yes | `production` turns on the strict checks below |
| `PORT` | no | default 4000 |
| `FRONTEND_URL` | yes | the website's public `https://` address (CORS, email links) |
| `DATABASE_URL` | yes | see above |
| `SESSION_SECRET` | yes | `openssl rand -hex 32`; must not start with `dev-only` |
| `REVALIDATE_SECRET` | yes | same value as the website's; lets edits show instantly |
| `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_PUBLIC_URL` | yes* | Cloudflare R2 image storage (all five). *Or the three `CLOUDINARY_*` settings instead. |
| `RESEND_API_KEY`, `EMAIL_FROM` | yes | order emails; `EMAIL_REPLY_TO` optional |
| `TRUST_PROXY_HOPS` | no | number of reverse proxies in front of the API (default 1) |

In production the API **refuses to start** without image storage, email settings and a real session secret.

Start command: `npm run build && npm run start:prod` (applies pending migrations, then starts). Health checks: `GET /api/v1/health` and `GET /api/v1/health/ready`.

## 3. Website environment

| Variable | Notes |
| --- | --- |
| `NEXT_PUBLIC_API_URL` | the API's public `https://…/api/v1` address |
| `NEXT_PUBLIC_SITE_URL` | the website's own address |
| `API_INTERNAL_URL` | the API's base address as the website's server reaches it (admin calls are proxied through the website so the login cookie is first-party) |
| `REVALIDATE_SECRET` | same as the API's |
| `R2_PUBLIC_URL` | same as the API's; lets the site optimise uploaded images (set at **build** time) |

Build: `npm run build`, start: `npm start`.

## 4. Go-live checklist

- [ ] Rotate every credential that was ever pasted into a chat or screenshot (database password, R2 keys and API token).
- [ ] Database remote access limited to the API host's IP.
- [ ] `NODE_ENV=production`, strong `SESSION_SECRET` and `REVALIDATE_SECRET`.
- [ ] Resend domain verified; place a real test order and confirm the email arrives.
- [ ] Replace the sample dishes, photos, story text, hours, address, phone and the **payment QR** in the admin (Settings, Menu, Pages).
- [ ] Sign in as the owner and create staff accounts; delete the sample admin if it isn't yours.
- [ ] Place a test order end to end, then delete it (no orders exist in a fresh database; numbering starts at 1001).
- [ ] Schedule `scripts/db-backup.sh` daily and do a restore drill (see `operations.md`).
- [ ] Add your real domain to Resend, the website host and `FRONTEND_URL`.

## 5. Known limits

- One API instance (in-memory live-update bus; scaling out needs Redis or similar).
- Resend and Cloudinary code paths are written to their documented APIs; R2 has been tested against a real bucket, Resend has not been sent through a live account.
- Payment is manual QR: staff must confirm the money arrived before accepting an order.
- `npm audit --omit=dev` reports a high-severity advisory in `deepmerge-ts`, reached only through the Prisma command-line tool (a development dependency). The fix requires Prisma 8, still a release candidate. It is not reachable by website visitors.

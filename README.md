# Shree Foods API

NestJS 11 + Prisma 6 REST API (`/api/v1`) for the Shree Foods restaurant website: menu, cart quoting, orders with manual QR payment, live order dashboard (Server-Sent Events), CMS, reviews, email queue and an Excel export.

Stack: Node 22, TypeScript (strict), MySQL / MariaDB, Cloudflare R2 for images, Resend for email.

## Run locally

```bash
npm install
cp .env.example .env          # set DATABASE_URL, SESSION_SECRET (openssl rand -hex 32), REVALIDATE_SECRET
npx prisma migrate deploy     # creates the tables in an empty MySQL/MariaDB database
npm run db:seed               # sample menu and settings
npm run admin:create -- you@example.com "Your Name" OWNER
npm run dev                   # http://localhost:4000/api/v1/health
```

Without the `R2_*` settings, images go to `./uploads` (development only).

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` / `npm run build` / `npm run start:prod` | develop, compile, run (applies migrations first) |
| `npm test` | unit + API tests. They write test data, so they **refuse to run unless `DATABASE_URL` points at this machine** (override with `ALLOW_REMOTE_TEST_DB=yes` only if you mean it) |
| `npm run typecheck` / `npm run lint` | static checks |
| `npm run db:deploy` | apply migrations |
| `npm run e2e:data -- prepare\|cleanup` | create / remove the throwaway accounts and content the browser tests use |
| `scripts/db-backup.sh`, `scripts/db-restore-drill.sh` | backup and restore check (see `docs/operations.md`) |
| `scripts/migrate-from-postgres.ts`, `scripts/migrate-uploads-to-r2.ts`, `scripts/migrate-bundled-images-to-r2.ts` | one-off migration helpers used when moving from Postgres, local disk and the bundled sample photos |

## Docs

- [`docs/deployment.md`](docs/deployment.md): environment variables, hosting and the go-live checklist
- [`docs/operations.md`](docs/operations.md): backups and recovery
- [`docs/security.md`](docs/security.md): controls and known gaps
- [`docs/architecture.md`](docs/architecture.md): design notes

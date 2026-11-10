# Operations: backups, restores and routine checks

## What needs backing up

| Data | Where it lives | How it's protected |
| --- | --- | --- |
| Orders, customers, menu, content, settings, admin accounts, email history | MySQL / MariaDB | **`backend/scripts/db-backup.sh`** (below), plus your database host's own automated backups/point-in-time recovery. |
| Uploaded images | Cloudinary in production (local `backend/uploads` in development only) | Cloudinary stores them durably. Keep the image library's own export/backup if you want a second copy. |
| Secrets (`.env` values) | Your hosting provider's secret store | Keep an encrypted copy in a password manager. They are *not* in the database or the git repository. |
| Code | Git | Normal repository hosting. |

## Back up the database

```bash
cd backend
DATABASE_URL='mysql://USER:PASSWORD@HOST:3306/DBNAME' ./scripts/db-backup.sh /secure/backup/folder
```

- Produces a compressed `shreefoods-<UTC time>.sql.gz` (needs the `mysqldump` client), checks it can be read, keeps the newest 30.
- The folder is created private (`700`) and the files `600`: **they contain customer names, emails and phone numbers.** Store them encrypted and off the server they came from.
- Schedule it at least daily (cron or your host's scheduler), and before every deployment that runs a database migration.

## Prove a backup restores (do this regularly)

```bash
DATABASE_URL='mysql://...live...' DRILL_DATABASE_URL='mysql://...empty scratch database...' ./scripts/db-restore-drill.sh /secure/backup/folder/shreefoods-20261101T190236Z.sql.gz
```

It restores into a separate scratch database and prints a table of live vs restored row counts. On shared hosting create an empty scratch database in the control panel and pass it as `DRILL_DATABASE_URL`; on a server where you can create databases, leave it out and the script creates and drops `<name>_restore_drill` itself. It never changes the live database. Differences are expected only for data created after the backup.

Verified on 2026-11-10 against the MySQL development database: backup, restore into a scratch database, and every table's row count matched (13 tables).

## Recover after a loss

1. Create an empty database and a user for the app.
2. `gunzip -c backup.sql.gz | mysql --default-character-set=utf8mb4 -h HOST -u USER -p NEWDB`
3. Point `DATABASE_URL` at it and start the API. Migrations are already applied inside the backup; run `npx prisma migrate deploy` to confirm nothing is pending.
4. Check `GET /api/v1/health/ready`, sign in, open Live orders, and place a test order.
5. Staff should check orders placed after the backup time: customers will still hold their order links, but anything created after the backup is gone. Use payment records (your payment account) to reconcile.

Expect to lose at most the time since the last backup. If that's too much, enable point-in-time recovery on the managed database.

## Running migrations safely

- Take a backup first. Run `npx prisma migrate deploy` (never `migrate dev`) in production.
- Prefer additive changes (new columns/tables) so the previous app version keeps working during the rollout. Roll back the application first; restore the database only if a migration itself went wrong.

## Routine housekeeping

- **Email history** keeps customer details. Delete old rows, e.g. quarterly:
  `DELETE FROM "EmailLog" WHERE "createdAt" < now() - interval '90 days';`
- **Expired sessions** are cleaned up automatically at sign-in.
- **Failed emails:** staff can retry them from an order's "Email history". Check for repeated failures after changing email settings.
- **Dependencies:** run `npm audit --omit=dev` in `backend` and `frontend` monthly and before each release.

## Test suites

```bash
npm test                                  # backend (Jest) then frontend unit tests (Vitest)
# browser tests (need the API on :4000 and a production web build on :3000)
cd backend && npm test                     # run first: it removes the e2e accounts
cd backend && npm run e2e:data -- prepare
cd frontend && npm run e2e                 # desktop + phone-sized browsers, accessibility, layout, security headers
cd backend && npm run e2e:data -- cleanup
```

After changing colours or other design tokens, delete `frontend/.next` before building: the build cache can keep serving old values.

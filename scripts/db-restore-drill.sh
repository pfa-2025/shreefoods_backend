#!/usr/bin/env bash
# Prove a backup really restores. Restores it into a throwaway database, compares row counts with the
# live database, and removes the throwaway database. It never touches the live database.
#   DATABASE_URL=postgresql://... ./scripts/db-restore-drill.sh path/to/backup.dump
set -euo pipefail

: "${DATABASE_URL:?Set DATABASE_URL}"
DUMP="${1:?Usage: db-restore-drill.sh path/to/backup.dump}"
[ -f "$DUMP" ] || { echo "No such file: $DUMP"; exit 1; }

URL="${DATABASE_URL%%\?*}"
BASE="${URL%/*}"                 # postgresql://user@host:port
LIVE_DB="${URL##*/}"
DRILL_DB="${LIVE_DB}_restore_drill"
DRILL_URL="$BASE/$DRILL_DB"
ADMIN_URL="$BASE/postgres"

cleanup() { psql "$ADMIN_URL" -qc "DROP DATABASE IF EXISTS \"$DRILL_DB\"" >/dev/null 2>&1 || true; }
trap cleanup EXIT

cleanup
psql "$ADMIN_URL" -qc "CREATE DATABASE \"$DRILL_DB\""
pg_restore --no-owner --no-privileges --exit-on-error --dbname="$DRILL_URL" "$DUMP"

TABLES=(AdminUser Order OrderItem OrderEvent EmailLog MenuCategory MenuItem MediaAsset Announcement Page SiteSettings _prisma_migrations)
printf '%-20s %10s %10s\n' TABLE LIVE RESTORED
status=0
for t in "${TABLES[@]}"; do
  live=$(psql "$URL" -Atc "SELECT count(*) FROM \"$t\"")
  rest=$(psql "$DRILL_URL" -Atc "SELECT count(*) FROM \"$t\"")
  mark=""; [ "$live" = "$rest" ] || { mark="  <-- differs (new data since the backup?)"; status=2; }
  printf '%-20s %10s %10s%s\n' "$t" "$live" "$rest" "$mark"
done
echo
echo "Restored copy is readable. Row counts above should match the live database as of backup time."
exit $status

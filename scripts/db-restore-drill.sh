#!/usr/bin/env bash
# Prove a backup really restores. Restores it into a SEPARATE throwaway database, compares row counts with the
# live database, and never touches the live one.
#   DATABASE_URL=mysql://...live...  DRILL_DATABASE_URL=mysql://...empty-scratch-db... \
#     ./scripts/db-restore-drill.sh path/to/backup.sql.gz
# On shared hosting you cannot create databases from a script, so create an empty scratch database in the control panel
# and pass its URL as DRILL_DATABASE_URL. With a local server the script creates and drops "<dbname>_restore_drill" for you.
set -euo pipefail
cd "$(dirname "$0")"
: "${DATABASE_URL:?Set DATABASE_URL}"
DUMP="${1:?Usage: db-restore-drill.sh path/to/backup.sql.gz}"
[ -f "$DUMP" ] || { echo "No such file: $DUMP"; exit 1; }
source ./db-url.sh

parse_db_url "$DATABASE_URL"; LIVE_ARGS=("${DB_ARGS[@]}"); LIVE_DB="$DB_NAME"; LIVE_PWD="${MYSQL_PWD:-}"
CREATED=""
if [ -n "${DRILL_DATABASE_URL:-}" ]; then
  parse_db_url "$DRILL_DATABASE_URL"; DRILL_ARGS=("${DB_ARGS[@]}"); DRILL_DB="$DB_NAME"; DRILL_PWD="${MYSQL_PWD:-}"
  [ "$DRILL_DB" != "$LIVE_DB" ] || { echo "DRILL_DATABASE_URL must be a different database from the live one." >&2; exit 1; }
else
  DRILL_ARGS=("${LIVE_ARGS[@]}"); DRILL_DB="${LIVE_DB}_restore_drill"; DRILL_PWD="$LIVE_PWD"; CREATED=1
fi
q() { local pw="$1"; shift; MYSQL_PWD="$pw" mysql "$@" -N -B; }

cleanup() { [ -z "$CREATED" ] || q "$DRILL_PWD" "${DRILL_ARGS[@]}" -e "DROP DATABASE IF EXISTS \`$DRILL_DB\`" >/dev/null 2>&1 || true; }
trap cleanup EXIT
if [ -n "$CREATED" ]; then
  cleanup; q "$DRILL_PWD" "${DRILL_ARGS[@]}" -e "CREATE DATABASE \`$DRILL_DB\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
else
  [ "$(q "$DRILL_PWD" "${DRILL_ARGS[@]}" "$DRILL_DB" -e 'SHOW TABLES' | wc -l)" -eq 0 ] || { echo "The drill database must be empty." >&2; exit 1; }
fi
gzip -dc "$DUMP" | MYSQL_PWD="$DRILL_PWD" mysql "${DRILL_ARGS[@]}" --default-character-set=utf8mb4 "$DRILL_DB"

TABLES=(AdminUser Order OrderItem OrderEvent EmailLog MenuCategory MenuItem MediaAsset Announcement Page SiteSettings Review _prisma_migrations)
printf '%-20s %10s %10s\n' TABLE LIVE RESTORED
status=0
for t in "${TABLES[@]}"; do
  live=$(q "$LIVE_PWD" "${LIVE_ARGS[@]}" "$LIVE_DB" -e "SELECT COUNT(*) FROM \`$t\`")
  rest=$(q "$DRILL_PWD" "${DRILL_ARGS[@]}" "$DRILL_DB" -e "SELECT COUNT(*) FROM \`$t\`")
  mark=""; [ "$live" = "$rest" ] || { mark="  <-- differs (new data since the backup?)"; status=2; }
  printf '%-20s %10s %10s%s\n' "$t" "$live" "$rest" "$mark"
done
echo
echo "Restored copy is readable. Row counts above should match the live database as of backup time."
exit $status

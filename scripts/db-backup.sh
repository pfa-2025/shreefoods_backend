#!/usr/bin/env bash
# Create a compressed, restorable backup of the database.
#   DATABASE_URL=mysql://USER:PASSWORD@HOST:3306/DBNAME ./scripts/db-backup.sh [output-dir]
# Keeps the 30 most recent backups in the output directory. Run it on a schedule (see docs/operations.md).
set -euo pipefail
cd "$(dirname "$0")"
: "${DATABASE_URL:?Set DATABASE_URL (the same value the API uses)}"
source ./db-url.sh
parse_db_url "$DATABASE_URL"

OUT_DIR="${1:-../backups}"
mkdir -p "$OUT_DIR"
chmod 700 "$OUT_DIR" # backups contain customer data
FILE="$OUT_DIR/shreefoods-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"

# --single-transaction: a consistent snapshot without locking the live site
mysqldump "${DB_ARGS[@]}" --single-transaction --routines --no-tablespaces --default-character-set=utf8mb4 "$DB_NAME" | gzip -9 > "$FILE"
chmod 600 "$FILE"
gzip -t "$FILE"                                                # fail now if the archive is damaged
gzip -dc "$FILE" | grep -q "CREATE TABLE \`Order\`" || { echo "Backup looks empty: $FILE" >&2; exit 1; }

echo "Backup written: $FILE ($(du -h "$FILE" | cut -f1))"
ls -1t "$OUT_DIR"/shreefoods-*.sql.gz | tail -n +31 | xargs -r rm -f

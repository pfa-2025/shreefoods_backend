#!/usr/bin/env bash
# Create a compressed, restorable backup of the database.
#   DATABASE_URL=postgresql://... ./scripts/db-backup.sh [output-dir]
# Keeps the 30 most recent backups in the output directory. Run it on a schedule (see docs/operations.md).
set -euo pipefail

: "${DATABASE_URL:?Set DATABASE_URL (the same value the API uses)}"
OUT_DIR="${1:-./backups}"
mkdir -p "$OUT_DIR"
chmod 700 "$OUT_DIR" # backups contain customer data

# libpq does not understand Prisma's "?schema=public" suffix
URL="${DATABASE_URL%%\?*}"
FILE="$OUT_DIR/shreefoods-$(date -u +%Y%m%dT%H%M%SZ).dump"

pg_dump --format=custom --no-owner --no-privileges --file="$FILE" "$URL"
chmod 600 "$FILE"
pg_restore --list "$FILE" > /dev/null # fail now if the file isn't a readable archive

echo "Backup written: $FILE ($(du -h "$FILE" | cut -f1))"
ls -1t "$OUT_DIR"/shreefoods-*.dump | tail -n +31 | xargs -r rm -f

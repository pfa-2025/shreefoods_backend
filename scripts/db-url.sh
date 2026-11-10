# Sourced by the db-*.sh scripts: turns a Prisma-style mysql:// URL into mysql client settings.
#   mysql://USER:PASSWORD@HOST:PORT/DBNAME?socket=/tmp/mysql.sock
parse_db_url() {
  local url="${1%%\?*}" query=""
  [[ "$1" == *\?* ]] && query="${1#*\?}"
  [[ "$url" =~ ^mysql://([^:@/]*)(:([^@]*))?@([^:/]+)(:([0-9]+))?/([^/]+)$ ]] || { echo "DATABASE_URL must look like mysql://USER:PASSWORD@HOST:3306/DBNAME" >&2; return 1; }
  DB_USER="${BASH_REMATCH[1]}"
  DB_PASS="$(python3 -c 'import sys,urllib.parse;print(urllib.parse.unquote(sys.argv[1]),end="")' "${BASH_REMATCH[3]}")"
  DB_HOST="${BASH_REMATCH[4]}"; DB_PORT="${BASH_REMATCH[6]:-3306}"; DB_NAME="${BASH_REMATCH[7]}"
  DB_ARGS=(--user="$DB_USER")
  if [[ "$query" == *socket=* ]]; then
    local sock="${query#*socket=}"; DB_ARGS+=(--socket="${sock%%&*}")
  else
    DB_ARGS+=(--host="$DB_HOST" --port="$DB_PORT")
  fi
  # the password goes in the environment, never on the command line where `ps` would show it
  if [ -n "$DB_PASS" ]; then export MYSQL_PWD="$DB_PASS"; else unset MYSQL_PWD; fi
}

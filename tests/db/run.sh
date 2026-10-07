#!/usr/bin/env bash
# Docker 없이 로컬 Postgres로 supabase/migrations + RLS 테스트를 돌린다.
#   bash tests/db/run.sh
# Postgres 16 서버 바이너리가 필요하다(PG_BIN으로 경로 지정 가능). root로 실행하면 postgres 사용자로 돌린다.
set -euo pipefail

PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${TEST_PG_PORT:-54329}"
WORK="$(mktemp -d)"
chmod 777 "$WORK"

as_pg() {
  if [ "$(id -u)" = "0" ]; then runuser -u postgres -- "$@"; else "$@"; fi
}

cleanup() {
  as_pg "$PG_BIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

as_pg "$PG_BIN/initdb" -D "$WORK/data" -U postgres --auth=trust >/dev/null
as_pg "$PG_BIN/pg_ctl" -D "$WORK/data" -o "-p $PORT -k $WORK -c listen_addresses='' -c wal_level=logical" -l "$WORK/log" -w start >/dev/null

# 쿼리 결과는 버리고(-o /dev/null) NOTICE(ok: ...)와 에러만 보이게 한다.
run_sql() {
  psql -h "$WORK" -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -q -o /dev/null -f "$1"
}

# NO_DEFAULT_GRANTS=1: 새 테이블을 자동으로 노출하지 않는 프로젝트 설정을 흉내낸다(기본 권한 부여 줄을 뺌).
if [ "${NO_DEFAULT_GRANTS:-0}" = "1" ]; then
  grep -v "alter default privileges" "$ROOT/tests/db/shim.sql" > "$WORK/shim.sql"
  run_sql "$WORK/shim.sql"
else
  run_sql "$ROOT/tests/db/shim.sql"
fi
for f in "$ROOT"/supabase/migrations/*.sql; do
  run_sql "$f"
done
run_sql "$ROOT/tests/db/rls.test.sql"

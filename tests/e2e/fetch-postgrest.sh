#!/usr/bin/env bash
# E2E 테스트용 PostgREST 실행 파일을 tests/e2e/.cache/postgrest에 받아 둔다(이미 있으면 건너뜀).
set -euo pipefail
VERSION="v12.2.3"
DIR="$(cd "$(dirname "$0")" && pwd)/.cache"
if [ -x "$DIR/postgrest" ]; then exit 0; fi
mkdir -p "$DIR"
curl -sSfL "https://github.com/PostgREST/postgrest/releases/download/${VERSION}/postgrest-${VERSION}-linux-static-x64.tar.xz" \
  | tar -xJ -C "$DIR" postgrest
"$DIR/postgrest" --version

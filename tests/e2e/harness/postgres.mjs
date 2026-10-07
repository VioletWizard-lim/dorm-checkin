// 테스트용 Postgres를 임시 폴더에 띄우고, Supabase 흉내(shim) + 실제 마이그레이션 + E2E 준비 SQL을 적용한다.
// tests/db/run.sh와 같은 방식(Docker 없음). Postgres 16 서버 바이너리가 필요하다(PG_BIN으로 경로 지정 가능).
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";

const PG_BIN = process.env.PG_BIN || "/usr/lib/postgresql/16/bin";

// root로 실행하면 initdb·postgres가 거부하므로 postgres 사용자로 돌린다.
function runAsPostgres(command, args) {
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  const [file, argv] = isRoot ? ["runuser", ["-u", "postgres", "--", command, ...args]] : [command, args];
  execFileSync(file, argv, { stdio: ["ignore", "ignore", "pipe"] });
}

export async function startPostgres({ repoRoot, port, extraSqlFiles = [] }) {
  const work = mkdtempSync(join(tmpdir(), "dorm-e2e-pg-"));
  chmodSync(work, 0o777);
  const data = join(work, "data");
  runAsPostgres(join(PG_BIN, "initdb"), ["-D", data, "-U", "postgres", "--auth=trust"]);
  runAsPostgres(join(PG_BIN, "pg_ctl"), [
    "-D",
    data,
    "-o",
    `-p ${port} -k ${work} -c listen_addresses='' -c wal_level=logical -c fsync=off`,
    "-l",
    join(work, "log"),
    "-w",
    "start",
  ]);

  const connection = { host: work, port, user: "postgres", database: "postgres" };
  const pool = new pg.Pool({ ...connection, max: 8 });

  const migrationsDir = join(repoRoot, "supabase", "migrations");
  const files = [
    join(repoRoot, "tests", "db", "shim.sql"),
    ...readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .map((f) => join(migrationsDir, f)),
    ...extraSqlFiles,
  ];
  for (const file of files) {
    try {
      await pool.query(readFileSync(file, "utf8"));
    } catch (error) {
      throw new Error(`SQL 적용 실패: ${file}\n${error.message}`);
    }
  }

  return {
    pool,
    socketDir: work,
    port,
    connection,
    async stop() {
      await pool.end().catch(() => {});
      try {
        runAsPostgres(join(PG_BIN, "pg_ctl"), ["-D", data, "-m", "immediate", "stop"]);
      } catch {
        // 이미 멈춤
      }
      rmSync(work, { recursive: true, force: true });
    },
  };
}

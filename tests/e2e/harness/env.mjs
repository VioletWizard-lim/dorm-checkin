// E2E 환경 전체를 띄우고 정리한다: Postgres → PostgREST → 가짜 게이트웨이 → Edge Function(Deno) → Realtime 흉내.
// 브라우저 컨텍스트에는 setupContext()로 가로채기(route)를 걸어 화면 파일·supabase-js·Supabase 요청을 연결한다.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { startPostgres } from "./postgres.mjs";
import { AuthStore, createGateway, JWT_SECRET, SECRET_KEY } from "./gateway.mjs";
import { RealtimeHub } from "./realtime.mjs";
import { FakeSolapi, SOLAPI_TEST_ENV } from "./solapi.mjs";
import { PASSWORD, SEED_SQL, STAFF } from "./seed.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const E2E_ROOT = resolve(here, "..");
export const REPO_ROOT = resolve(E2E_ROOT, "..", "..");
const PUBLIC_DIR = join(REPO_ROOT, "public");
export const APP_ORIGIN = "http://dorm.test";

const clientSource = readFileSync(join(PUBLIC_DIR, "js", "supabase-client.js"), "utf8");
const configSource = readFileSync(join(PUBLIC_DIR, "js", "supabase-config.js"), "utf8");
export const SUPABASE_URL = /SUPABASE_URL = "([^"]+)"/.exec(configSource)[1];
export const STAFF_EMAIL_DOMAIN = /STAFF_EMAIL_DOMAIN = "([^"]+)"/.exec(configSource)[1];
export const STUDENT_EMAIL_DOMAIN = /STUDENT_EMAIL_DOMAIN = "([^"]+)"/.exec(configSource)[1];
const SESSION_STORAGE_KEY = `sb-${new URL(SUPABASE_URL).hostname.split(".")[0]}-auth-token`;

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

async function waitFor(check, label, timeoutMs = 30000) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`${label} 준비 시간 초과${lastError ? `: ${lastError.message}` : ""}`);
}

function startProcess(command, args, options, label) {
  const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
  const output = [];
  const keep = (chunk) => {
    output.push(chunk.toString());
    if (output.length > 200) output.shift();
  };
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);
  child.on("exit", (code) => {
    if (code !== null && code !== 0 && !child.killedByUs) {
      console.error(`[${label}] 종료 코드 ${code}\n${output.join("")}`);
    }
  });
  return {
    child,
    output,
    stop() {
      child.killedByUs = true;
      child.kill("SIGTERM");
    },
  };
}

// 화면이 불러오는 supabase-js(CDN 주소)와 같은 버전을 로컬 패키지로 묶어서 대신 내려준다.
async function buildSupabaseBundle() {
  const require = createRequire(import.meta.url);
  const pkg = JSON.parse(readFileSync(require.resolve("@supabase/supabase-js/package.json"), "utf8"));
  const pinned = /@supabase\/supabase-js@([0-9.]+)\/\+esm/.exec(clientSource)?.[1];
  if (pinned !== pkg.version) {
    throw new Error(
      `supabase-client.js가 불러오는 supabase-js(${pinned})와 테스트용 패키지(${pkg.version}) 버전이 다릅니다. tests/e2e/package.json을 맞춰 주세요.`
    );
  }
  const result = await build({
    stdin: { contents: 'export * from "@supabase/supabase-js";', resolveDir: E2E_ROOT },
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2020",
    write: false,
    logLevel: "silent",
  });
  return result.outputFiles[0].text;
}

export async function startEnv() {
  const postgrestBin = process.env.POSTGREST_BIN || join(E2E_ROOT, ".cache", "postgrest");
  if (!existsSync(postgrestBin)) {
    throw new Error(`PostgREST 실행 파일이 없습니다(${postgrestBin}). bash tests/e2e/fetch-postgrest.sh를 먼저 실행하세요.`);
  }
  const denoBin = process.env.DENO_BIN || "deno";
  const [pgPort, restPort, gatewayPort, solapiPort] = await Promise.all([freePort(), freePort(), freePort(), freePort()]);
  const FUNCTION_NAMES = ["staff-accounts", "student-accounts", "notify-outing"];
  const functionPorts = Object.fromEntries(await Promise.all(FUNCTION_NAMES.map(async (name) => [name, await freePort()])));

  const stops = [];
  const stopAll = async () => {
    for (const stop of stops.reverse()) await stop();
  };
  try {
    const db = await startPostgres({ repoRoot: REPO_ROOT, port: pgPort, extraSqlFiles: [join(E2E_ROOT, "setup.sql")] });
    stops.push(() => db.stop());

    const postgrest = startProcess(
      postgrestBin,
      [],
      {
        env: {
          PGRST_DB_URI: `postgresql:///postgres?host=${db.socketDir}&port=${pgPort}&user=authenticator`,
          PGRST_DB_SCHEMAS: "public",
          PGRST_DB_ANON_ROLE: "anon",
          PGRST_JWT_SECRET: JWT_SECRET,
          PGRST_SERVER_HOST: "127.0.0.1",
          PGRST_SERVER_PORT: String(restPort),
          // Supabase 기본값과 같게: 한 번에 최대 1000행
          PGRST_DB_MAX_ROWS: "1000",
          PGRST_LOG_LEVEL: "error",
        },
      },
      "postgrest"
    );
    stops.push(() => postgrest.stop());
    const postgrestUrl = `http://127.0.0.1:${restPort}`;
    await waitFor(async () => (await fetch(`${postgrestUrl}/`)).ok, "PostgREST");

    const auth = new AuthStore(db.pool);
    const functionUrls = Object.fromEntries(FUNCTION_NAMES.map((name) => [name, `http://127.0.0.1:${functionPorts[name]}`]));
    const gateway = createGateway({ auth, postgrestUrl, functionUrls });
    const gatewayUrl = await gateway.listen(gatewayPort);
    stops.push(() => gateway.close());

    // 문자는 가짜 솔라피 서버로 보낸다
    const sms = new FakeSolapi();
    const solapiUrl = await sms.listen(solapiPort);
    stops.push(() => sms.close());

    for (const name of FUNCTION_NAMES) {
      const fn = startProcess(
        denoBin,
        [
          "run",
          "--allow-net",
          "--allow-env",
          "--node-modules-dir=none",
          "--no-lock",
          join(REPO_ROOT, "supabase", "functions", name, "index.ts"),
        ],
        {
          cwd: REPO_ROOT,
          env: {
            ...process.env,
            DENO_SERVE_ADDRESS: `tcp:127.0.0.1:${functionPorts[name]}`,
            SUPABASE_URL: gatewayUrl,
            SUPABASE_SECRET_KEYS: JSON.stringify({ default: SECRET_KEY }),
            ...SOLAPI_TEST_ENV,
            SOLAPI_BASE_URL: solapiUrl,
          },
        },
        name
      );
      stops.push(() => fn.stop());
    }
    for (const name of FUNCTION_NAMES) {
      await waitFor(async () => (await fetch(functionUrls[name], { method: "OPTIONS" })).ok, `Edge Function(${name})`, 120000);
    }

    const realtime = new RealtimeHub({ connection: db.connection, pool: db.pool, jwtSecret: JWT_SECRET });
    await realtime.start();
    stops.push(() => realtime.stop());

    const bundle = await buildSupabaseBundle();

    const env = {
      db,
      pool: db.pool,
      auth,
      gateway,
      realtime,
      functionUrls,
      sms,
      stop: stopAll,

      // 기본 데이터로 되돌린다(계정·학생·실·외출 기록 전부).
      async reset() {
        realtime.setPaused(false);
        sms.reset();
        await db.pool.query(`
          delete from public.outing_log;
          delete from public.outings;
          delete from public.outing_requests;
          delete from public.rooms;
          delete from public.profiles;
          delete from public.students;
        `);
        await auth.clear();
        for (const member of STAFF) {
          await auth.createUser({
            id: member.id,
            email: `${member.loginId}@${STAFF_EMAIL_DOMAIN}`,
            password: PASSWORD,
            app_metadata: { kind: "staff" },
          });
          if (member.disabled) await auth.updateUser(member.id, { ban_duration: "876000h" });
          await db.pool.query(
            `insert into public.profiles (id, login_id, kind, role, name, disabled, managed_grades, managed_rooms, managed_classes)
             values ($1, $2, 'staff', $3, $4, $5, $6, $7, $8)`,
            [
              member.id,
              member.loginId,
              member.role,
              member.name,
              member.disabled === true,
              member.managed_grades ?? [],
              member.managed_rooms ?? [],
              JSON.stringify(member.managed_classes ?? []),
            ]
          );
        }
        await db.pool.query(SEED_SQL);
      },

      // 브라우저 컨텍스트 하나에 가로채기를 건다. 등록 순서의 역순으로 우선하므로 "그 외 전부 차단"을 먼저 건다.
      async setupContext(context) {
        await context.route("**/*", (route) => route.abort("blockedbyclient"));
        await context.route(`${APP_ORIGIN}/**`, (route) => {
          const { pathname } = new URL(route.request().url());
          const relative = pathname === "/" ? "login.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
          const file = normalize(join(PUBLIC_DIR, relative));
          if (!file.startsWith(PUBLIC_DIR) || !existsSync(file)) return route.fulfill({ status: 404, body: "not found" });
          return route.fulfill({
            status: 200,
            headers: { "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" },
            body: readFileSync(file),
          });
        });
        await context.route("https://fonts.googleapis.com/**", (route) =>
          route.fulfill({ status: 200, contentType: "text/css", body: "" })
        );
        await context.route(/^https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@[^/]+\/\+esm$/, (route) =>
          route.fulfill({ status: 200, contentType: "text/javascript", body: bundle })
        );
        await context.route(`${SUPABASE_URL}/**`, async (route) => {
          const request = route.request();
          const url = new URL(request.url());
          const result = await gateway.handle({
            method: request.method(),
            path: url.pathname,
            search: url.search,
            headers: await request.allHeaders(),
            body: request.postDataBuffer(),
          });
          await route.fulfill({ status: result.status, headers: result.headers, body: result.body });
        });
        await context.routeWebSocket(/\/realtime\/v1\/websocket/, (ws) => realtime.attach(ws));
      },

      // 로그인 화면을 거치지 않고 그 계정의 세션을 브라우저 저장소에 넣어 둔다(로그인 화면 자체는 login.spec에서 확인).
      // expired: true면 이미 만료된 access token을 넣는다(밤새 켜 둔 전자칠판처럼 — refresh token으로 다시 받아야 함).
      // 교직원 아이디가 없으면 학생 아이디(리로스쿨 ID)로 찾는다.
      async loginAs(context, loginId, { expired = false } = {}) {
        const user =
          auth.findByEmail(`${loginId}@${STAFF_EMAIL_DOMAIN}`) ?? auth.findByEmail(`${loginId}@${STUDENT_EMAIL_DOMAIN}`);
        if (!user) throw new Error(`테스트 계정 없음: ${loginId}`);
        const session = auth.issueSession(user, expired ? -600 : 3600);
        await context.addInitScript(
          ({ origin, key, value }) => {
            if (location.origin !== origin) return;
            try {
              if (localStorage.getItem("__e2e_session_seeded")) return;
              localStorage.setItem("__e2e_session_seeded", "1");
              localStorage.setItem(key, value);
            } catch {
              // 저장소를 쓸 수 없는 문서는 건너뜀
            }
          },
          { origin: APP_ORIGIN, key: SESSION_STORAGE_KEY, value: JSON.stringify(session) }
        );
      },

      // 학생 계정을 바로 만든다(화면에서 발급하는 흐름은 students.spec에서 따로 확인).
      async createStudentAccount(studentId, loginId, password = PASSWORD) {
        await db.pool.query("update public.students set login_id = $2 where id = $1", [studentId, loginId]);
        const user = await auth.createUser({
          email: `${loginId}@${STUDENT_EMAIL_DOMAIN}`,
          password,
          app_metadata: { kind: "student" },
        });
        await db.pool.query(
          `insert into public.profiles (id, login_id, kind, role, name, student_id)
           select $1, $2, 'student', 'student', s.name, s.id from public.students s where s.id = $3`,
          [user.id, loginId, studentId]
        );
        return user;
      },

      async sql(text, params = []) {
        const { rows } = await db.pool.query(text, params);
        return rows;
      },
    };
    return env;
  } catch (error) {
    await stopAll();
    throw error;
  }
}

// Firebase(RTDB·Auth) → Supabase 데이터 이전. GitHub Actions의 수동 워크플로(migrate-firebase-to-supabase.yml)에서 실행한다.
// 저장소가 공개라서 Actions 로그가 누구에게나 보인다 — 이름·아이디·전화번호·비밀번호는 절대 출력하지 않고 건수만 남긴다.
//
// 필요한 환경 변수:
//   FIREBASE_SERVICE_ACCOUNT  기존 Firebase 서비스 계정 JSON
//   FIREBASE_DATABASE_URL     RTDB 주소
//   SUPABASE_URL              https://<project-ref>.supabase.co
//   SUPABASE_SECRET_KEY       Supabase secret(service_role) 키
import { randomBytes } from "node:crypto";
import { cert, deleteApp, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getDatabase } from "firebase-admin/database";
import { createClient } from "@supabase/supabase-js";
import { STAFF_EMAIL_DOMAIN, transform } from "./transform.mjs";

const BAN_FOREVER = "876000h";

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`환경 변수 ${name}가 비어 있습니다.`);
  return value;
}

function fail(step, error) {
  // 에러 메시지에 데이터 값이 섞일 수 있어 코드만 남긴다.
  throw new Error(`${step} 실패 (code: ${error?.code ?? error?.status ?? "unknown"})`);
}

async function readFirebase() {
  const app = initializeApp({
    credential: cert(JSON.parse(requireEnv("FIREBASE_SERVICE_ACCOUNT"))),
    databaseURL: requireEnv("FIREBASE_DATABASE_URL"),
  });
  try {
    const snapshot = await getDatabase(app).ref("/").once("value");
    const rtdb = snapshot.val() ?? {};

    const authUsers = [];
    try {
      let pageToken;
      do {
        const page = await getAuth(app).listUsers(1000, pageToken);
        for (const u of page.users) authUsers.push({ uid: u.uid, email: u.email ?? "" });
        pageToken = page.pageToken;
      } while (pageToken);
    } catch (error) {
      // Auth 조회 권한이 없으면 users/{uid}.id로 아이디를 정한다(그 값이 없는 계정은 건너뜀).
      console.log(`::warning::Firebase Auth 사용자 목록을 읽지 못했습니다 (code: ${error?.code ?? "unknown"}). users.id 값으로 진행합니다.`);
    }
    return { rtdb, authUsers };
  } finally {
    // RTDB 연결(웹소켓)이 열려 있으면 작업이 끝나도 프로세스가 종료되지 않는다.
    await deleteApp(app);
  }
}

// 실서비스가 이미 Supabase로 넘어간 뒤(학생 계정·외출 신청이 생긴 뒤)에 실수로 다시 돌려 데이터를 덮어쓰지 않게 막는다.
async function assertNotLive(sb) {
  const checks = [
    ["학생 계정", sb.from("profiles").select("id", { count: "exact", head: true }).eq("kind", "student")],
    ["외출 신청", sb.from("outing_requests").select("id", { count: "exact", head: true })],
  ];
  for (const [label, query] of checks) {
    const { count, error } = await query;
    if (error) fail(`${label} 확인`, error);
    if (count > 0) {
      throw new Error(`Supabase에 이미 ${label} 데이터가 있습니다. 전환 후에는 이전 작업을 다시 돌릴 수 없습니다.`);
    }
  }
}

async function insertInChunks(sb, table, rows, size = 500) {
  for (let i = 0; i < rows.length; i += size) {
    const { error } = await sb.from(table).insert(rows.slice(i, i + size));
    if (error) fail(`${table} 저장`, error);
  }
}

async function replaceAppData(sb, data) {
  for (const [table, column] of [["outings", "student_id"], ["rooms", "id"], ["students", "id"]]) {
    const { error } = await sb.from(table).delete().not(column, "is", null);
    if (error) fail(`${table} 비우기`, error);
  }
  await insertInChunks(sb, "students", data.students);
  await insertInChunks(sb, "rooms", data.rooms);
  await insertInChunks(sb, "outings", data.outings, 1000);
}

async function listSupabaseUserIds(sb) {
  const idByEmail = new Map();
  for (let page = 1; ; page++) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) fail("Supabase 사용자 목록", error);
    for (const u of data.users) idByEmail.set((u.email ?? "").toLowerCase(), u.id);
    if (data.users.length < 1000) break;
  }
  return idByEmail;
}

// 교직원 계정: 없으면 만들고(비밀번호는 아무도 모르는 임의 값 — 전환 후 관리자가 계정 관리 화면에서 재발급), 프로필은 덮어쓴다.
async function syncStaff(sb, staff) {
  const result = { created: 0, updated: 0, failed: 0 };
  const idByEmail = await listSupabaseUserIds(sb);
  for (const member of staff) {
    const email = `${member.loginId}@${STAFF_EMAIL_DOMAIN}`;
    let userId = idByEmail.get(email);
    if (!userId) {
      const { data, error } = await sb.auth.admin.createUser({
        email,
        password: randomBytes(18).toString("base64url"),
        email_confirm: true,
        app_metadata: { kind: "staff" },
      });
      if (error || !data.user) {
        result.failed++;
        continue;
      }
      userId = data.user.id;
      result.created++;
    } else {
      result.updated++;
    }
    const { error } = await sb.from("profiles").upsert({ id: userId, ...member.profile }, { onConflict: "id" });
    if (error) {
      result.failed++;
      continue;
    }
    if (member.profile.disabled) {
      await sb.auth.admin.updateUserById(userId, { ban_duration: BAN_FOREVER });
    }
  }
  return result;
}

async function main() {
  const sb = createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SECRET_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  await assertNotLive(sb);

  const { rtdb, authUsers } = await readFirebase();
  const data = transform(rtdb, authUsers);
  await replaceAppData(sb, data);
  const staffResult = await syncStaff(sb, data.staff);

  const s = data.stats;
  console.log("이전 완료");
  console.log(`  학생 ${s.students}명 (건너뜀 ${s.skippedStudents})`);
  console.log(`  실 ${s.rooms}개 (정리된 좌석 ${s.droppedSeats})`);
  console.log(`  외출 기록 ${s.outings}건 (건너뜀 ${s.droppedOutings}, 옛 형식 키 ${s.legacyOutingKeys})`);
  console.log(`  교직원 ${s.staff}명 — 새로 만듦 ${staffResult.created}, 갱신 ${staffResult.updated}, 실패 ${staffResult.failed} (건너뜀 ${s.skippedStaff})`);
  if (staffResult.failed > 0) process.exitCode = 1;
}

// 열린 연결이 남아 있어도 작업이 끝나면 바로 종료한다(워크플로가 끝나지 않고 도는 것 방지).
main().then(() => process.exit(process.exitCode ?? 0), (error) => {
  console.error(`::error::${error.message}`);
  process.exit(1);
});

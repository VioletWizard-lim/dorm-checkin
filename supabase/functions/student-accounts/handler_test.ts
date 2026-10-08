import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { HttpError } from "../_shared/http.ts";
import type { AuthLikeError, Profile } from "../_shared/types.ts";
import type { SmsMessage, SmsResult } from "../_shared/solapi.ts";
import { handleStudentAccounts, loginPageUrl, type StudentAccountsDeps, type StudentRow } from "./handler.ts";

function staff(overrides: Partial<Profile> = {}): Profile {
  return {
    id: "u-teacher",
    login_id: "homeroom01",
    kind: "staff",
    role: "teacher",
    name: "김담임",
    disabled: false,
    managed_grades: [],
    managed_rooms: [],
    managed_classes: [{ grade: 1, cls: "1학년 3반" }],
    student_id: null,
    ...overrides,
  };
}

const STUDENTS: StudentRow[] = [
  { id: "s-hong", grade: 1, cls: "1학년 3반", name: "홍길동", login_id: "Hong.GD", phone: "01011112222" },
  { id: "s-noid", grade: 1, cls: "1학년 3반", name: "아이디없음", login_id: null, phone: null },
  { id: "s-other", grade: 1, cls: "1학년 1반", name: "다른반", login_id: "other1", phone: null },
  { id: "s-done", grade: 1, cls: "1학년 3반", name: "발급됨", login_id: "done1", phone: "01055556666" },
];

function studentProfile(studentId: string, loginId: string): Profile {
  return { ...staff(), id: `auth-${studentId}`, login_id: loginId, kind: "student", role: "student", managed_classes: [], student_id: studentId };
}

type Calls = {
  created: { email: string; password: string }[];
  deletedUsers: string[];
  deletedStudents: string[];
  updatedUsers: { id: string; attrs: Record<string, unknown> }[];
  insertedProfiles: Record<string, unknown>[];
  sms: SmsMessage[];
};

function fakeDeps(
  options: { caller?: Profile; existingEmails?: string[]; failProfileInsert?: boolean; sms?: "on" | "fail" } = {},
) {
  const calls: Calls = { created: [], deletedUsers: [], deletedStudents: [], updatedUsers: [], insertedProfiles: [], sms: [] };
  const emails = new Set(options.existingEmails ?? []);
  const profiles = [studentProfile("s-done", "done1")];
  let pin = 0;
  const deps: StudentAccountsDeps = {
    caller: options.caller ?? staff(),
    auth: {
      createUser(attrs) {
        if (emails.has(attrs.email)) {
          const error: AuthLikeError = { message: "A user with this email address has already been registered", code: "email_exists" };
          return Promise.resolve({ data: { user: null }, error });
        }
        emails.add(attrs.email);
        calls.created.push({ email: attrs.email, password: attrs.password });
        return Promise.resolve({ data: { user: { id: `auth-new-${calls.created.length}` } }, error: null });
      },
      updateUserById(id, attrs) {
        calls.updatedUsers.push({ id, attrs });
        return Promise.resolve({ error: null });
      },
      deleteUser(id) {
        calls.deletedUsers.push(id);
        return Promise.resolve({ error: null });
      },
    },
    students: {
      getMany: (ids) => Promise.resolve(STUDENTS.filter((s) => ids.includes(s.id))),
      delete(id) {
        calls.deletedStudents.push(id);
        return Promise.resolve({ error: null });
      },
    },
    profiles: {
      findByStudentIds: (ids) => Promise.resolve(profiles.filter((p) => ids.includes(p.student_id ?? ""))),
      insert(row) {
        if (options.failProfileInsert) return Promise.resolve({ error: { message: "boom" } });
        calls.insertedProfiles.push(row);
        return Promise.resolve({ error: null });
      },
    },
    generatePin: () => String(123450 + ++pin),
    sms: options.sms
      ? {
        send(messages) {
          calls.sms.push(...messages);
          const results = new Map<string, SmsResult>();
          for (const m of messages) results.set(m.key, options.sms === "fail" ? { ok: false, error: "잔액 부족" } : { ok: true });
          return Promise.resolve(results);
        },
      }
      : null,
    appUrl: "https://dorm.example/login.html",
  };
  return { deps, calls };
}

async function assertHttpError(promise: Promise<unknown>, status: number, message?: string) {
  const err = await assertRejects(() => promise, HttpError);
  assertEquals(err.status, status);
  if (message) assertEquals(err.message, message);
}

Deno.test("only active staff with a role may call it", async () => {
  for (const caller of [
    staff({ kind: "student", role: "student" }),
    staff({ disabled: true }),
    staff({ role: null }),
  ]) {
    await assertHttpError(handleStudentAccounts({ action: "issue", studentIds: ["s-hong"] }, fakeDeps({ caller }).deps), 403);
  }
});

const admin = () => staff({ role: "admin" });

Deno.test("issue creates lowercase student logins with 6-digit pins and links the profile", async () => {
  const { deps, calls } = fakeDeps({ caller: admin() });
  const result = await handleStudentAccounts({ action: "issue", studentIds: ["s-hong", "s-hong"] }, deps) as { results: unknown[] };
  assertEquals(calls.created, [{ email: "hong.gd@student.donghall.local", password: "123451" }]);
  assertEquals(calls.insertedProfiles, [
    { id: "auth-new-1", login_id: "hong.gd", kind: "student", role: "student", name: "홍길동", student_id: "s-hong" },
  ]);
  // 문자가 설정되지 않았으면 비밀번호를 화면에 돌려준다
  assertEquals(result.results, [{ studentId: "s-hong", ok: true, loginId: "hong.gd", password: "123451", sms: "off" }]);
});

Deno.test("issue texts the password to the student and leaves it out of the response", async () => {
  const { deps, calls } = fakeDeps({ caller: staff({ role: "admin" }), sms: "on" });
  const result = await handleStudentAccounts({ action: "issue", studentIds: ["s-hong", "s-other"] }, deps) as { results: unknown[] };
  assertEquals(result.results, [
    { studentId: "s-hong", ok: true, loginId: "hong.gd", sms: "sent" },
    // 학생 연락처가 없으면 화면에 비밀번호를 보여 준다
    { studentId: "s-other", ok: true, loginId: "other1", password: "123452", sms: "no-phone" },
  ]);
  assertEquals(calls.sms, [{
    key: "s-hong",
    to: "01011112222",
    text: "[기숙사 면학 시스템] 홍길동 학생 계정\n아이디: hong.gd\n비밀번호: 123451\n접속: https://dorm.example/login.html\n" +
      "로그인 화면에서 '학생' 탭을 골라 주세요.",
  }]);
});

Deno.test("a failed password text falls back to showing the password", async () => {
  const { deps } = fakeDeps({ sms: "fail", caller: staff({ role: "admin" }) });
  assertEquals(await handleStudentAccounts({ action: "reset-password", studentId: "s-done" }, deps), {
    loginId: "done1",
    password: "123451",
    sms: "failed",
    smsError: "잔액 부족",
  });
  const sent = fakeDeps({ sms: "on", caller: staff({ role: "admin" }) });
  assertEquals(await handleStudentAccounts({ action: "reset-password", studentId: "s-done" }, sent.deps), {
    loginId: "done1",
    sms: "sent",
  });
  assertEquals(sent.calls.sms.map((m) => m.to), ["01055556666"]);
});

Deno.test("issue reports missing ids, existing accounts and unknown students per row", async () => {
  const { deps, calls } = fakeDeps({ caller: admin() });
  const result = await handleStudentAccounts(
    { action: "issue", studentIds: ["s-noid", "s-done", "s-missing"] },
    deps,
  ) as { results: unknown[] };
  assertEquals(result.results, [
    { studentId: "s-noid", ok: false, error: "ID가 등록되지 않았습니다." },
    { studentId: "s-done", ok: false, error: "이미 계정이 있습니다." },
    { studentId: "s-missing", ok: false, error: "학생을 찾을 수 없습니다." },
  ]);
  assertEquals(calls.created, []);
});

Deno.test("issue maps a taken login and rolls back when the profile cannot be saved", async () => {
  const taken = fakeDeps({ caller: admin(), existingEmails: ["hong.gd@student.donghall.local"] });
  const takenResult = await handleStudentAccounts({ action: "issue", studentIds: ["s-hong"] }, taken.deps) as { results: unknown[] };
  assertEquals(takenResult.results, [{ studentId: "s-hong", ok: false, error: "이미 사용 중인 아이디입니다." }]);

  const broken = fakeDeps({ caller: admin(), failProfileInsert: true });
  const brokenResult = await handleStudentAccounts({ action: "issue", studentIds: ["s-hong"] }, broken.deps) as { results: unknown[] };
  assertEquals(brokenResult.results, [{ studentId: "s-hong", ok: false, error: "계정 정보를 저장하지 못했습니다." }]);
  assertEquals(broken.calls.deletedUsers, ["auth-new-1"]);
});

Deno.test("issue validates the list", async () => {
  const deps = () => fakeDeps({ caller: admin() }).deps;
  await assertHttpError(handleStudentAccounts({ action: "issue", studentIds: [] }, deps()), 400);
  await assertHttpError(handleStudentAccounts({ action: "issue", studentIds: "s-hong" }, deps()), 400);
  const tooMany = Array.from({ length: 201 }, (_, i) => `s-${i}`);
  await assertHttpError(handleStudentAccounts({ action: "issue", studentIds: tooMany }, deps()), 400);
});

Deno.test("only admins may issue student accounts", async () => {
  for (const caller of [staff(), staff({ role: "gradeManager", managed_classes: [], managed_grades: [1] })]) {
    await assertHttpError(handleStudentAccounts({ action: "issue", studentIds: ["s-hong"] }, fakeDeps({ caller }).deps), 403);
  }
  const result = await handleStudentAccounts({ action: "issue", studentIds: ["s-other"] }, fakeDeps({ caller: admin() }).deps) as { results: { ok: boolean }[] };
  assertEquals(result.results[0].ok, true);
});

Deno.test("reset-password (admin only) gives a new pin for an existing account", async () => {
  const { deps, calls } = fakeDeps({ caller: staff({ role: "admin" }) });
  assertEquals(await handleStudentAccounts({ action: "reset-password", studentId: "s-done" }, deps), {
    loginId: "done1",
    password: "123451",
    sms: "off",
  });
  assertEquals(calls.updatedUsers, [{ id: "auth-s-done", attrs: { password: "123451" } }]);

  await assertHttpError(handleStudentAccounts({ action: "reset-password", studentId: "s-hong" }, deps), 404);
  await assertHttpError(handleStudentAccounts({ action: "reset-password", studentId: "" }, deps), 400);

  // 담임·학년부장은 담당 학생이어도 재발급 불가
  await assertHttpError(handleStudentAccounts({ action: "reset-password", studentId: "s-done" }, fakeDeps().deps), 403);
  const gm = staff({ role: "gradeManager", managed_grades: [1], managed_classes: [] });
  await assertHttpError(handleStudentAccounts({ action: "reset-password", studentId: "s-done" }, fakeDeps({ caller: gm }).deps), 403);
});

Deno.test("delete removes the login (admin only), and the roster row only when asked", async () => {
  const { deps, calls } = fakeDeps({ caller: staff({ role: "admin" }) });
  assertEquals(await handleStudentAccounts({ action: "delete", studentId: "s-done" }, deps), { ok: true });
  assertEquals(calls.deletedUsers, ["auth-s-done"]);
  assertEquals(calls.deletedStudents, []);

  await handleStudentAccounts({ action: "delete", studentId: "s-done", withStudent: true }, deps);
  assertEquals(calls.deletedStudents, ["s-done"]);

  // 계정이 없는 학생: 명단 삭제만 요청하면 그것만 하고, 계정 삭제만 요청하면 404
  await handleStudentAccounts({ action: "delete", studentId: "s-hong", withStudent: true }, deps);
  assertEquals(calls.deletedStudents, ["s-done", "s-hong"]);
  await assertHttpError(handleStudentAccounts({ action: "delete", studentId: "s-hong" }, deps), 404);
});

Deno.test("homeroom teachers may remove only roster rows without a login", async () => {
  const { deps, calls } = fakeDeps();
  await assertHttpError(handleStudentAccounts({ action: "delete", studentId: "s-done" }, deps), 403);
  await assertHttpError(handleStudentAccounts({ action: "delete", studentId: "s-done", withStudent: true }, deps), 403);
  assertEquals(calls.deletedUsers, []);
  assertEquals(calls.deletedStudents, []);
  await handleStudentAccounts({ action: "delete", studentId: "s-hong", withStudent: true }, deps);
  assertEquals(calls.deletedStudents, ["s-hong"]);
  await assertHttpError(handleStudentAccounts({ action: "delete", studentId: "s-other", withStudent: true }, deps), 403);
});

Deno.test("unknown actions are rejected", async () => {
  await assertHttpError(handleStudentAccounts({ action: "nope" }, fakeDeps().deps), 400, "알 수 없는 요청입니다.");
});

Deno.test("the login link in the text keeps the site path (GitHub Pages) but only the caller's origin", () => {
  assertEquals(loginPageUrl("https://violetwizard-lim.github.io", "/dorm-checkin/"), "https://violetwizard-lim.github.io/dorm-checkin/login.html");
  assertEquals(loginPageUrl("https://checkin.example.kr", "/"), "https://checkin.example.kr/login.html");
  assertEquals(loginPageUrl("https://a.example", undefined), "https://a.example/login.html");
  // 이상한 경로는 무시하고 도메인 바로 아래로
  assertEquals(loginPageUrl("https://a.example", "//evil.example/"), "https://a.example/login.html");
  assertEquals(loginPageUrl("https://a.example", "/../x/"), "https://a.example/login.html");
  assertEquals(loginPageUrl("https://a.example", "/x?y=1/"), "https://a.example/login.html");
  assertEquals(loginPageUrl(null, "/dorm-checkin/"), null);
  assertEquals(loginPageUrl("javascript:alert(1)", "/"), null);
});

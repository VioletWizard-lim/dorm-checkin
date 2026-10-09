import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { HttpError } from "../_shared/http.ts";
import type { AuthLikeError, Profile } from "../_shared/types.ts";
import { handleStaffAccounts, type StaffAccountsDeps } from "./handler.ts";

function profile(overrides: Partial<Profile>): Profile {
  return {
    id: "u-admin",
    login_id: "admin01",
    kind: "staff",
    role: "admin",
    name: "관리자",
    disabled: false,
    managed_grades: [],
    managed_rooms: [],
    managed_classes: [],
    student_id: null,
    ...overrides,
  };
}

type Calls = {
  created: { email: string; password: string }[];
  deleted: string[];
  updatedUsers: { id: string; attrs: Record<string, unknown> }[];
  insertedProfiles: Record<string, unknown>[];
  updatedProfiles: { id: string; patch: Record<string, unknown> }[];
};

function fakeDeps(options: {
  caller?: Profile;
  profiles?: Profile[];
  existingEmails?: string[];
  failProfileInsert?: boolean;
} = {}): { deps: StaffAccountsDeps; calls: Calls } {
  const calls: Calls = { created: [], deleted: [], updatedUsers: [], insertedProfiles: [], updatedProfiles: [] };
  const existing = new Set(options.existingEmails ?? []);
  const profiles = new Map((options.profiles ?? []).map((p) => [p.id, p]));
  let counter = 0;
  let pwCounter = 0;
  const deps: StaffAccountsDeps = {
    caller: options.caller ?? profile({}),
    auth: {
      createUser(attrs) {
        if (existing.has(attrs.email)) {
          const error: AuthLikeError = { message: "A user with this email address has already been registered", code: "email_exists" };
          return Promise.resolve({ data: { user: null }, error });
        }
        existing.add(attrs.email);
        calls.created.push({ email: attrs.email, password: attrs.password });
        counter += 1;
        return Promise.resolve({ data: { user: { id: `new-${counter}` } }, error: null });
      },
      updateUserById(id, attrs) {
        calls.updatedUsers.push({ id, attrs });
        return Promise.resolve({ error: null });
      },
      deleteUser(id) {
        calls.deleted.push(id);
        return Promise.resolve({ error: null });
      },
    },
    profiles: {
      get: (id) => Promise.resolve(profiles.get(id) ?? null),
      insert(row) {
        if (options.failProfileInsert) return Promise.resolve({ error: { message: "boom" } });
        calls.insertedProfiles.push(row);
        return Promise.resolve({ error: null });
      },
      update(id, patch) {
        calls.updatedProfiles.push({ id, patch });
        return Promise.resolve({ error: null });
      },
    },
    generatePassword: () => `gen-pass-${++pwCounter}`,
  };
  return { deps, calls };
}

async function assertHttpError(promise: Promise<unknown>, status: number) {
  const err = await assertRejects(() => promise, HttpError);
  assertEquals(err.status, status);
}

Deno.test("only an active admin may call it", async () => {
  await assertHttpError(handleStaffAccounts({ action: "create", accounts: [] }, fakeDeps({ caller: profile({ role: "dormStaff" }) }).deps), 403);
  await assertHttpError(handleStaffAccounts({ action: "create", accounts: [] }, fakeDeps({ caller: profile({ disabled: true }) }).deps), 403);
  await assertHttpError(
    handleStaffAccounts({ action: "create", accounts: [] }, fakeDeps({ caller: profile({ kind: "student", role: "student" }) }).deps),
    403,
  );
});

Deno.test("create makes lowercase staff logins as teachers and returns only generated passwords", async () => {
  const { deps, calls } = fakeDeps();
  const result = await handleStaffAccounts({
    action: "create",
    accounts: [
      { loginId: "Teacher01", name: "김선생" },
      { loginId: "teacher02", name: "이선생", password: "mypassword" },
    ],
  }, deps) as { results: unknown[] };

  assertEquals(calls.created, [
    { email: "teacher01@donghall.local", password: "gen-pass-1" },
    { email: "teacher02@donghall.local", password: "mypassword" },
  ]);
  assertEquals(calls.insertedProfiles, [
    { id: "new-1", login_id: "teacher01", kind: "staff", role: "teacher", name: "김선생" },
    { id: "new-2", login_id: "teacher02", kind: "staff", role: "teacher", name: "이선생" },
  ]);
  assertEquals(result.results, [
    { loginId: "teacher01", ok: true, userId: "new-1", password: "gen-pass-1" },
    { loginId: "teacher02", ok: true, userId: "new-2" },
  ]);
});

Deno.test("create reports bad ids, duplicates, short passwords and taken ids per row", async () => {
  const { deps, calls } = fakeDeps({ existingEmails: ["taken@donghall.local"] });
  const result = await handleStaffAccounts({
    action: "create",
    accounts: [
      { loginId: "bad id!", name: "x" },
      { loginId: "dup", name: "a" },
      { loginId: "DUP", name: "b" },
      { loginId: "shortpw", password: "123" },
      { loginId: "taken" },
    ],
  }, deps) as { results: { ok: boolean; error?: string }[] };

  assertEquals(result.results.map((r) => r.ok), [false, true, false, false, false]);
  assertEquals(result.results[0].error, "아이디는 영문과 숫자만 쓸 수 있습니다.");
  assertEquals(result.results[2].error, "목록에 같은 아이디가 두 번 있습니다.");
  assertEquals(result.results[3].error, "비밀번호는 6자 이상이어야 합니다.");
  assertEquals(result.results[4].error, "이미 사용 중인 아이디입니다.");
  assertEquals(calls.created.length, 1);
});

Deno.test("create can give each account a role, but never admin", async () => {
  const { deps, calls } = fakeDeps();
  const result = await handleStaffAccounts({
    action: "create",
    accounts: [
      { loginId: "dorm1", name: "기숙사", role: "dormStaff" },
      { loginId: "super1", name: "감독", role: "studyHallSupervisor" },
      { loginId: "gm1", name: "학년", role: "gradeManager" },
      { loginId: "boss", name: "관리", role: "admin" },
      { loginId: "odd", name: "이상", role: "student" },
    ],
  }, deps) as { results: { ok: boolean; error?: string }[] };
  assertEquals(calls.insertedProfiles.map((p) => [p.login_id, p.role]), [
    ["dorm1", "dormStaff"],
    ["super1", "studyHallSupervisor"],
    ["gm1", "gradeManager"],
  ]);
  assertEquals(result.results.map((r) => r.ok), [true, true, true, false, false]);
  assertEquals(result.results[3].error, "관리자는 일괄 생성으로 만들 수 없습니다.");
  assertEquals(result.results[4].error, "알 수 없는 역할입니다.");
  assertEquals(calls.created.length, 3); // 거부한 역할은 로그인 계정도 만들지 않는다
});

Deno.test("create rolls the auth user back when the profile cannot be saved", async () => {
  const { deps, calls } = fakeDeps({ failProfileInsert: true });
  const result = await handleStaffAccounts({ action: "create", accounts: [{ loginId: "kim01" }] }, deps) as {
    results: { ok: boolean }[];
  };
  assertEquals(result.results[0].ok, false);
  assertEquals(calls.deleted, ["new-1"]);
});

Deno.test("create rejects an empty or oversized list", async () => {
  await assertHttpError(handleStaffAccounts({ action: "create", accounts: [] }, fakeDeps().deps), 400);
  const many = Array.from({ length: 201 }, (_, i) => ({ loginId: `t${i}` }));
  await assertHttpError(handleStaffAccounts({ action: "create", accounts: many }, fakeDeps().deps), 400);
});

Deno.test("reset-password issues a new password for another active staff account only", async () => {
  const teacher = profile({ id: "u-t", login_id: "kim01", role: "teacher" });
  const student = profile({ id: "u-s", kind: "student", role: "student", student_id: "st1" });
  const gone = profile({ id: "u-gone", role: null, disabled: true });
  const { deps, calls } = fakeDeps({ profiles: [teacher, student, gone] });

  assertEquals(await handleStaffAccounts({ action: "reset-password", userId: "u-t" }, deps), { password: "gen-pass-1" });
  assertEquals(calls.updatedUsers, [{ id: "u-t", attrs: { password: "gen-pass-1" } }]);

  await assertHttpError(handleStaffAccounts({ action: "reset-password", userId: "u-admin" }, deps), 400);
  await assertHttpError(handleStaffAccounts({ action: "reset-password", userId: "u-s" }, deps), 404);
  await assertHttpError(handleStaffAccounts({ action: "reset-password", userId: "u-gone" }, deps), 400);
  await assertHttpError(handleStaffAccounts({ action: "reset-password", userId: "missing" }, deps), 404);
});

Deno.test("reset-password uses the password the admin chose, if it is long enough", async () => {
  const teacher = profile({ id: "u-t", login_id: "kim01", role: "teacher" });
  const { deps, calls } = fakeDeps({ profiles: [teacher] });

  assertEquals(await handleStaffAccounts({ action: "reset-password", userId: "u-t", password: "school2026" }, deps), {
    password: "school2026",
  });
  assertEquals(calls.updatedUsers, [{ id: "u-t", attrs: { password: "school2026" } }]);

  await assertHttpError(handleStaffAccounts({ action: "reset-password", userId: "u-t", password: "12345" }, deps), 400);
  await assertHttpError(handleStaffAccounts({ action: "reset-password", userId: "u-t", password: "가".repeat(25) }, deps), 400);
  assertEquals(calls.updatedUsers.length, 1);
});

Deno.test("disable bans the login and clears role and scopes", async () => {
  const gm = profile({ id: "u-gm", role: "gradeManager", managed_grades: [1], managed_rooms: ["r1"] });
  const { deps, calls } = fakeDeps({ profiles: [gm] });
  assertEquals(await handleStaffAccounts({ action: "disable", userId: "u-gm" }, deps), { ok: true });
  assertEquals(calls.updatedUsers, [{ id: "u-gm", attrs: { ban_duration: "876000h" } }]);
  assertEquals(calls.updatedProfiles, [{
    id: "u-gm",
    patch: { disabled: true, role: null, managed_grades: [], managed_rooms: [], managed_classes: [] },
  }]);
  await assertHttpError(handleStaffAccounts({ action: "disable", userId: "u-admin" }, deps), 400);
});

Deno.test("unknown actions are rejected", async () => {
  await assertHttpError(handleStaffAccounts({ action: "drop-everything" }, fakeDeps().deps), 400);
});

// 학생 계정 관리 — 그 학생의 명단을 관리할 수 있는 교직원만(관리자·기숙사부 전체, 학년부장 담당 학년, 담임 담당 반).
//   issue          : 계정 발급(여러 명). 아이디 = 학생 명단의 ID, 초기 비밀번호 = 6자리 숫자(응답으로 한 번만 돌려줌)
//   reset-password : 새 6자리 비밀번호 발급(응답으로 한 번만 돌려줌)
//   delete         : 계정 삭제(로그인 정보 + 프로필). withStudent가 true면 학생 명단에서도 지운다
// 외부 호출(Auth Admin API, 테이블)은 deps로 받아서 테스트에서 가짜로 바꿀 수 있게 한다.

import { HttpError } from "../_shared/http.ts";
import { normalizeStudentId, studentEmail } from "../_shared/accounts.ts";
import { canManageStudent } from "../_shared/scope.ts";
import type { AuthLikeError, Profile } from "../_shared/types.ts";

const MAX_ACCOUNTS_PER_REQUEST = 200;

export type StudentRow = { id: string; grade: number; cls: string; name: string; login_id: string | null };

export type StudentAccountsDeps = {
  caller: Profile;
  auth: {
    createUser(attrs: {
      email: string;
      password: string;
      email_confirm: boolean;
      app_metadata: Record<string, unknown>;
    }): Promise<{ data: { user: { id: string } | null }; error: AuthLikeError | null }>;
    updateUserById(id: string, attrs: Record<string, unknown>): Promise<{ error: AuthLikeError | null }>;
    deleteUser(id: string): Promise<{ error: AuthLikeError | null }>;
  };
  students: {
    getMany(ids: string[]): Promise<StudentRow[]>;
    delete(id: string): Promise<{ error: { message: string } | null }>;
  };
  profiles: {
    findByStudentIds(ids: string[]): Promise<Profile[]>;
    insert(row: Record<string, unknown>): Promise<{ error: { message: string } | null }>;
  };
  generatePin(): string;
};

export type IssueResult =
  | { studentId: string; ok: true; loginId: string; password: string }
  | { studentId: string; ok: false; error: string };

export async function handleStudentAccounts(body: Record<string, unknown>, deps: StudentAccountsDeps): Promise<unknown> {
  const { caller } = deps;
  if (caller.kind !== "staff" || caller.disabled || !caller.role) {
    throw new HttpError(403, "교직원만 사용할 수 있습니다.");
  }
  switch (body.action) {
    case "issue":
      return { results: await issueAccounts(body.studentIds, deps) };
    case "reset-password":
      return await resetPassword(body.studentId, deps);
    case "delete":
      await deleteAccount(body.studentId, body.withStudent === true, deps);
      return { ok: true };
    default:
      throw new HttpError(400, "알 수 없는 요청입니다.");
  }
}

function describeAuthError(error: AuthLikeError): string {
  if (error.code === "email_exists" || error.code === "user_already_exists" || /already (been registered|exists)/i.test(error.message)) {
    return "이미 사용 중인 아이디입니다.";
  }
  return "계정을 만들지 못했습니다.";
}

async function issueAccounts(raw: unknown, deps: StudentAccountsDeps): Promise<IssueResult[]> {
  if (!Array.isArray(raw) || raw.length === 0) throw new HttpError(400, "발급할 학생 목록이 비어 있습니다.");
  if (raw.length > MAX_ACCOUNTS_PER_REQUEST) {
    throw new HttpError(400, `한 번에 최대 ${MAX_ACCOUNTS_PER_REQUEST}명까지 발급할 수 있습니다.`);
  }
  const ids = [...new Set(raw.map((v) => String(v ?? "")))].filter(Boolean);
  const students = new Map((await deps.students.getMany(ids)).map((s) => [s.id, s]));
  const existing = new Set((await deps.profiles.findByStudentIds(ids)).map((p) => p.student_id));

  const results: IssueResult[] = [];
  for (const studentId of ids) {
    const student = students.get(studentId);
    if (!student) {
      results.push({ studentId, ok: false, error: "학생을 찾을 수 없습니다." });
      continue;
    }
    if (!canManageStudent(deps.caller, student)) {
      results.push({ studentId, ok: false, error: "이 학생의 계정을 관리할 권한이 없습니다." });
      continue;
    }
    if (existing.has(studentId)) {
      results.push({ studentId, ok: false, error: "이미 계정이 있습니다." });
      continue;
    }
    const loginId = normalizeStudentId(student.login_id);
    if (!loginId) {
      results.push({ studentId, ok: false, error: "ID가 등록되지 않았습니다." });
      continue;
    }

    const password = deps.generatePin();
    const { data, error } = await deps.auth.createUser({
      email: studentEmail(loginId),
      password,
      email_confirm: true,
      app_metadata: { kind: "student" },
    });
    if (error || !data.user) {
      results.push({ studentId, ok: false, error: error ? describeAuthError(error) : "계정을 만들지 못했습니다." });
      continue;
    }
    const { error: profileError } = await deps.profiles.insert({
      id: data.user.id,
      login_id: loginId,
      kind: "student",
      role: "student",
      name: student.name,
      student_id: student.id,
    });
    if (profileError) {
      await deps.auth.deleteUser(data.user.id);
      results.push({ studentId, ok: false, error: "계정 정보를 저장하지 못했습니다." });
      continue;
    }
    results.push({ studentId, ok: true, loginId, password });
  }
  return results;
}

// 대상 학생과 그 학생의 계정을 찾고 권한을 확인한다.
async function loadTarget(rawStudentId: unknown, deps: StudentAccountsDeps): Promise<{ student: StudentRow; account: Profile | null }> {
  const studentId = typeof rawStudentId === "string" ? rawStudentId : "";
  if (!studentId) throw new HttpError(400, "대상 학생이 지정되지 않았습니다.");
  const [student] = await deps.students.getMany([studentId]);
  if (!student) throw new HttpError(404, "학생을 찾을 수 없습니다.");
  if (!canManageStudent(deps.caller, student)) throw new HttpError(403, "이 학생의 계정을 관리할 권한이 없습니다.");
  const [account] = await deps.profiles.findByStudentIds([studentId]);
  return { student, account: account ?? null };
}

async function resetPassword(rawStudentId: unknown, deps: StudentAccountsDeps): Promise<{ loginId: string; password: string }> {
  const { account } = await loadTarget(rawStudentId, deps);
  if (!account) throw new HttpError(404, "계정이 아직 발급되지 않았습니다.");
  const password = deps.generatePin();
  const { error } = await deps.auth.updateUserById(account.id, { password });
  if (error) throw new Error(`password reset failed: ${error.message}`);
  return { loginId: account.login_id, password };
}

async function deleteAccount(rawStudentId: unknown, withStudent: boolean, deps: StudentAccountsDeps): Promise<void> {
  const { student, account } = await loadTarget(rawStudentId, deps);
  if (!account && !withStudent) throw new HttpError(404, "계정이 아직 발급되지 않았습니다.");
  if (account) {
    // 프로필은 auth.users 외래키(on delete cascade)로 함께 지워진다.
    const { error } = await deps.auth.deleteUser(account.id);
    if (error) throw new Error(`delete user failed: ${error.message}`);
  }
  if (withStudent) {
    const { error } = await deps.students.delete(student.id);
    if (error) throw new Error(`delete student failed: ${error.message}`);
  }
}

// 학생 계정 관리 — 그 학생의 명단을 관리할 수 있는 교직원만(관리자 전체, 학년부장 담당 학년, 담임 담당 반 — 기숙사부는 못 함).
//   issue          : 계정 발급(여러 명). 아이디 = 학생 명단의 ID, 초기 비밀번호 = 6자리 숫자
//   reset-password : 새 6자리 비밀번호 발급
//   발급·재발급한 비밀번호는 문자(솔라피)가 설정돼 있고 학생 연락처가 있으면 학생에게 문자로 보내고,
//   문자로 보내지 못한 경우에만 응답으로 한 번 돌려준다(화면에 띄워 직접 전달).
//   delete         : 계정 삭제(로그인 정보 + 프로필). withStudent가 true면 학생 명단에서도 지운다
// 외부 호출(Auth Admin API, 테이블)은 deps로 받아서 테스트에서 가짜로 바꿀 수 있게 한다.

import { HttpError } from "../_shared/http.ts";
import { normalizeStudentId, studentEmail } from "../_shared/accounts.ts";
import { canManageStudent } from "../_shared/scope.ts";
import type { SmsMessage, SmsSender } from "../_shared/solapi.ts";
import type { AuthLikeError, Profile } from "../_shared/types.ts";

const MAX_ACCOUNTS_PER_REQUEST = 200;

export type StudentRow = {
  id: string;
  grade: number;
  cls: string;
  name: string;
  login_id: string | null;
  phone: string | null;
};

// 비밀번호 전달 방법: sent = 학생에게 문자로 보냄, failed = 문자 실패, no-phone = 학생 연락처 없음, off = 문자 미설정
export type SmsStatus = "sent" | "failed" | "no-phone" | "off";

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
  sms: SmsSender | null;
  appUrl: string | null; // 문자에 넣을 접속 주소(호출한 화면의 주소)
};

export type IssueResult =
  | { studentId: string; ok: true; loginId: string; password?: string; sms: SmsStatus; smsError?: string }
  | { studentId: string; ok: false; error: string };

export async function handleStudentAccounts(body: Record<string, unknown>, deps: StudentAccountsDeps): Promise<unknown> {
  const { caller } = deps;
  if (caller.kind !== "staff" || caller.disabled || !caller.role) {
    throw new HttpError(403, "교직원만 사용할 수 있습니다.");
  }
  switch (body.action) {
    case "issue":
      return { results: await issueAccounts(body.studentIds, deps) };
    // 비밀번호 재발급·계정만 삭제는 관리자만(사용자 요청). 발급과, 명단에서 학생을 지울 때 계정을 함께 지우는 건 담당 교사도 가능
    case "reset-password":
      requireAdmin(caller, "비밀번호 재발급은 관리자만 할 수 있습니다.");
      return await resetPassword(body.studentId, deps);
    case "delete": {
      const withStudent = body.withStudent === true;
      if (!withStudent) requireAdmin(caller, "계정 삭제는 관리자만 할 수 있습니다.");
      await deleteAccount(body.studentId, withStudent, deps);
      return { ok: true };
    }
    default:
      throw new HttpError(400, "알 수 없는 요청입니다.");
  }
}

// 문자에 넣을 로그인 주소: 호출한 화면의 주소(브라우저가 붙이는 Origin) + 화면이 보낸 경로 + login.html.
// GitHub Pages는 https://사용자.github.io/저장소/ 처럼 경로가 붙으므로 경로를 함께 받는다.
// 주소(도메인)는 Origin에서만 가져오므로 경로를 조작해도 다른 사이트 주소는 들어가지 않는다.
export function loginPageUrl(origin: string | null, appPath: unknown): string | null {
  if (!origin || !/^https?:\/\/[A-Za-z0-9.:-]+$/.test(origin)) return null;
  const path = typeof appPath === "string" && /^\/(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*$/.test(appPath) ? appPath : "/";
  return `${origin}${path}login.html`;
}

function requireAdmin(caller: Profile, message: string) {
  if (caller.role !== "admin") throw new HttpError(403, message);
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
  const issued: Issued[] = [];
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
    results.push({ studentId, ok: true, loginId, password, sms: "off" }); // sms는 아래에서 채움
    issued.push({ student, loginId, password });
  }
  const delivery = await sendPasswords(issued, deps);
  return results.map((r) => (r.ok ? withDelivery(r, delivery.get(r.studentId)) : r));
}

type Issued = { student: StudentRow; loginId: string; password: string };
type Delivery = { sms: SmsStatus; smsError?: string };

export function passwordText(issued: Issued, appUrl: string | null): string {
  return [
    `[기숙사 면학 시스템] ${issued.student.name} 학생 계정`,
    `아이디: ${issued.loginId}`,
    `비밀번호: ${issued.password}`,
    ...(appUrl ? [`접속: ${appUrl}`] : []),
    "로그인 화면에서 '학생' 탭을 골라 주세요.",
  ].join("\n");
}

// 학생 연락처로 비밀번호 문자를 한 번에 보낸다. 학생 id → 결과
async function sendPasswords(issued: Issued[], deps: StudentAccountsDeps): Promise<Map<string, Delivery>> {
  const delivery = new Map<string, Delivery>();
  const messages: SmsMessage[] = [];
  for (const item of issued) {
    if (!deps.sms) delivery.set(item.student.id, { sms: "off" });
    else if (!item.student.phone) delivery.set(item.student.id, { sms: "no-phone" });
    else messages.push({ key: item.student.id, to: item.student.phone, text: passwordText(item, deps.appUrl) });
  }
  if (deps.sms && messages.length > 0) {
    const results = await deps.sms.send(messages);
    for (const m of messages) {
      const r = results.get(m.key);
      delivery.set(m.key, r?.ok ? { sms: "sent" } : { sms: "failed", smsError: (r && !r.ok && r.error) || "발송 실패" });
    }
  }
  return delivery;
}

// 문자로 보냈으면 비밀번호는 응답에서 뺀다(화면에 남지 않게).
function withDelivery<T extends { password?: string }>(result: T, delivery: Delivery | undefined): T & Delivery {
  const d = delivery ?? { sms: "off" as const };
  if (d.sms === "sent") {
    const { password: _omit, ...rest } = result;
    return { ...(rest as T), ...d };
  }
  return { ...result, ...d };
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

async function resetPassword(
  rawStudentId: unknown,
  deps: StudentAccountsDeps,
): Promise<{ loginId: string; password?: string } & Delivery> {
  const { student, account } = await loadTarget(rawStudentId, deps);
  if (!account) throw new HttpError(404, "계정이 아직 발급되지 않았습니다.");
  const password = deps.generatePin();
  const { error } = await deps.auth.updateUserById(account.id, { password });
  if (error) throw new Error(`password reset failed: ${error.message}`);
  const delivery = await sendPasswords([{ student, loginId: account.login_id, password }], deps);
  return withDelivery({ loginId: account.login_id, password }, delivery.get(student.id));
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

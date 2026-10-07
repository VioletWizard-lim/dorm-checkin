// 교사(교직원) 계정 관리 — 관리자만 호출 가능.
//   create          : 계정 일괄 생성(항상 teacher로 생성, 승급은 계정 관리 화면에서 profiles 수정)
//   reset-password  : 새 비밀번호 발급(관리자가 정한 password가 있으면 그 값, 없으면 자동 생성. 응답으로 한 번만 돌려줌)
//   disable         : 로그인 차단(ban) + 역할·담당 범위 비우기
// 외부 호출(Auth Admin API, profiles 테이블)은 deps로 받아서 테스트에서 가짜로 바꿀 수 있게 한다.

import { HttpError } from "../_shared/http.ts";
import { normalizeStaffId, staffEmail } from "../_shared/accounts.ts";
import type { AuthLikeError, Profile } from "../_shared/types.ts";

const MAX_ACCOUNTS_PER_REQUEST = 200;
const MIN_PASSWORD_LENGTH = 6;
const MAX_PASSWORD_LENGTH = 72; // bcrypt가 72바이트까지만 씀
const BAN_FOREVER = "876000h";

export type StaffAccountsDeps = {
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
  profiles: {
    get(id: string): Promise<Profile | null>;
    insert(row: Record<string, unknown>): Promise<{ error: { message: string } | null }>;
    update(id: string, patch: Record<string, unknown>): Promise<{ error: { message: string } | null }>;
  };
  generatePassword(): string;
};

export type CreateResult =
  | { loginId: string; ok: true; userId: string; password?: string }
  | { loginId: string; ok: false; error: string };

export async function handleStaffAccounts(body: Record<string, unknown>, deps: StaffAccountsDeps): Promise<unknown> {
  const { caller } = deps;
  if (caller.kind !== "staff" || caller.role !== "admin" || caller.disabled) {
    throw new HttpError(403, "관리자만 사용할 수 있습니다.");
  }
  switch (body.action) {
    case "create":
      return { results: await createAccounts(body.accounts, deps) };
    case "reset-password":
      return { password: await resetPassword(body.userId, body.password, deps) };
    case "disable":
      await disableAccount(body.userId, deps);
      return { ok: true };
    default:
      throw new HttpError(400, "알 수 없는 요청입니다.");
  }
}

function describeAuthError(error: AuthLikeError): string {
  if (error.code === "email_exists" || error.code === "user_already_exists" || /already (been registered|exists)/i.test(error.message)) {
    return "이미 사용 중인 아이디입니다.";
  }
  if (error.code === "weak_password") return "비밀번호가 너무 짧거나 약합니다.";
  return "계정을 만들지 못했습니다.";
}

async function createAccounts(raw: unknown, deps: StaffAccountsDeps): Promise<CreateResult[]> {
  if (!Array.isArray(raw) || raw.length === 0) throw new HttpError(400, "만들 계정 목록이 비어 있습니다.");
  if (raw.length > MAX_ACCOUNTS_PER_REQUEST) {
    throw new HttpError(400, `한 번에 최대 ${MAX_ACCOUNTS_PER_REQUEST}개까지 만들 수 있습니다.`);
  }

  const seen = new Set<string>();
  const results: CreateResult[] = [];
  for (const item of raw) {
    const entry = (item ?? {}) as Record<string, unknown>;
    const rawId = String(entry.loginId ?? "").trim();
    const loginId = normalizeStaffId(rawId);
    if (!loginId) {
      results.push({ loginId: rawId, ok: false, error: "아이디는 영문과 숫자만 쓸 수 있습니다." });
      continue;
    }
    if (seen.has(loginId)) {
      results.push({ loginId, ok: false, error: "목록에 같은 아이디가 두 번 있습니다." });
      continue;
    }
    seen.add(loginId);

    const name = String(entry.name ?? "").trim().slice(0, 50) || null;
    const givenPassword = typeof entry.password === "string" && entry.password !== "" ? entry.password : null;
    if (givenPassword !== null && givenPassword.length < MIN_PASSWORD_LENGTH) {
      results.push({ loginId, ok: false, error: `비밀번호는 ${MIN_PASSWORD_LENGTH}자 이상이어야 합니다.` });
      continue;
    }
    const password = givenPassword ?? deps.generatePassword();

    const { data, error } = await deps.auth.createUser({
      email: staffEmail(loginId),
      password,
      email_confirm: true,
      app_metadata: { kind: "staff" },
    });
    if (error || !data.user) {
      results.push({ loginId, ok: false, error: error ? describeAuthError(error) : "계정을 만들지 못했습니다." });
      continue;
    }

    const { error: profileError } = await deps.profiles.insert({
      id: data.user.id,
      login_id: loginId,
      kind: "staff",
      role: "teacher",
      name,
    });
    if (profileError) {
      await deps.auth.deleteUser(data.user.id);
      results.push({ loginId, ok: false, error: "계정 정보를 저장하지 못했습니다." });
      continue;
    }

    // 직접 입력한 비밀번호는 관리자가 이미 알고 있으므로 자동 생성한 경우에만 돌려준다.
    results.push(givenPassword === null
      ? { loginId, ok: true, userId: data.user.id, password }
      : { loginId, ok: true, userId: data.user.id });
  }
  return results;
}

async function loadTargetStaff(rawUserId: unknown, deps: StaffAccountsDeps): Promise<Profile> {
  const userId = typeof rawUserId === "string" ? rawUserId : "";
  if (!userId) throw new HttpError(400, "대상 계정이 지정되지 않았습니다.");
  if (userId === deps.caller.id) throw new HttpError(400, "본인 계정에는 사용할 수 없습니다.");
  const target = await deps.profiles.get(userId);
  if (!target || target.kind !== "staff") throw new HttpError(404, "교직원 계정을 찾을 수 없습니다.");
  return target;
}

async function resetPassword(rawUserId: unknown, rawPassword: unknown, deps: StaffAccountsDeps): Promise<string> {
  const target = await loadTargetStaff(rawUserId, deps);
  if (target.disabled) throw new HttpError(400, "삭제(비활성화)된 계정입니다.");
  const givenPassword = typeof rawPassword === "string" && rawPassword !== "" ? rawPassword : null;
  if (givenPassword !== null && givenPassword.length < MIN_PASSWORD_LENGTH) {
    throw new HttpError(400, `비밀번호는 ${MIN_PASSWORD_LENGTH}자 이상이어야 합니다.`);
  }
  if (givenPassword !== null && new TextEncoder().encode(givenPassword).length > MAX_PASSWORD_LENGTH) {
    throw new HttpError(400, "비밀번호가 너무 깁니다.");
  }
  const password = givenPassword ?? deps.generatePassword();
  const { error } = await deps.auth.updateUserById(target.id, { password });
  if (error) throw new Error(`password reset failed: ${error.message}`);
  return password;
}

async function disableAccount(rawUserId: unknown, deps: StaffAccountsDeps): Promise<void> {
  const target = await loadTargetStaff(rawUserId, deps);
  const { error } = await deps.auth.updateUserById(target.id, { ban_duration: BAN_FOREVER });
  if (error) throw new Error(`ban failed: ${error.message}`);
  const { error: profileError } = await deps.profiles.update(target.id, {
    disabled: true,
    role: null,
    managed_grades: [],
    managed_rooms: [],
    managed_classes: [],
  });
  if (profileError) throw new Error(`profile update failed: ${profileError.message}`);
}

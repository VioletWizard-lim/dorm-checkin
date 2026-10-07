// 로그인 아이디 ↔ 내부 이메일 변환, 비밀번호 생성. 화면(login.js)과 같은 규칙을 써야 한다.
// Supabase Auth는 아이디만으로 로그인할 수 없어서, 사용자는 아이디만 입력하고 코드 안에서만 이메일 형식으로 바꾼다.

export const STAFF_EMAIL_DOMAIN = "donghall.local";
export const STUDENT_EMAIL_DOMAIN = "student.donghall.local";

const STAFF_ID_PATTERN = /^[a-z0-9]{1,32}$/;
const STUDENT_ID_PATTERN = /^[a-z0-9._-]{1,64}$/;
const PASSWORD_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";

export type RandomInts = (count: number) => Uint32Array;

const cryptoRandomInts: RandomInts = (count) => crypto.getRandomValues(new Uint32Array(count));

export function normalizeStaffId(raw: unknown): string | null {
  const value = String(raw ?? "").trim().toLowerCase();
  return STAFF_ID_PATTERN.test(value) ? value : null;
}

export function normalizeStudentId(raw: unknown): string | null {
  const value = String(raw ?? "").trim().toLowerCase();
  return STUDENT_ID_PATTERN.test(value) ? value : null;
}

export const staffEmail = (loginId: string) => `${loginId}@${STAFF_EMAIL_DOMAIN}`;
export const studentEmail = (loginId: string) => `${loginId}@${STUDENT_EMAIL_DOMAIN}`;

export function randomPassword(length = 8, randomInts: RandomInts = cryptoRandomInts): string {
  return Array.from(randomInts(length), (n) => PASSWORD_CHARS[n % PASSWORD_CHARS.length]).join("");
}

// 학생 초기·재발급 비밀번호: 6자리 숫자(Supabase 최소 길이 6).
export function randomPin(digits = 6, randomInts: RandomInts = cryptoRandomInts): string {
  return Array.from(randomInts(digits), (n) => String(n % 10)).join("");
}

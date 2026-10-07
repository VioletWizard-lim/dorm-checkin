// 모든 화면이 공유하는 Supabase 클라이언트와 로그인·권한 확인 도우미.
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/+esm";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, STAFF_EMAIL_DOMAIN, STUDENT_EMAIL_DOMAIN } from "./supabase-config.js";
import { studentFromRow, userFromProfile } from "./adapters.js";

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

// 사용자는 아이디만 입력하고, Supabase Auth에는 코드 안에서만 이메일 형식으로 바꿔 넘긴다.
export function staffEmail(loginId) {
  return `${String(loginId).trim().toLowerCase()}@${STAFF_EMAIL_DOMAIN}`;
}

// 학생은 리로스쿨 ID로 로그인한다.
export function studentEmail(loginId) {
  return `${String(loginId).trim().toLowerCase()}@${STUDENT_EMAIL_DOMAIN}`;
}

let leaving = false;

// 이 기기에서만 로그아웃한다(다른 기기·전자칠판의 로그인은 그대로 둔다).
export async function signOutTo(target = "./login.html") {
  leaving = true;
  try {
    await supabase.auth.signOut({ scope: "local" });
  } catch (err) {
    // 세션이 이미 없어도 로그인 화면으로는 보낸다.
  }
  window.location.replace(target);
}

// 세션과 내 프로필(profiles 행)을 읽는다. 로그인 화면으로 보내는 중이면 null.
async function loadOwnProfile() {
  const { data } = await supabase.auth.getSession();
  const session = data && data.session;
  if (!session) {
    window.location.replace("./login.html");
    return null;
  }

  // 다른 탭에서 로그아웃했거나 세션이 끝나면 로그인 화면으로 돌아간다.
  supabase.auth.onAuthStateChange((event) => {
    if (event === "SIGNED_OUT" && !leaving) window.location.replace("./login.html");
  });

  const { data: row, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", session.user.id)
    .maybeSingle();
  if (error) {
    showPageError(`계정 정보를 불러오지 못했습니다(${describeError(error)}). 새로고침해 주세요.`);
    return null;
  }
  if (!row || row.disabled) {
    await signOutTo("./login.html?disabled=1");
    return null;
  }
  return row;
}

// 교직원 화면 공통 진입: 세션과 프로필을 확인한다.
// - 로그인 안 됨 → login.html / 학생 계정 → student.html
// - 삭제(비활성화)됐거나 역할이 없는 계정 → 로그아웃 후 login.html?disabled=1
// - 그 외 → { uid, loginId, profile } (profile은 예전 users/{uid} 모양, adapters.js 참고)
// 다른 곳으로 보내는 중이면 null을 돌려준다.
export async function requireStaff() {
  const row = await loadOwnProfile();
  if (!row) return null;
  if (row.kind === "student") {
    window.location.replace("./student.html");
    return null;
  }
  if (!row.role) {
    await signOutTo("./login.html?disabled=1");
    return null;
  }
  return { uid: row.id, loginId: row.login_id, profile: userFromProfile(row) };
}

// 학생 화면 진입: 학생 계정이면 { uid, loginId, student }(student는 students 행을 화면 모양으로 바꾼 것 + id).
// 교직원 계정이면 check.html로 보낸다.
export async function requireStudent() {
  const row = await loadOwnProfile();
  if (!row) return null;
  if (row.kind !== "student") {
    window.location.replace("./check.html");
    return null;
  }
  const { data: studentRow, error } = await supabase.from("students").select("*").eq("id", row.student_id).maybeSingle();
  if (error) {
    showPageError(`학생 정보를 불러오지 못했습니다(${describeError(error)}). 새로고침해 주세요.`);
    return null;
  }
  if (!studentRow) {
    await signOutTo("./login.html?disabled=1");
    return null;
  }
  return { uid: row.id, loginId: row.login_id, student: { id: studentRow.id, ...studentFromRow(studentRow) } };
}

// Supabase 에러 → 화면에 보여줄 문장
export function describeError(error) {
  if (!error) return "알 수 없는 오류가 발생했습니다.";
  const message = String(error.message || error);
  // RPC·트리거·Edge Function이 직접 낸 한국어 안내는 그대로 보여준다.
  if (/[가-힣]/.test(message)) return message;
  if (error.code === "42501" || /row-level security|permission denied/i.test(message)) {
    return "권한이 없습니다.";
  }
  if (/failed to fetch|networkerror|load failed|network request failed/i.test(message)) {
    return "네트워크 연결을 확인해 주세요.";
  }
  if (error.code === "23505") return "이미 같은 값이 등록되어 있습니다.";
  if (error.code === "23514" || error.code === "22P02") return "입력값 형식이 올바르지 않습니다.";
  return message || "알 수 없는 오류가 발생했습니다.";
}

// Edge Function 호출. 실패하면 함수가 돌려준 한국어 메시지를 담은 Error를 던진다.
export async function callFunction(name, body) {
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (!error) return data;
  let message = "서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.";
  const response = error.context;
  if (response && typeof response.json === "function") {
    try {
      const payload = await response.json();
      if (payload && typeof payload.error === "string") message = payload.error;
    } catch (err) {
      // 기본 메시지 사용
    }
  }
  throw new Error(message);
}

// 화면 맨 위에 오류 안내를 띄운다(같은 문구는 한 번만).
export function showPageError(message) {
  const container = document.querySelector(".check-page, .student-page") || document.body;
  const existing = Array.from(container.querySelectorAll(".page-error")).find((el) => el.textContent === message);
  if (existing) return;
  const box = document.createElement("div");
  box.className = "alert alert-error page-error";
  box.textContent = message;
  container.prepend(box);
}

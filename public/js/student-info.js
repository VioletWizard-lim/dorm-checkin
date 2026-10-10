// 학생 화면의 "개인정보 수정" 탭(사용자 요청): 비밀번호로 본인 확인을 한 뒤
//   - 내 정보 보기(이름·학번·반·아이디·학부모 연락처 — 학부모 연락처는 외출 안내 문자가 가는 번호라 학생이 못 바꿈)
//   - 내 연락처·이메일 수정(RPC update_my_contact)
//   - 비밀번호 바꾸기(supabase.auth.updateUser, user_metadata.password_changed = true — 학생 화면의 안내가 사라짐)
// 본인 확인 = 그 비밀번호로 다시 로그인. 최근 로그인이라 Supabase의 비밀번호 변경 조건도 만족한다.
import { supabase, describeError } from "./supabase-client.js";
import { formatPhone, normalizePhone } from "./adapters.js";

const verifySection = document.getElementById("verifySection");
const verifyForm = document.getElementById("verifyForm");
const verifyPassword = document.getElementById("verifyPassword");
const verifyBtn = document.getElementById("verifyBtn");
const verifyHint = document.getElementById("verifyHint");
const infoSection = document.getElementById("infoSection");
const passwordSection = document.getElementById("passwordSection");
const contactForm = document.getElementById("contactForm");
const phoneInput = document.getElementById("phoneInput");
const emailInput = document.getElementById("emailInput");
const contactBtn = document.getElementById("contactBtn");
const contactHint = document.getElementById("contactHint");
const passwordForm = document.getElementById("passwordForm");
const newPasswordInput = document.getElementById("newPassword");
const newPasswordConfirmInput = document.getElementById("newPasswordConfirm");
const passwordBtn = document.getElementById("passwordBtn");
const passwordHint = document.getElementById("passwordHint");
const passwordNotice = document.getElementById("passwordNotice"); // 화면 맨 위 "처음 받은 비밀번호" 안내

let session = null;
let verifiedPassword = ""; // 본인 확인한 비밀번호(새 비밀번호가 같은지 보려고만, 이 화면에만 둔다)

function setHint(el, text, ok = false) {
  el.textContent = text;
  el.classList.toggle("field-hint--ok", ok);
}

function checkNewPassword(current, next, confirm) {
  if (next.length < 8) return "새 비밀번호는 8자 이상이어야 해요.";
  if (!/[A-Za-z]/.test(next) || !/[0-9]/.test(next)) return "새 비밀번호에 영문과 숫자를 함께 넣어 주세요.";
  if (next !== confirm) return "새 비밀번호 확인이 다릅니다.";
  if (next === current) return "지금 비밀번호와 다른 비밀번호로 바꿔 주세요.";
  return null;
}

function showPasswordNotice(user) {
  passwordNotice.hidden = Boolean(user && user.user_metadata && user.user_metadata.password_changed === true);
}

async function loadMyInfo() {
  const { data, error } = await supabase.rpc("student_contacts");
  if (error) throw error;
  const mine = (data || []).find((row) => row.id === session.student.id) || {};
  const s = session.student;
  document.getElementById("infoName").textContent = s.name || "-";
  document.getElementById("infoClass").textContent = `${s.sid || "-"} · ${s.cls || "-"}`;
  document.getElementById("infoLoginId").textContent = mine.login_id || session.loginId || "-";
  document.getElementById("infoParentPhone").textContent = mine.parent_phone ? formatPhone(mine.parent_phone) : "등록 안 됨";
  phoneInput.value = formatPhone(mine.phone || "");
  emailInput.value = mine.email || "";
}

verifyForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const password = verifyPassword.value;
  if (!password) {
    setHint(verifyHint, "비밀번호를 입력해 주세요.");
    return;
  }
  verifyBtn.disabled = true;
  setHint(verifyHint, "확인 중...");
  try {
    const { data: userData } = await supabase.auth.getUser();
    const email = userData && userData.user && userData.user.email;
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setHint(verifyHint, "비밀번호가 맞지 않습니다. 잊었으면 관리자(임재성 선생님)에게 말씀해 주세요.");
      return;
    }
    await loadMyInfo();
    verifiedPassword = password;
    verifyPassword.value = "";
    verifySection.hidden = true;
    infoSection.hidden = false;
    passwordSection.hidden = false;
    showPasswordNotice(data.user);
  } catch (err) {
    setHint(verifyHint, `정보를 불러오지 못했습니다: ${describeError(err)}`);
  } finally {
    verifyBtn.disabled = false;
  }
});

contactForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const phone = normalizePhone(phoneInput.value);
  if (phone === null) {
    setHint(contactHint, "연락처는 010으로 시작하는 휴대폰 번호로 입력해 주세요(예: 010-1234-5678).");
    return;
  }
  contactBtn.disabled = true;
  setHint(contactHint, "저장 중...");
  const { error } = await supabase.rpc("update_my_contact", { p_phone: phone, p_email: emailInput.value.trim() });
  contactBtn.disabled = false;
  if (error) {
    setHint(contactHint, `저장하지 못했습니다: ${describeError(error)}`);
    return;
  }
  phoneInput.value = formatPhone(phone);
  setHint(contactHint, "저장했어요.", true);
});

passwordForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const next = newPasswordInput.value;
  const problem = checkNewPassword(verifiedPassword, next, newPasswordConfirmInput.value);
  if (problem) {
    setHint(passwordHint, problem);
    return;
  }
  passwordBtn.disabled = true;
  setHint(passwordHint, "바꾸는 중...");
  try {
    const { data, error } = await supabase.auth.updateUser({ password: next, data: { password_changed: true } });
    if (error) {
      setHint(
        passwordHint,
        error.code === "same_password"
          ? "지금 비밀번호와 다른 비밀번호로 바꿔 주세요."
          : error.code === "weak_password"
            ? "너무 쉬운 비밀번호예요. 다른 비밀번호로 바꿔 주세요."
            : error.code === "reauthentication_needed"
              ? "다시 로그인한 뒤 바꿔 주세요."
              : `바꾸지 못했습니다: ${describeError(error)}`
      );
      return;
    }
    verifiedPassword = next;
    passwordForm.reset();
    setHint(passwordHint, "비밀번호를 바꿨어요. 다음 로그인부터 새 비밀번호를 쓰세요.", true);
    showPasswordNotice(data.user);
  } finally {
    passwordBtn.disabled = false;
  }
});

// student.js가 로그인 확인 뒤 부른다. 처음 받은 비밀번호를 쓰는 학생에게는 맨 위에 바꾸라는 안내를 띄운다
export function initStudentInfo(studentSession) {
  session = studentSession;
  supabase.auth.getUser().then(({ data }) => showPasswordNotice(data && data.user));
}

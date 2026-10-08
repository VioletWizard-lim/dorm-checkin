import { supabase, staffEmail, studentEmail } from "./supabase-client.js";
import { markActivity } from "./idle-logout.js";

const MODE_STORAGE_KEY = "dormcheckin.loginMode";

// 교사/학생 탭별 설정. 학생 아이디는 영문·숫자와 . _ -
const MODES = {
  staff: {
    idStorageKey: "dormcheckin.savedUserId",
    idPattern: /^[A-Za-z0-9]+$/,
    idPatternMessage: "아이디는 영문과 숫자만 사용할 수 있습니다.",
    idLabel: "아이디",
    idPlaceholder: "아이디 입력",
    subtitle: "교사 계정으로 로그인해 주세요",
    footer: "계정이 없으신가요? 관리자(임재성)에게 발급을 요청해 주세요.",
    toEmail: staffEmail,
    target: "./check.html",
  },
  student: {
    idStorageKey: "dormcheckin.savedStudentId",
    idPattern: /^[A-Za-z0-9._-]+$/,
    idPatternMessage: "아이디는 영문·숫자와 . _ - 만 사용할 수 있습니다.",
    idLabel: "아이디",
    idPlaceholder: "아이디 입력",
    subtitle: "학생 계정으로 로그인해 주세요",
    footer: "계정이 없거나 비밀번호를 잊었으면 담임 선생님께 말씀해 주세요.",
    toEmail: studentEmail,
    target: "./student.html",
  },
};

const form = document.getElementById("loginForm");
const userIdInput = document.getElementById("userId");
const userIdLabel = document.getElementById("userIdLabel");
const passwordInput = document.getElementById("password");
const rememberCheckbox = document.getElementById("rememberMe");
const submitButton = document.getElementById("submitBtn");
const errorBox = document.getElementById("errorBox");
const noticeBox = document.getElementById("noticeBox");
const subtitleEl = document.getElementById("loginSubtitle");
const footerEl = document.getElementById("loginFooter");
const tabButtons = Array.from(document.querySelectorAll("[data-login-mode]"));

let mode = "staff";

function readStorage(key) {
  try {
    return localStorage.getItem(key);
  } catch (err) {
    return null;
  }
}

function writeStorage(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch (err) {
    // 저장소를 쓸 수 없으면 기억하지 않는다.
  }
}

function setFieldError(hasError) {
  userIdInput.classList.toggle("has-error", hasError);
  passwordInput.classList.toggle("has-error", hasError);
}

function showError(message) {
  noticeBox.hidden = true;
  errorBox.textContent = message;
  errorBox.hidden = false;
  setFieldError(true);
}

function showNotice(message) {
  errorBox.hidden = true;
  noticeBox.textContent = message;
  noticeBox.hidden = false;
}

function clearMessages() {
  errorBox.hidden = true;
  noticeBox.hidden = true;
  setFieldError(false);
}

function setSubmitting(isSubmitting) {
  submitButton.disabled = isSubmitting;
  submitButton.textContent = isSubmitting ? "로그인 중..." : "로그인";
}

function mapAuthError(error) {
  switch (error && error.code) {
    case "invalid_credentials":
      return "아이디 또는 비밀번호가 올바르지 않습니다. 교사/학생 탭이 맞는지도 확인해 주세요.";
    case "user_banned":
      return "삭제(비활성화)된 계정입니다. 관리자에게 문의해 주세요.";
    case "over_request_rate_limit":
      return "로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.";
    default:
      break;
  }
  if (error && error.status === 429) return "로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.";
  if (error && error.name === "AuthRetryableFetchError") return "네트워크 연결을 확인해 주세요.";
  return "로그인 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.";
}

// 탭을 바꾸면 안내 문구·저장된 아이디도 그 탭 것으로 바꾼다(마지막으로 고른 탭은 기억).
function setMode(nextMode) {
  mode = MODES[nextMode] ? nextMode : "staff";
  const config = MODES[mode];
  for (const btn of tabButtons) {
    const active = btn.dataset.loginMode === mode;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-selected", String(active));
  }
  userIdLabel.textContent = config.idLabel;
  userIdInput.placeholder = config.idPlaceholder;
  subtitleEl.textContent = config.subtitle;
  footerEl.textContent = config.footer;
  const savedId = readStorage(config.idStorageKey);
  userIdInput.value = savedId || "";
  rememberCheckbox.checked = Boolean(savedId);
  passwordInput.value = "";
  writeStorage(MODE_STORAGE_KEY, mode);
}

for (const btn of tabButtons) {
  btn.addEventListener("click", () => {
    clearMessages();
    setMode(btn.dataset.loginMode);
  });
}

setMode(readStorage(MODE_STORAGE_KEY) || "staff");

if (new URLSearchParams(window.location.search).get("disabled") === "1") {
  showError("삭제(비활성화)된 계정입니다. 관리자에게 문의해 주세요.");
} else if (new URLSearchParams(window.location.search).get("idle") === "1") {
  showNotice("2시간 동안 사용하지 않아 자동으로 로그아웃되었습니다. 다시 로그인해 주세요.");
}

// 이미 로그인돼 있으면 계정 종류에 맞는 화면으로(학생 계정은 만들 때 app_metadata.kind = "student").
supabase.auth.getSession().then(({ data }) => {
  const session = data && data.session;
  if (!session) return;
  const kind = session.user && session.user.app_metadata && session.user.app_metadata.kind;
  window.location.replace(kind === "student" ? MODES.student.target : MODES.staff.target);
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearMessages();
  const config = MODES[mode];

  const userId = userIdInput.value.trim();
  const password = passwordInput.value;

  if (!userId || !password) {
    showError("아이디와 비밀번호를 입력해 주세요.");
    return;
  }

  if (!config.idPattern.test(userId)) {
    showError(config.idPatternMessage);
    return;
  }

  setSubmitting(true);
  showNotice("로그인 확인 중입니다...");

  writeStorage(config.idStorageKey, rememberCheckbox.checked ? userId : null);

  const { error } = await supabase.auth.signInWithPassword({ email: config.toEmail(userId), password });
  if (error) {
    setSubmitting(false);
    showError(mapAuthError(error));
    return;
  }
  markActivity(); // 예전 기록 때문에 로그인하자마자 자동 로그아웃되지 않게
  window.location.replace(config.target);
});

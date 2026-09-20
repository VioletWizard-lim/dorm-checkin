import { auth } from "./firebase-init.js";
import { FAKE_EMAIL_DOMAIN } from "./firebase-config.js";
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";

const REDIRECT_TARGET = "./check.html";
const ID_STORAGE_KEY = "dormcheckin.savedUserId";
const ID_PATTERN = /^[A-Za-z0-9]+$/;

const form = document.getElementById("loginForm");
const userIdInput = document.getElementById("userId");
const passwordInput = document.getElementById("password");
const rememberCheckbox = document.getElementById("rememberMe");
const submitButton = document.getElementById("submitBtn");
const errorBox = document.getElementById("errorBox");
const noticeBox = document.getElementById("noticeBox");

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

function mapAuthError(code) {
  switch (code) {
    case "auth/invalid-credential":
    case "auth/user-not-found":
    case "auth/wrong-password":
      return "아이디 또는 비밀번호가 올바르지 않습니다.";
    case "auth/too-many-requests":
      return "로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.";
    case "auth/user-disabled":
      return "사용이 중지된 계정입니다. 관리자에게 문의해 주세요.";
    case "auth/network-request-failed":
      return "네트워크 연결을 확인해 주세요.";
    default:
      return "로그인 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.";
  }
}

const savedId = localStorage.getItem(ID_STORAGE_KEY);
if (savedId) {
  userIdInput.value = savedId;
  rememberCheckbox.checked = true;
}

if (new URLSearchParams(window.location.search).get("disabled") === "1") {
  showError("삭제(비활성화)된 계정입니다. 관리자에게 문의해 주세요.");
}

onAuthStateChanged(auth, (user) => {
  if (user) {
    window.location.replace(REDIRECT_TARGET);
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearMessages();

  const userId = userIdInput.value.trim();
  const password = passwordInput.value;

  if (!userId || !password) {
    showError("아이디와 비밀번호를 입력해 주세요.");
    return;
  }

  if (!ID_PATTERN.test(userId)) {
    showError("아이디는 영문과 숫자만 사용할 수 있습니다.");
    return;
  }

  setSubmitting(true);
  showNotice("로그인 확인 중입니다...");

  if (rememberCheckbox.checked) {
    localStorage.setItem(ID_STORAGE_KEY, userId);
  } else {
    localStorage.removeItem(ID_STORAGE_KEY);
  }

  try {
    const email = `${userId}@${FAKE_EMAIL_DOMAIN}`;
    await signInWithEmailAndPassword(auth, email, password);
  } catch (err) {
    setSubmitting(false);
    showError(mapAuthError(err.code));
  }
});

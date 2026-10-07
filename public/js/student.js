// 학생 화면: 오늘 내 상태 보기, 외출 신청·취소, 오늘 신청 내역(승인·반려 결과 실시간 반영).
// 신청·취소는 RPC(create_outing_request·cancel_outing_request)로만 한다 — 학생 정보는 서버가 로그인 계정으로 찾는다.
import { supabase, requireStudent, signOutTo, describeError, showPageError } from "./supabase-client.js";
import { liveTable } from "./live-table.js";
import { studentFromRow } from "./adapters.js";

function getDateKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
const TODAY_KEY = getDateKey();

const nameEl = document.getElementById("studentName");
const metaEl = document.getElementById("studentMeta");
const todayDateEl = document.getElementById("todayDate");
const statusBox = document.getElementById("statusBox");
const requestForm = document.getElementById("requestForm");
const reasonInput = document.getElementById("reasonInput");
const startHour = document.getElementById("startHour");
const startMinute = document.getElementById("startMinute");
const returnHour = document.getElementById("returnHour");
const returnMinute = document.getElementById("returnMinute");
const timeSelects = [startHour, startMinute, returnHour, returnMinute];
const requestBtn = document.getElementById("requestBtn");
const requestHint = document.getElementById("requestHint");
const requestListEl = document.getElementById("requestList");
const logoutBtn = document.getElementById("logoutBtn");

const STATUS_META = {
  in: { badge: "재실", badgeClass: "status-badge--in" },
  out: { badge: "외출중", badgeClass: "status-badge--out" },
  away: { badge: "자리 없음", badgeClass: "status-badge--away" },
  leave: { badge: "명령퇴사", badgeClass: "status-badge--leave" },
};

const REQUEST_META = {
  pending: { label: "승인 대기", chipClass: "request-chip--pending" },
  approved: { label: "승인됨", chipClass: "request-chip--approved" },
  rejected: { label: "반려됨", chipClass: "request-chip--rejected" },
  cancelled: { label: "취소함", chipClass: "request-chip--cancelled" },
};

const state = {
  student: null,
  outing: null,
  requests: [],
  requestsLoaded: false,
  submitting: false,
};
let requestsLive = null;
let outingsLive = null;

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatTime(value) {
  if (!value) return "";
  const d = new Date(value);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// 시·분 선택 칸. 목록이 끝에서 멈추도록 <select>를 쓴다(브라우저 시간 선택기는 분이 계속 돌아감).
function fillTimeSelect(select, count, unit, blankLabel) {
  const options = blankLabel ? [`<option value="">${blankLabel}</option>`] : [];
  for (let i = 0; i < count; i += 1) {
    const value = String(i).padStart(2, "0");
    options.push(`<option value="${value}">${value}${unit}</option>`);
  }
  select.innerHTML = options.join("");
}
fillTimeSelect(startHour, 24, "시");
fillTimeSelect(startMinute, 60, "분");
fillTimeSelect(returnHour, 24, "시", "-- 시");
fillTimeSelect(returnMinute, 60, "분", "-- 분");

// 외출 시각 기본값 = 지금
function resetTimeSelects() {
  const now = new Date();
  startHour.value = String(now.getHours()).padStart(2, "0");
  startMinute.value = String(now.getMinutes()).padStart(2, "0");
  returnHour.value = "";
  returnMinute.value = "";
}
resetTimeSelects();

// 화면을 오래 켜 두었다가 다시 보면 외출 시각 기본값을 지금으로 다시 맞춘다(직접 고친 뒤에는 그대로).
let startTouched = false;
startHour.addEventListener("change", () => (startTouched = true));
startMinute.addEventListener("change", () => (startTouched = true));
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && !startTouched && !state.submitting) {
    const keepReturn = [returnHour.value, returnMinute.value];
    resetTimeSelects();
    [returnHour.value, returnMinute.value] = keepReturn;
  }
});

// 복귀 시각은 시만 골라도 되게(분은 00), 시를 비우면 분도 비운다.
returnHour.addEventListener("change", () => {
  if (!returnHour.value) returnMinute.value = "";
  else if (!returnMinute.value) returnMinute.value = "00";
});
returnMinute.addEventListener("change", () => {
  if (returnMinute.value && !returnHour.value) returnHour.value = startHour.value;
  if (!returnMinute.value) returnHour.value = "";
});

function formatToday() {
  const days = ["일", "월", "화", "수", "목", "금", "토"];
  const now = new Date();
  return `${now.getMonth() + 1}월 ${now.getDate()}일 (${days[now.getDay()]})`;
}

function isOnLeave(student) {
  const leave = student && student.leaveOfAbsence;
  return Boolean(leave && leave.from && leave.to && TODAY_KEY >= leave.from && TODAY_KEY <= leave.to);
}

function currentStatus() {
  if (isOnLeave(state.student)) return "leave";
  const status = state.outing && state.outing.status;
  if (status === "out") return "out";
  if (status === "away") return "away";
  return "in";
}

function renderStatus() {
  const status = currentStatus();
  const meta = STATUS_META[status];
  let detail = "기숙사에 있는 것으로 표시되어 있습니다.";
  if (status === "leave") {
    const leave = state.student.leaveOfAbsence;
    detail = `${leave.from} ~ ${leave.to} 명령퇴사 기간입니다.${leave.reason ? ` (${leave.reason})` : ""}`;
  } else if (status === "out") {
    const o = state.outing;
    const parts = [`${o.start_time || formatTime(o.since)}부터 외출 중`];
    if (o.reason) parts.push(`사유: ${o.reason}`);
    if (o.expected_return) parts.push(`예상 복귀 ${o.expected_return}`);
    if (o.checked_by_name) parts.push(`${o.checked_by_name} 선생님 확인`);
    detail = parts.join(" · ");
  } else if (status === "away") {
    detail = `${formatTime(state.outing.since)}에 자리 없음으로 표시되었습니다. 사감 선생님께 확인해 주세요.`;
  }
  statusBox.innerHTML = `
    <div class="status-badge ${meta.badgeClass}">${meta.badge}</div>
    <div class="my-status__detail">${escapeHtml(detail)}</div>
  `;
}

// 신청할 수 없는 이유(없으면 빈 문자열). 서버(create_outing_request)도 같은 조건을 검사한다.
function blockedReason() {
  const status = currentStatus();
  if (status === "leave") return "명령퇴사 기간에는 외출을 신청할 수 없습니다.";
  if (status === "out") return "이미 외출 중입니다. 복귀 체크는 사감 선생님이 합니다.";
  if (state.requests.some((r) => r.status === "pending")) {
    return "승인을 기다리는 신청이 있습니다. 취소한 뒤 다시 신청할 수 있습니다.";
  }
  return "";
}

function renderForm() {
  const blocked = blockedReason();
  const ready = state.requestsLoaded && !state.submitting;
  reasonInput.disabled = Boolean(blocked);
  for (const select of timeSelects) select.disabled = Boolean(blocked);
  requestBtn.disabled = !ready || Boolean(blocked);
  requestBtn.textContent = state.submitting ? "신청 중..." : "외출 신청";
  requestHint.textContent = blocked || "담임 선생님(또는 학년부장·기숙사부 선생님)이 승인하면 바로 외출로 처리됩니다.";
}

function renderRequests() {
  if (!state.requestsLoaded) return;
  const requests = state.requests.slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  if (requests.length === 0) {
    requestListEl.innerHTML = `<span class="student-empty">오늘 신청한 외출이 없습니다.</span>`;
    return;
  }
  requestListEl.innerHTML = requests
    .map((r) => {
      const meta = REQUEST_META[r.status] || REQUEST_META.pending;
      const times = [];
      if (r.start_time) times.push(`외출 ${r.start_time}`);
      if (r.expected_return) times.push(`예상 복귀 ${r.expected_return}`);
      const lines = [[`신청 ${formatTime(r.created_at)}`, ...times].join(" · ")];
      if (r.status === "approved") lines.push(`${formatTime(r.decided_at)} ${r.decided_by_name || ""} 선생님 승인`);
      if (r.status === "rejected") {
        lines.push(`${formatTime(r.decided_at)} ${r.decided_by_name || ""} 선생님 반려${r.reject_reason ? ` · 사유: ${r.reject_reason}` : ""}`);
      }
      return `
        <div class="request-item">
          <div class="request-item__top">
            <div class="request-item__reason">${escapeHtml(r.reason)}</div>
            <span class="request-chip ${meta.chipClass}">${meta.label}</span>
          </div>
          ${lines.map((line) => `<div class="request-item__meta">${escapeHtml(line)}</div>`).join("")}
          ${
            r.status === "pending"
              ? `<div><button type="button" class="btn-secondary btn-small" data-cancel-request="${escapeHtml(r.id)}">신청 취소</button></div>`
              : ""
          }
        </div>
      `;
    })
    .join("");
}

function render() {
  if (!state.student) return;
  renderStatus();
  renderForm();
  renderRequests();
}

requestForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const reason = reasonInput.value.trim();
  if (!reason) {
    alert("외출 사유를 입력해 주세요.");
    reasonInput.focus();
    return;
  }
  const startTime = `${startHour.value}:${startMinute.value}`;
  const expectedReturn = returnHour.value ? `${returnHour.value}:${returnMinute.value || "00"}` : "";
  if (expectedReturn && expectedReturn <= startTime) {
    alert("예상 복귀 시각은 외출 시각보다 늦어야 합니다.");
    returnHour.focus();
    return;
  }
  state.submitting = true;
  renderForm();
  const { error } = await supabase.rpc("create_outing_request", {
    p_reason: reason,
    p_start_time: startTime,
    p_expected_return: expectedReturn || null,
  });
  if (error) {
    state.submitting = false;
    renderForm();
    alert(`신청하지 못했습니다: ${describeError(error)}`);
    return;
  }
  reasonInput.value = "";
  resetTimeSelects();
  startTouched = false;
  if (requestsLive) await requestsLive.refresh();
  state.submitting = false;
  render();
});

requestListEl.addEventListener("click", async (event) => {
  const btn = event.target.closest("[data-cancel-request]");
  if (!btn) return;
  if (!window.confirm("이 외출 신청을 취소할까요?")) return;
  btn.disabled = true;
  const { error } = await supabase.rpc("cancel_outing_request", { p_request_id: btn.dataset.cancelRequest });
  if (error) {
    btn.disabled = false;
    alert(`취소하지 못했습니다: ${describeError(error)}`);
    return;
  }
  if (requestsLive) await requestsLive.refresh();
});

logoutBtn.addEventListener("click", () => signOutTo());

function reportLoadError(error) {
  showPageError(`데이터를 불러오지 못했습니다(${describeError(error)}). 잠시 후 자동으로 다시 시도합니다.`);
}

async function init() {
  const session = await requireStudent();
  if (!session) return;
  state.student = session.student;
  nameEl.textContent = state.student.name || session.loginId;
  metaEl.textContent = `학번 ${state.student.sid || "-"} · ${state.student.cls || "-"}`;
  todayDateEl.textContent = formatToday();
  render();

  const studentId = state.student.id;
  requestsLive = liveTable({
    table: "outing_requests",
    eq: { student_id: studentId, date: TODAY_KEY },
    order: ["created_at", "id"],
    onRows: (rows) => {
      state.requests = rows;
      state.requestsLoaded = true;
      render();
    },
    onError: reportLoadError,
  });
  outingsLive = liveTable({
    table: "outings",
    eq: { student_id: studentId, date: TODAY_KEY },
    order: ["date"],
    onRows: (rows) => {
      state.outing = rows[0] || null;
      render();
    },
    onError: reportLoadError,
  });
  // 명령퇴사 기간 등 내 정보가 바뀌어도 반영
  liveTable({
    table: "students",
    eq: { id: studentId },
    order: ["id"],
    onRows: (rows) => {
      if (rows[0]) state.student = { id: rows[0].id, ...studentFromRow(rows[0]) };
      render();
    },
    onError: reportLoadError,
  });
}

init();

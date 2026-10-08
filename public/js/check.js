import { supabase, requireStaff, signOutTo, describeError, showPageError, callFunction } from "./supabase-client.js";
import { liveTable } from "./live-table.js";
import {
  GRADES,
  groupStudentsByGrade,
  outingsByStudent,
  roomsById,
  isScheduledOuting,
  createStartTimeTicker,
} from "./adapters.js";

let currentTeacherId = "";
let currentTeacherName = "";

const manageLink = document.getElementById("manageLink");
const accountsLink = document.getElementById("accountsLink");
const displayLink = document.getElementById("displayLink");
const seatLink = document.getElementById("seatLink");
const navLoadingHint = document.getElementById("navLoadingHint");
const logoutBtn = document.getElementById("logoutBtn");
const currentUserNameEl = document.getElementById("currentUserName");
const currentUserRoleBadgeEl = document.getElementById("currentUserRoleBadge");
const dateEl = document.getElementById("todayDate");
const outCountEl = document.getElementById("outCountText");
const searchInput = document.getElementById("search");
const chipsEl = document.getElementById("filterChips");
const listEl = document.getElementById("studentList");
const dateSelectEl = document.getElementById("dateSelect");
const pastDateNoticeEl = document.getElementById("pastDateNotice");
const requestPanelEl = document.getElementById("requestPanel");
const requestCountEl = document.getElementById("requestCount");
const requestListEl = document.getElementById("requestList");

// outings는 하루가 지나도 기록이 남도록 날짜별로 저장한다(outings 테이블의 date 열).
// "조회 날짜"를 오늘이 아닌 값으로 바꾸면 그 날짜의 기록을 보고 고칠 수 있다(지난 기록 수정).
function getDateKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

const TODAY_KEY = getDateKey();

// "명령퇴사"는 students.html에서 설정하는 시작~종료일이 있는 기간제 상태다. 그 기간 동안은
// "자리 없음" 판정에서 제외하고 조회 중인 날짜 기준으로 판단한다(지난 기록을 볼 때도 그 날짜 기준).
function isOnLeave(student, dateKey) {
  const leave = student && student.leaveOfAbsence;
  if (!leave || !leave.from || !leave.to) return false;
  return dateKey >= leave.from && dateKey <= leave.to;
}

const state = {
  studentsByGrade: { "1": {}, "2": {}, "3": {} },
  outings: {},
  rooms: {},
  searchTerm: "",
  activeFilter: "all",
  selectedDate: TODAY_KEY,
  pendingRequests: [], // 오늘 승인 대기 중인 학생 외출 신청(outing_requests)
};

let outingsLive = null;
let requestsLive = null;
let currentProfile = null;

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatToday() {
  const days = ["일", "월", "화", "수", "목", "금", "토"];
  const now = new Date();
  return `${now.getFullYear()}년 ${now.getMonth() + 1}월 ${now.getDate()}일 (${days[now.getDay()]})`;
}

function formatTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

// 외출 문자 결과 한 줄(notify-outing이 outings.notice에 기록). 표시할 게 없으면 text가 ""
// 학부모에게만 보낸다(학생 외출증은 학생 화면에 뜸).
const NOTICE_LABEL = { sent: "문자 학부모 ✓", failed: "문자 학부모 실패", "no-phone": "학부모 번호 없음" };
function describeNotice(notice) {
  if (!notice) return { text: "", failed: false, title: "" };
  if (notice.status === "sending") return { text: "문자 보내는 중", failed: false, title: "" };
  if (notice.status === "not-configured") return { text: "문자 설정 전", failed: false, title: "" };
  const parent = notice.parent || {};
  return {
    text: NOTICE_LABEL[parent.result] || "",
    failed: parent.result === "failed",
    title: parent.error ? `학부모: ${parent.error}` : "",
  };
}

function getAllStudents() {
  const list = [];
  for (const grade of GRADES) {
    const group = state.studentsByGrade[grade] || {};
    for (const [id, data] of Object.entries(group)) {
      list.push({ id, grade, ...data });
    }
  }
  return list;
}

function getRoomIdByStudentId() {
  const map = {};
  for (const [roomId, room] of Object.entries(state.rooms)) {
    const seatMap = (room && room.seatMap) || {};
    for (const studentId of Object.values(seatMap)) {
      if (studentId) map[studentId] = roomId;
    }
  }
  return map;
}

// 외출 신청 승인 범위: 관리자·기숙사부 전체, 학년부장 담당 학년, 담임 담당 반(서버 can_manage_student와 같은 규칙)
function canApprove(student) {
  const p = currentProfile;
  if (!p || !student) return false;
  if (p.role === "admin" || p.role === "dormStaff") return true;
  if (p.role === "gradeManager") return Boolean((p.managedGrades || {})[student.grade]);
  if (p.role === "teacher") return Boolean(((p.managedClasses || {})[student.grade] || {})[student.cls]);
  return false;
}

function findStudent(studentId) {
  for (const grade of GRADES) {
    const data = (state.studentsByGrade[grade] || {})[studentId];
    if (data) return { id: studentId, grade, ...data };
  }
  return null;
}

const STATUS_META = {
  in: { badge: "재실", badgeClass: "status-badge--in", avatarClass: "student-avatar--in" },
  out: { badge: "외출중", badgeClass: "status-badge--out", avatarClass: "student-avatar--out" },
  // 승인됐지만 신청한 외출 시각이 아직 안 됨(DB에는 out). 그 시각이 되면 외출중으로 바뀐다.
  scheduled: { badge: "외출 예정", badgeClass: "status-badge--scheduled", avatarClass: "student-avatar--in" },
  away: { badge: "자리 없음", badgeClass: "status-badge--away", avatarClass: "student-avatar--away" },
  leave: { badge: "명령퇴사", badgeClass: "status-badge--leave", avatarClass: "student-avatar--leave" },
};

// "자리 없음"은 자동 판단 없이 순회하는 교사가 직접 표시하는 수동 상태다(재실에서만 진입, 재실로만 복귀).
// 예전에 무단외출/자리비움 두 상태로 나눠뒀던 걸 하나로 합침 — 기존에 저장된 "unauthorized" 값도 같은 걸로 취급한다.
// "명령퇴사"(기간제 상태)는 무엇보다 우선한다 — students.html에서 설정하며 여기서는 표시만 한다.
function getOutingStatus(student) {
  if (isOnLeave(student, state.selectedDate)) return "leave";
  const outing = state.outings[student.id];
  const status = outing && outing.status;
  if (status === "away" || status === "unauthorized") return "away";
  if (status === "out" && isScheduledOuting(outing, state.selectedDate, TODAY_KEY)) return "scheduled";
  return status === "out" ? "out" : "in";
}

// 외출 예정 학생의 외출 시각이 되면 다시 그려서 "외출중"으로 바꾼다.
const updateStartTicker = createStartTimeTicker(() => render());

function renderChips() {
  const roomEntries = Object.entries(state.rooms);
  const chips = [
    `<button type="button" class="filter-chip${state.activeFilter === "all" ? " is-active" : ""}" data-filter="all">전체</button>`,
    ...roomEntries.map(([roomId, room]) => {
      const active = state.activeFilter === roomId;
      const label = (room && room.name) || "이름 없음";
      return `<button type="button" class="filter-chip${active ? " is-active" : ""}" data-filter="${escapeHtml(roomId)}">${escapeHtml(label)}</button>`;
    }),
  ];
  chipsEl.innerHTML = chips.join("");
}

function renderList(filtered) {
  if (filtered.length === 0) {
    listEl.innerHTML = `<div class="student-list__empty">표시할 학생이 없습니다.</div>`;
    return;
  }

  listEl.innerHTML = filtered
    .map((s) => {
      const status = getOutingStatus(s);
      const isOut = status === "out" || status === "scheduled";
      const meta = STATUS_META[status];
      const outing = state.outings[s.id];
      const reasonText = isOut && outing && outing.reason ? ` · ${outing.reason}` : "";
      const returnText = isOut && outing && outing.expectedReturn ? ` (~${outing.expectedReturn})` : "";
      let sinceText = "";
      if (status === "leave") {
        const leave = s.leaveOfAbsence || {};
        sinceText = `${leave.from} ~ ${leave.to}${leave.reason ? ` · ${leave.reason}` : ""}`;
      } else if (status !== "in") {
        const timeText = (isOut && outing && outing.startTime) || formatTime(outing && outing.since);
        sinceText = `${timeText} ${meta.badge}${reasonText}${returnText}`;
      }
      const notice = isOut && state.selectedDate === TODAY_KEY ? describeNotice(outing && outing.notice) : null;
      const initial = (s.name || "?").charAt(0);
      const hasPendingRequest =
        state.selectedDate === TODAY_KEY && state.pendingRequests.some((r) => r.student_id === s.id);

      let actionsHtml;
      if (status === "in") {
        actionsHtml = `<button type="button" class="toggle-btn toggle-btn--mark-out" data-toggle-id="${escapeHtml(s.id)}" data-grade="${escapeHtml(s.grade)}" data-current-status="in">외출 체크</button>`;
      } else if (status === "out") {
        actionsHtml = `<button type="button" class="toggle-btn toggle-btn--mark-in" data-toggle-id="${escapeHtml(s.id)}" data-grade="${escapeHtml(s.grade)}" data-current-status="out">복귀 체크</button>`;
      } else if (status === "scheduled") {
        actionsHtml = `<button type="button" class="toggle-btn toggle-btn--mark-in" data-toggle-id="${escapeHtml(s.id)}" data-grade="${escapeHtml(s.grade)}" data-current-status="out" data-confirm-cancel="${escapeHtml(s.name || "이 학생")}">외출 취소</button>`;
      } else if (status === "leave") {
        actionsHtml = `<div class="since-text ml-auto">학생 명단 관리에서 설정</div>`;
      } else {
        actionsHtml = `
          <div class="roster-actions">
            <button type="button" class="btn-secondary btn-small" data-restore-id="${escapeHtml(s.id)}">재실로 되돌리기</button>
          </div>
        `;
      }

      return `
        <div class="student-card">
          <div class="student-avatar ${meta.avatarClass}">${escapeHtml(initial)}</div>
          <div class="student-info">
            <div class="student-name">${escapeHtml(s.name || "이름 없음")}${hasPendingRequest ? ` <span class="pending-chip">외출 신청 대기</span>` : ""}</div>
            <div class="student-meta">학번 ${escapeHtml(s.sid || "-")} · ${escapeHtml(s.cls || "-")}</div>
            ${
              notice && notice.text
                ? `<div class="notice-text${notice.failed ? " notice-text--failed" : ""}" title="${escapeHtml(notice.title)}">${escapeHtml(notice.text)}</div>`
                : ""
            }
          </div>
          <div class="student-status">
            <div class="status-badge ${meta.badgeClass}">${meta.badge}</div>
            <div class="since-text">${escapeHtml(sinceText)}</div>
          </div>
          ${actionsHtml}
        </div>
      `;
    })
    .join("");
}

function render() {
  dateEl.textContent = formatToday();

  const isToday = state.selectedDate === TODAY_KEY;
  pastDateNoticeEl.hidden = isToday;

  const allStudents = getAllStudents();
  const roomIdByStudent = getRoomIdByStudentId();

  const outCount = allStudents.filter((s) => getOutingStatus(s) === "out").length;
  const scheduledCount = isToday ? allStudents.filter((s) => getOutingStatus(s) === "scheduled").length : 0;
  outCountEl.textContent = isToday
    ? `외출중 ${outCount}명${scheduledCount ? ` · 외출 예정 ${scheduledCount}명` : ""}`
    : `그 날 외출 기록 ${outCount}명`;
  updateStartTicker(isToday ? Object.values(state.outings) : []);

  renderChips();

  let filtered = allStudents;
  if (state.activeFilter !== "all") {
    filtered = filtered.filter((s) => roomIdByStudent[s.id] === state.activeFilter);
  }
  const term = state.searchTerm.trim();
  if (term) {
    filtered = filtered.filter((s) => (s.name || "").includes(term));
  }
  filtered.sort((a, b) => (a.sid || "").localeCompare(b.sid || ""));

  renderList(filtered);
  renderRequestPanel();
}

// 내가 승인할 수 있는 오늘의 신청만 보여준다(범위 밖 신청은 서버도 거부함).
function renderRequestPanel() {
  const items = state.pendingRequests
    .map((request) => ({ request, student: findStudent(request.student_id) }))
    .filter(({ student }) => canApprove(student))
    .sort((a, b) => String(a.request.created_at).localeCompare(String(b.request.created_at)));

  requestPanelEl.hidden = items.length === 0;
  requestCountEl.textContent = `${items.length}건`;
  requestListEl.innerHTML = items
    .map(({ request, student }) => {
      const timeText =
        request.start_time || request.expected_return
          ? ` (${request.start_time || ""}~${request.expected_return || ""})`
          : "";
      return `
        <div class="request-row">
          <div class="request-row__who">
            <div class="student-name">${escapeHtml(student.name || "이름 없음")}</div>
            <div class="student-meta">학번 ${escapeHtml(student.sid || "-")} · ${escapeHtml(student.cls || "-")}</div>
          </div>
          <div class="request-row__what">
            ${escapeHtml(request.reason)}${escapeHtml(timeText)}
            <div class="since-text">${escapeHtml(formatTime(request.created_at))} 신청</div>
          </div>
          <div class="roster-actions">
            <button type="button" class="btn-add btn-small" data-approve-request="${escapeHtml(request.id)}">승인</button>
            <button type="button" class="btn-danger btn-small" data-reject-request="${escapeHtml(request.id)}">반려</button>
          </div>
        </div>
      `;
    })
    .join("");
}

async function approveRequest(requestId, btn) {
  const request = state.pendingRequests.find((r) => r.id === requestId);
  if (!request) return;
  btn.disabled = true;
  const { error } = await supabase.rpc("approve_outing_request", { p_request_id: requestId });
  if (error) {
    alert(`승인하지 못했습니다: ${describeError(error)}`);
    btn.disabled = false;
    if (requestsLive) await requestsLive.refresh();
    return;
  }
  await Promise.all([
    requestsLive ? requestsLive.refresh() : null,
    outingsLive && state.selectedDate === TODAY_KEY ? outingsLive.refresh() : null,
  ]);
  // 승인 = 외출 시작이므로 "외출 체크"와 같이 학부모에게 문자를 보낸다.
  sendOutingNotice(request.student_id);
}

async function rejectRequest(requestId, btn) {
  const reason = window.prompt("반려 사유를 입력해 주세요 (학생 화면에 보입니다, 비워도 됩니다)", "");
  if (reason === null) return;
  btn.disabled = true;
  const { error } = await supabase.rpc("reject_outing_request", { p_request_id: requestId, p_reason: reason.trim() || null });
  if (error) {
    alert(`반려하지 못했습니다: ${describeError(error)}`);
    btn.disabled = false;
  }
  if (requestsLive) await requestsLive.refresh();
}

requestListEl.addEventListener("click", (event) => {
  const approveBtn = event.target.closest("[data-approve-request]");
  if (approveBtn) {
    approveRequest(approveBtn.dataset.approveRequest, approveBtn);
    return;
  }
  const rejectBtn = event.target.closest("[data-reject-request]");
  if (rejectBtn) rejectRequest(rejectBtn.dataset.rejectRequest, rejectBtn);
});

// 오늘 외출이 시작되면(외출 체크·신청 승인) 학부모에게 외출 안내 문자를 보낸다(학생 외출증은 학생 화면에 뜸).
// 실제 발송과 중복 방지는 서버(notify-outing)가 하고, 결과는 outings.notice로 카드에 실시간 표시된다.
async function sendOutingNotice(studentId) {
  try {
    await callFunction("notify-outing", { date: TODAY_KEY, studentId });
  } catch (err) {
    console.warn("외출 문자 요청 실패:", err);
    showPageError(`외출 문자를 보내지 못했습니다(${err.message}).`);
  }
  if (outingsLive && state.selectedDate === TODAY_KEY) await outingsLive.refresh();
}

// 외출 상태 저장. 시각(since)과 담당 교사는 서버 트리거가 채운다.
async function saveOuting(studentId, status, reason, expectedReturn) {
  const row = { date: state.selectedDate, student_id: studentId, status };
  if (status === "out") {
    row.reason = reason || null;
    row.expected_return = expectedReturn || null;
  }
  const { error } = await supabase.from("outings").upsert(row, { onConflict: "date,student_id" });
  if (error) {
    alert(`저장하지 못했습니다: ${describeError(error)}`);
    return false;
  }
  if (outingsLive) await outingsLive.refresh();
  return true;
}

async function toggleOuting(studentId, grade, currentStatus, reason, expectedReturn) {
  const nextStatus = currentStatus === "out" ? "in" : "out";
  const dateWhenClicked = state.selectedDate;
  const saved = await saveOuting(studentId, nextStatus, reason, expectedReturn);

  // 지난 날짜 기록을 고치는 중이면(오늘이 아니면) 문자를 보내지 않는다 — 실시간 외출이 아니라 사후 정정이기 때문.
  if (saved && nextStatus === "out" && dateWhenClicked === TODAY_KEY) sendOutingNotice(studentId);
}

function restoreToIn(studentId) {
  return saveOuting(studentId, "in");
}

chipsEl.addEventListener("click", (event) => {
  const btn = event.target.closest("[data-filter]");
  if (!btn) return;
  state.activeFilter = btn.dataset.filter;
  render();
});

listEl.addEventListener("click", (event) => {
  const restoreBtn = event.target.closest("[data-restore-id]");
  if (restoreBtn) {
    // 저장이 끝나 목록이 다시 그려질 때까지 같은 버튼을 또 누르지 못하게 한다.
    restoreBtn.disabled = true;
    restoreToIn(restoreBtn.dataset.restoreId).finally(() => {
      restoreBtn.disabled = false;
    });
    return;
  }

  const btn = event.target.closest("[data-toggle-id]");
  if (!btn) return;
  const currentStatus = btn.dataset.currentStatus;
  // 승인된 외출(외출 예정)을 취소할 때는 한 번 확인한다(잘못 누르면 승인이 없어지므로).
  if (btn.dataset.confirmCancel && !window.confirm(`${btn.dataset.confirmCancel} 학생의 외출을 취소할까요?`)) return;
  let reason = "";
  let expectedReturn = "";
  if (currentStatus === "in") {
    reason = (window.prompt("외출 사유를 입력해 주세요 (취소해도 외출 체크는 진행됩니다)", "") || "").trim();
    expectedReturn = (window.prompt("예상 복귀 시각을 입력해 주세요 (예: 17:00, 취소하면 미정으로 표시됩니다)", "") || "").trim();
  }
  btn.disabled = true;
  toggleOuting(btn.dataset.toggleId, btn.dataset.grade, currentStatus, reason, expectedReturn).finally(() => {
    btn.disabled = false;
  });
});

searchInput.addEventListener("input", (event) => {
  state.searchTerm = event.target.value;
  render();
});

function reportLoadError(error) {
  showPageError(`데이터를 불러오지 못했습니다(${describeError(error)}). 잠시 후 자동으로 다시 시도합니다.`);
}

function subscribeOutingsForSelectedDate() {
  if (outingsLive) outingsLive.stop();
  const date = state.selectedDate;
  state.outings = {};
  outingsLive = liveTable({
    table: "outings",
    order: ["student_id"],
    eq: { date },
    onRows: (rows) => {
      if (date !== state.selectedDate) return;
      state.outings = outingsByStudent(rows);
      render();
    },
    onError: reportLoadError,
  });
}

dateSelectEl.addEventListener("change", () => {
  state.selectedDate = dateSelectEl.value || TODAY_KEY;
  subscribeOutingsForSelectedDate();
  render();
});

async function init() {
  const session = await requireStaff();
  if (!session) return;
  const { loginId, profile } = session;
  currentTeacherId = loginId;
  currentProfile = profile;

  dateSelectEl.max = TODAY_KEY;
  dateSelectEl.value = state.selectedDate;

  const hasManagedClasses = Object.values(profile.managedClasses || {}).some(
    (classes) => Object.keys(classes || {}).length > 0
  );
  navLoadingHint.hidden = true;
  // 기숙사부는 계정 관리만 빼고 admin과 동일한 권한을 가진다.
  manageLink.hidden =
    profile.role !== "admin" && profile.role !== "gradeManager" && profile.role !== "dormStaff" && !hasManagedClasses;
  accountsLink.hidden = profile.role !== "admin";
  // 자습 감독 계정은 외출 체크 화면만 쓸 수 있게 다른 화면 링크를 모두 숨긴다.
  const isStudyHallSupervisor = profile.role === "studyHallSupervisor";
  displayLink.hidden = isStudyHallSupervisor;
  seatLink.hidden = isStudyHallSupervisor;
  currentTeacherName = profile.name || "";

  const role = profile.role || "teacher";
  currentUserNameEl.textContent = currentTeacherName || currentTeacherId;
  currentUserRoleBadgeEl.textContent = role;
  currentUserRoleBadgeEl.className = `role-badge role-badge--${role}`;

  liveTable({
    table: "students",
    order: ["id"],
    onRows: (rows) => {
      state.studentsByGrade = groupStudentsByGrade(rows);
      render();
    },
    onError: reportLoadError,
  });

  subscribeOutingsForSelectedDate();

  liveTable({
    table: "rooms",
    order: ["created_at", "id"],
    onRows: (rows) => {
      state.rooms = roomsById(rows);
      render();
    },
    onError: reportLoadError,
  });

  requestsLive = liveTable({
    table: "outing_requests",
    eq: { date: TODAY_KEY, status: "pending" },
    order: ["created_at", "id"],
    onRows: (rows) => {
      state.pendingRequests = rows;
      render();
    },
    onError: reportLoadError,
  });
}

logoutBtn.addEventListener("click", () => signOutTo());

render();
init();

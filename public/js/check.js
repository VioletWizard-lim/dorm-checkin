import { auth, db } from "./firebase-init.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  ref,
  onValue,
  set,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";
import {
  EMAILJS_PUBLIC_KEY,
  EMAILJS_SERVICE_ID,
  EMAILJS_OUTING_TEMPLATE_ID,
} from "./emailjs-config.js";
import { FAKE_EMAIL_DOMAIN } from "./firebase-config.js";

if (window.emailjs) {
  window.emailjs.init({ publicKey: EMAILJS_PUBLIC_KEY });
}

const GRADES = ["1", "2", "3"];
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

// outings는 하루가 지나도 기록이 남도록 outings/{날짜}/{학번}으로 저장한다.
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
};

let unsubscribeOutings = null;

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

function formatDate(ts) {
  const d = new Date(ts);
  return `${d.getMonth() + 1}월 ${d.getDate()}일`;
}

// 학번 마지막 2자리 = 번호 (예: "10305" -> 5번)
function deriveSeatNoFromSid(sid) {
  const match = /^\d{3}(\d{2})$/.exec((sid || "").trim());
  return match ? String(Number(match[1])) : "";
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

const STATUS_META = {
  in: { badge: "재실", badgeClass: "status-badge--in", avatarClass: "student-avatar--in" },
  out: { badge: "외출중", badgeClass: "status-badge--out", avatarClass: "student-avatar--out" },
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
  return status === "out" ? "out" : "in";
}

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
      const isOut = status === "out";
      const meta = STATUS_META[status];
      const outing = state.outings[s.id];
      const reasonText = isOut && outing && outing.reason ? ` · ${outing.reason}` : "";
      const returnText = isOut && outing && outing.expectedReturn ? ` (~${outing.expectedReturn})` : "";
      let sinceText = "";
      if (status === "leave") {
        const leave = s.leaveOfAbsence || {};
        sinceText = `${leave.from} ~ ${leave.to}${leave.reason ? ` · ${leave.reason}` : ""}`;
      } else if (status !== "in") {
        sinceText = `${formatTime(outing && outing.since)} ${meta.badge}${reasonText}${returnText}`;
      }
      const initial = (s.name || "?").charAt(0);

      let actionsHtml;
      if (status === "in") {
        actionsHtml = `
          <div class="status-actions">
            <button type="button" class="toggle-btn toggle-btn--mark-out" data-toggle-id="${escapeHtml(s.id)}" data-grade="${escapeHtml(s.grade)}" data-current-status="in">외출 체크</button>
            <button type="button" class="btn-secondary btn-small" data-mark-away-id="${escapeHtml(s.id)}">자리 없음으로 표시</button>
          </div>
        `;
      } else if (status === "out") {
        actionsHtml = `<button type="button" class="toggle-btn toggle-btn--mark-in" data-toggle-id="${escapeHtml(s.id)}" data-grade="${escapeHtml(s.grade)}" data-current-status="out">복귀 체크</button>`;
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
            <div class="student-name">${escapeHtml(s.name || "이름 없음")}</div>
            <div class="student-meta">학번 ${escapeHtml(s.sid || "-")} · ${escapeHtml(s.cls || "-")}</div>
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
  outCountEl.textContent = isToday ? `외출중 ${outCount}명` : `그 날 외출 기록 ${outCount}명`;

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
}

function sendOutingEmail(student, reason, expectedReturn) {
  if (!student.email || !window.emailjs) return;
  const now = Date.now();
  window.emailjs
    .send(EMAILJS_SERVICE_ID, EMAILJS_OUTING_TEMPLATE_ID, {
      to_email: student.email,
      student_name: student.name || "",
      sid: student.sid || "",
      cls: student.cls || "",
      seat_no: deriveSeatNoFromSid(student.sid),
      reason: reason || "사유 미기재",
      out_date: formatDate(now),
      out_time: formatTime(now),
      return_time: expectedReturn || "미정",
      teacher_id: currentTeacherName || currentTeacherId || "관리자",
    })
    .catch((err) => console.error("외출증 이메일 발송 실패:", err));
}

function toggleOuting(studentId, grade, currentStatus, reason, expectedReturn) {
  const nextStatus = currentStatus === "out" ? "in" : "out";
  const outingData = { status: nextStatus, since: serverTimestamp() };
  if (nextStatus === "out") {
    outingData.reason = reason || "";
    outingData.expectedReturn = expectedReturn || "";
  }
  set(ref(db, `outings/${state.selectedDate}/${studentId}`), outingData);

  // 지난 날짜 기록을 고치는 중이면(오늘이 아니면) 외출증 이메일을 보내지 않는다 — 실시간 외출이 아니라 사후 정정이기 때문.
  if (nextStatus === "out" && state.selectedDate === TODAY_KEY) {
    const student = (state.studentsByGrade[grade] || {})[studentId];
    if (student) sendOutingEmail(student, reason, expectedReturn);
  }
}

function markStatus(studentId, status) {
  set(ref(db, `outings/${state.selectedDate}/${studentId}`), { status, since: serverTimestamp() });
}

function restoreToIn(studentId) {
  set(ref(db, `outings/${state.selectedDate}/${studentId}`), { status: "in", since: serverTimestamp() });
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
    restoreToIn(restoreBtn.dataset.restoreId);
    return;
  }

  const markAwayBtn = event.target.closest("[data-mark-away-id]");
  if (markAwayBtn) {
    if (window.confirm("이 학생을 '자리 없음'으로 표시할까요?")) {
      markStatus(markAwayBtn.dataset.markAwayId, "away");
    }
    return;
  }

  const btn = event.target.closest("[data-toggle-id]");
  if (!btn) return;
  const currentStatus = btn.dataset.currentStatus;
  let reason = "";
  let expectedReturn = "";
  if (currentStatus === "in") {
    reason = (window.prompt("외출 사유를 입력해 주세요 (취소해도 외출 체크는 진행됩니다)", "") || "").trim();
    expectedReturn = (window.prompt("예상 복귀 시각을 입력해 주세요 (예: 17:00, 취소하면 미정으로 표시됩니다)", "") || "").trim();
  }
  toggleOuting(btn.dataset.toggleId, btn.dataset.grade, currentStatus, reason, expectedReturn);
});

searchInput.addEventListener("input", (event) => {
  state.searchTerm = event.target.value;
  render();
});

function subscribeOutingsForSelectedDate() {
  if (unsubscribeOutings) unsubscribeOutings();
  unsubscribeOutings = onValue(ref(db, `outings/${state.selectedDate}`), (snapshot) => {
    state.outings = snapshot.val() || {};
    render();
  });
}

dateSelectEl.addEventListener("change", () => {
  state.selectedDate = dateSelectEl.value || TODAY_KEY;
  subscribeOutingsForSelectedDate();
  render();
});

onAuthStateChanged(auth, (user) => {
  if (!user) {
    window.location.replace("./login.html");
    return;
  }

  currentTeacherId = (user.email || "").replace(`@${FAKE_EMAIL_DOMAIN}`, "");

  dateSelectEl.max = TODAY_KEY;
  dateSelectEl.value = state.selectedDate;

  for (const grade of GRADES) {
    onValue(ref(db, `students/${grade}`), (snapshot) => {
      state.studentsByGrade[grade] = snapshot.val() || {};
      render();
    });
  }

  subscribeOutingsForSelectedDate();

  onValue(ref(db, "rooms"), (snapshot) => {
    state.rooms = snapshot.val() || {};
    render();
  });

  onValue(
    ref(db, `users/${user.uid}`),
    (snapshot) => {
      const profile = snapshot.val() || {};
      if (profile.disabled) {
        signOut(auth).then(() => window.location.replace("./login.html?disabled=1"));
        return;
      }
      const hasManagedClasses = Object.values(profile.managedClasses || {}).some(
        (classes) => Object.keys(classes || {}).length > 0
      );
      navLoadingHint.hidden = true;
      manageLink.hidden = profile.role !== "admin" && profile.role !== "gradeManager" && !hasManagedClasses;
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
    },
    { onlyOnce: true }
  );
});

logoutBtn.addEventListener("click", () => {
  signOut(auth).then(() => window.location.replace("./login.html"));
});

render();

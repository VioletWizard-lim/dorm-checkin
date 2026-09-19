import { auth, db } from "./firebase-init.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
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

const manageLink = document.getElementById("manageLink");
const dateEl = document.getElementById("todayDate");
const outCountEl = document.getElementById("outCountText");
const searchInput = document.getElementById("search");
const chipsEl = document.getElementById("filterChips");
const listEl = document.getElementById("studentList");

const state = {
  studentsByGrade: { "1": {}, "2": {}, "3": {} },
  outings: {},
  rooms: {},
  searchTerm: "",
  activeFilter: "all",
};

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

function getOutingStatus(studentId) {
  const outing = state.outings[studentId];
  return outing && outing.status === "out" ? "out" : "in";
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
      const status = getOutingStatus(s.id);
      const isOut = status === "out";
      const outing = state.outings[s.id];
      const reasonText = isOut && outing && outing.reason ? ` · ${outing.reason}` : "";
      const sinceText = isOut ? `${formatTime(outing && outing.since)} 외출${reasonText}` : "";
      const initial = (s.name || "?").charAt(0);
      return `
        <div class="student-card">
          <div class="student-avatar ${isOut ? "student-avatar--out" : "student-avatar--in"}">${escapeHtml(initial)}</div>
          <div class="student-info">
            <div class="student-name">${escapeHtml(s.name || "이름 없음")}</div>
            <div class="student-meta">학번 ${escapeHtml(s.sid || "-")} · ${escapeHtml(s.cls || "-")}</div>
          </div>
          <div class="student-status">
            <div class="status-badge ${isOut ? "status-badge--out" : "status-badge--in"}">${isOut ? "외출중" : "재실"}</div>
            <div class="since-text">${escapeHtml(sinceText)}</div>
          </div>
          <button type="button" class="toggle-btn ${isOut ? "toggle-btn--mark-in" : "toggle-btn--mark-out"}" data-toggle-id="${escapeHtml(s.id)}" data-grade="${escapeHtml(s.grade)}" data-current-status="${status}">${isOut ? "복귀 체크" : "외출 체크"}</button>
        </div>
      `;
    })
    .join("");
}

function render() {
  dateEl.textContent = formatToday();

  const allStudents = getAllStudents();
  const roomIdByStudent = getRoomIdByStudentId();

  const outCount = allStudents.filter((s) => getOutingStatus(s.id) === "out").length;
  outCountEl.textContent = `외출중 ${outCount}명`;

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

function sendOutingEmail(student, reason) {
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
      teacher_id: currentTeacherId || "관리자",
    })
    .catch((err) => console.error("외출증 이메일 발송 실패:", err));
}

function toggleOuting(studentId, grade, currentStatus, reason) {
  const nextStatus = currentStatus === "out" ? "in" : "out";
  const outingData = { status: nextStatus, since: serverTimestamp() };
  if (nextStatus === "out") {
    outingData.reason = reason || "";
  }
  set(ref(db, `outings/${studentId}`), outingData);

  if (nextStatus === "out") {
    const student = (state.studentsByGrade[grade] || {})[studentId];
    if (student) sendOutingEmail(student, reason);
  }
}

chipsEl.addEventListener("click", (event) => {
  const btn = event.target.closest("[data-filter]");
  if (!btn) return;
  state.activeFilter = btn.dataset.filter;
  render();
});

listEl.addEventListener("click", (event) => {
  const btn = event.target.closest("[data-toggle-id]");
  if (!btn) return;
  const currentStatus = btn.dataset.currentStatus;
  let reason = "";
  if (currentStatus === "in") {
    reason = (window.prompt("외출 사유를 입력해 주세요 (취소해도 외출 체크는 진행됩니다)", "") || "").trim();
  }
  toggleOuting(btn.dataset.toggleId, btn.dataset.grade, currentStatus, reason);
});

searchInput.addEventListener("input", (event) => {
  state.searchTerm = event.target.value;
  render();
});

onAuthStateChanged(auth, (user) => {
  if (!user) {
    window.location.replace("./login.html");
    return;
  }

  currentTeacherId = (user.email || "").replace(`@${FAKE_EMAIL_DOMAIN}`, "");

  for (const grade of GRADES) {
    onValue(ref(db, `students/${grade}`), (snapshot) => {
      state.studentsByGrade[grade] = snapshot.val() || {};
      render();
    });
  }

  onValue(ref(db, "outings"), (snapshot) => {
    state.outings = snapshot.val() || {};
    render();
  });

  onValue(ref(db, "rooms"), (snapshot) => {
    state.rooms = snapshot.val() || {};
    render();
  });

  onValue(
    ref(db, `users/${user.uid}`),
    (snapshot) => {
      const role = (snapshot.val() || {}).role;
      manageLink.hidden = role !== "admin" && role !== "gradeManager";
    },
    { onlyOnce: true }
  );
});

render();

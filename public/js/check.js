import { auth, db } from "./firebase-init.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  ref,
  onValue,
  set,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";

const GRADES = ["1", "2", "3"];

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
      const sinceText = isOut ? `${formatTime(outing && outing.since)} 외출` : "";
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
          <button type="button" class="toggle-btn ${isOut ? "toggle-btn--mark-in" : "toggle-btn--mark-out"}" data-toggle-id="${escapeHtml(s.id)}" data-current-status="${status}">${isOut ? "복귀 체크" : "외출 체크"}</button>
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

function toggleOuting(studentId, currentStatus) {
  const nextStatus = currentStatus === "out" ? "in" : "out";
  set(ref(db, `outings/${studentId}`), {
    status: nextStatus,
    since: serverTimestamp(),
  });
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
  toggleOuting(btn.dataset.toggleId, btn.dataset.currentStatus);
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
});

render();

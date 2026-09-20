import { auth, db } from "./firebase-init.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import { ref, onValue } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";
import { FAKE_EMAIL_DOMAIN } from "./firebase-config.js";

const GRADES = ["1", "2", "3"];

const logoutBtn = document.getElementById("logoutBtn");
const currentUserNameEl = document.getElementById("currentUserName");
const currentUserRoleBadgeEl = document.getElementById("currentUserRoleBadge");
const dateEl = document.getElementById("todayDate");
const gradeChipsEl = document.getElementById("gradeChips");
const chipsEl = document.getElementById("filterChips");
const outListEl = document.getElementById("outPanelList");
const outCountEl = document.getElementById("outPanelCount");
const afterschoolListEl = document.getElementById("afterschoolPanelList");
const afterschoolCountEl = document.getElementById("afterschoolPanelCount");

const state = {
  studentsByGrade: { "1": {}, "2": {}, "3": {} },
  outings: {},
  rooms: {},
  activeGradeFilter: "all",
  activeRoomFilter: "all",
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

// 월=0 ... 금=4 로 매핑, 토·일이면 null (afterschoolDays는 월~금 5칸)
function todayWeekdayIndex() {
  const idx = new Date().getDay() - 1;
  return idx >= 0 && idx <= 4 ? idx : null;
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

function renderGradeChips() {
  const chips = [
    `<button type="button" class="filter-chip${state.activeGradeFilter === "all" ? " is-active" : ""}" data-grade-filter="all">전체</button>`,
    ...GRADES.map((grade) => {
      const active = state.activeGradeFilter === grade;
      return `<button type="button" class="filter-chip${active ? " is-active" : ""}" data-grade-filter="${grade}">${grade}학년</button>`;
    }),
  ];
  gradeChipsEl.innerHTML = chips.join("");
}

function renderRoomChips() {
  const roomEntries = Object.entries(state.rooms);
  const chips = [
    `<button type="button" class="filter-chip${state.activeRoomFilter === "all" ? " is-active" : ""}" data-room-filter="all">전체</button>`,
    ...roomEntries.map(([roomId, room]) => {
      const active = state.activeRoomFilter === roomId;
      const label = (room && room.name) || "이름 없음";
      return `<button type="button" class="filter-chip${active ? " is-active" : ""}" data-room-filter="${escapeHtml(roomId)}">${escapeHtml(label)}</button>`;
    }),
  ];
  chipsEl.innerHTML = chips.join("");
}

function renderOutPanel(students) {
  const outStudents = students
    .filter((s) => state.outings[s.id] && state.outings[s.id].status === "out")
    .sort((a, b) => (state.outings[a.id]?.since || 0) - (state.outings[b.id]?.since || 0));

  outCountEl.textContent = `${outStudents.length}명`;

  if (outStudents.length === 0) {
    outListEl.innerHTML = `<div class="display-panel__empty">외출중인 학생이 없습니다.</div>`;
    return;
  }

  outListEl.innerHTML = outStudents
    .map((s) => {
      const outing = state.outings[s.id];
      return `
        <div class="display-card">
          <div class="display-card__avatar">${escapeHtml((s.name || "?").charAt(0))}</div>
          <div class="display-card__info">
            <div class="display-card__name">${escapeHtml(s.name || "이름 없음")}</div>
            <div class="display-card__meta">학번 ${escapeHtml(s.sid || "-")} · ${escapeHtml(s.cls || "-")}</div>
          </div>
          <div class="display-card__extra">${escapeHtml(formatTime(outing && outing.since))} 외출</div>
        </div>
      `;
    })
    .join("");
}

function renderAfterschoolPanel(students) {
  const todayIdx = todayWeekdayIndex();
  const afterschoolStudents = todayIdx === null
    ? []
    : students
        .filter((s) => Array.isArray(s.afterschoolDays) && s.afterschoolDays[todayIdx])
        .sort((a, b) => (a.sid || "").localeCompare(b.sid || ""));

  afterschoolCountEl.textContent = `${afterschoolStudents.length}명`;

  if (afterschoolStudents.length === 0) {
    const emptyText = todayIdx === null ? "오늘은 방과후가 없습니다." : "오늘 방과후 학생이 없습니다.";
    afterschoolListEl.innerHTML = `<div class="display-panel__empty">${emptyText}</div>`;
    return;
  }

  afterschoolListEl.innerHTML = afterschoolStudents
    .map(
      (s) => `
        <div class="display-card">
          <div class="display-card__avatar">${escapeHtml((s.name || "?").charAt(0))}</div>
          <div class="display-card__info">
            <div class="display-card__name">${escapeHtml(s.name || "이름 없음")}</div>
            <div class="display-card__meta">학번 ${escapeHtml(s.sid || "-")} · ${escapeHtml(s.cls || "-")}</div>
          </div>
          <div class="display-card__extra">방과후</div>
        </div>
      `
    )
    .join("");
}

function render() {
  dateEl.textContent = formatToday();
  renderGradeChips();
  renderRoomChips();

  const allStudents = getAllStudents();
  const roomIdByStudent = getRoomIdByStudentId();

  let filtered = allStudents;
  if (state.activeGradeFilter !== "all") {
    filtered = filtered.filter((s) => s.grade === state.activeGradeFilter);
  }
  if (state.activeRoomFilter !== "all") {
    filtered = filtered.filter((s) => roomIdByStudent[s.id] === state.activeRoomFilter);
  }

  renderOutPanel(filtered);
  renderAfterschoolPanel(filtered);
}

gradeChipsEl.addEventListener("click", (event) => {
  const btn = event.target.closest("[data-grade-filter]");
  if (!btn) return;
  state.activeGradeFilter = btn.dataset.gradeFilter;
  render();
});

chipsEl.addEventListener("click", (event) => {
  const btn = event.target.closest("[data-room-filter]");
  if (!btn) return;
  state.activeRoomFilter = btn.dataset.roomFilter;
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

  const loginId = (user.email || "").replace(`@${FAKE_EMAIL_DOMAIN}`, "");
  onValue(
    ref(db, `users/${user.uid}`),
    (snapshot) => {
      const profile = snapshot.val() || {};
      if (profile.disabled) {
        signOut(auth).then(() => window.location.replace("./login.html?disabled=1"));
        return;
      }
      const role = profile.role || "teacher";
      currentUserNameEl.textContent = profile.name || loginId;
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

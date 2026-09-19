import { auth, db } from "./firebase-init.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  ref,
  onValue,
  set,
  update,
  remove,
  push,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";
import { FAKE_EMAIL_DOMAIN } from "./firebase-config.js";

const GRADES = ["1", "2", "3"];
const MIN_SIZE = 1;

const dateEl = document.getElementById("todayDate");
const roomTabsEl = document.getElementById("roomTabs");
const addRoomBtn = document.getElementById("addRoomBtn");
const editModeToggle = document.getElementById("editModeToggle");
const roomSettingsPanel = document.getElementById("roomSettingsPanel");
const roomNameInput = document.getElementById("roomNameInput");
const roomGradeToggleRow = document.getElementById("roomGradeToggleRow");
const rowsValue = document.getElementById("rowsValue");
const colsValue = document.getElementById("colsValue");
const rowsMinusBtn = document.getElementById("rowsMinusBtn");
const rowsPlusBtn = document.getElementById("rowsPlusBtn");
const colsMinusBtn = document.getElementById("colsMinusBtn");
const colsPlusBtn = document.getElementById("colsPlusBtn");
const deleteRoomBtn = document.getElementById("deleteRoomBtn");
const seatGridEl = document.getElementById("seatGrid");
const logoutBtn = document.getElementById("logoutBtn");
const currentUserNameEl = document.getElementById("currentUserName");
const currentUserRoleBadgeEl = document.getElementById("currentUserRoleBadge");

const state = {
  studentsByGrade: { "1": {}, "2": {}, "3": {} },
  outings: {},
  rooms: {},
  activeRoomId: null,
  editMode: false,
  role: "teacher",
  managedRoomIds: [],
  editingCellKey: null,
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

// 월=0 ... 금=4 로 매핑, 토·일이면 null (afterschoolDays는 월~금 5칸)
function todayWeekdayIndex() {
  const idx = new Date().getDay() - 1;
  return idx >= 0 && idx <= 4 ? idx : null;
}

function getStudentsById() {
  const map = {};
  for (const grade of GRADES) {
    const group = state.studentsByGrade[grade] || {};
    for (const [id, data] of Object.entries(group)) {
      map[id] = { id, grade, ...data };
    }
  }
  return map;
}

function getSeatedRoomNameByStudentId() {
  const map = {};
  for (const room of Object.values(state.rooms)) {
    const seatMap = (room && room.seatMap) || {};
    for (const studentId of Object.values(seatMap)) {
      if (studentId) map[studentId] = room.name || "이름 없음";
    }
  }
  return map;
}

function getStudentStatus(studentId, studentsById) {
  const outing = state.outings[studentId];
  if (outing && outing.status === "out") return "out";
  const student = studentsById[studentId];
  const todayIdx = todayWeekdayIndex();
  if (student && todayIdx !== null && Array.isArray(student.afterschoolDays) && student.afterschoolDays[todayIdx]) {
    return "afterschool";
  }
  return "in";
}

function canEditRoom(roomId) {
  if (!state.editMode || !roomId) return false;
  if (state.role === "admin") return true;
  if (state.role === "gradeManager") return state.managedRoomIds.includes(roomId);
  return false;
}

function canManageRoomsGlobally() {
  return state.editMode && state.role === "admin";
}

function ensureActiveRoom() {
  const ids = Object.keys(state.rooms);
  if (ids.length === 0) {
    state.activeRoomId = null;
    return;
  }
  if (!state.activeRoomId || !state.rooms[state.activeRoomId]) {
    state.activeRoomId = ids[0];
  }
}

function renderRoomTabs() {
  const entries = Object.entries(state.rooms);
  if (entries.length === 0) {
    roomTabsEl.innerHTML = `<span class="loading-hint">등록된 실이 없습니다.</span>`;
    return;
  }
  roomTabsEl.innerHTML = entries
    .map(([roomId, room]) => {
      const active = state.activeRoomId === roomId;
      const label = (room && room.name) || "이름 없음";
      return `<button type="button" class="filter-chip${active ? " is-active" : ""}" data-room-id="${escapeHtml(roomId)}">${escapeHtml(label)}</button>`;
    })
    .join("");
}

function renderEditToggle() {
  const showToggle = state.role === "admin" || state.role === "gradeManager";
  editModeToggle.hidden = !showToggle;
  editModeToggle.textContent = state.editMode ? "보기 모드로 전환" : "편집 모드";
  addRoomBtn.hidden = !canManageRoomsGlobally();
}

function renderRoomSettingsPanel(room) {
  const show = canManageRoomsGlobally() && room;
  roomSettingsPanel.hidden = !show;
  if (!show) return;

  if (document.activeElement !== roomNameInput) {
    roomNameInput.value = room.name || "";
  }

  const grades = room.grades || [];
  roomGradeToggleRow.innerHTML = GRADES.map((g) => {
    const active = grades.includes(g);
    return `<button type="button" class="grade-toggle${active ? " is-active" : ""}" data-grade="${g}">${g}학년</button>`;
  }).join("");

  const rows = Number(room.rows) || 1;
  const cols = Number(room.cols) || 1;
  rowsValue.textContent = String(rows);
  colsValue.textContent = String(cols);
  rowsMinusBtn.disabled = rows <= MIN_SIZE;
  colsMinusBtn.disabled = cols <= MIN_SIZE;

  const roomCount = Object.keys(state.rooms).length;
  deleteRoomBtn.disabled = roomCount <= 1;
}

function renderGrid(room) {
  const editable = canEditRoom(state.activeRoomId);

  if (!room) {
    seatGridEl.style.gridTemplateColumns = "";
    seatGridEl.innerHTML = `<div class="seat-board__empty">${
      canManageRoomsGlobally() ? "\"+ 실 추가\"로 첫 실을 만들어 주세요." : "등록된 실이 없습니다."
    }</div>`;
    return;
  }

  const rows = Number(room.rows) || 1;
  const cols = Number(room.cols) || 1;
  const seatMap = room.seatMap || {};
  const studentsById = getStudentsById();
  const seatedRoomNameByStudentId = getSeatedRoomNameByStudentId();

  seatGridEl.style.gridTemplateColumns = `repeat(${cols}, minmax(100px, 1fr))`;

  const cells = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cellKey = `r${r}c${c}`;
      const studentId = seatMap[cellKey];

      if (state.editingCellKey === cellKey && editable) {
        const options = Object.values(studentsById)
          .filter((s) => (room.grades || []).includes(s.grade))
          .sort((a, b) => a.grade.localeCompare(b.grade) || (a.sid || "").localeCompare(b.sid || ""));
        const optionsHtml = options
          .map((s) => {
            const seatedElsewhere = seatedRoomNameByStudentId[s.id];
            const suffix = seatedElsewhere ? ` · 현재 ${seatedElsewhere}` : "";
            return `<option value="${escapeHtml(s.id)}">${escapeHtml(s.grade)}학년 ${escapeHtml(s.name || "이름 없음")} (${escapeHtml(s.sid || "-")})${escapeHtml(suffix)}</option>`;
          })
          .join("");
        cells.push(`
          <div class="seat-cell seat-cell--editing">
            <select class="seat-cell__select" data-assign-select="${cellKey}">
              <option value="">학생 선택</option>
              ${optionsHtml}
            </select>
            <button type="button" class="seat-cell__cancel" data-cancel-cell="${cellKey}">×</button>
          </div>
        `);
        continue;
      }

      if (!studentId) {
        const clickable = editable ? " seat-cell--clickable" : "";
        cells.push(
          `<div class="seat-cell seat-cell--empty${clickable}" ${editable ? `data-empty-cell="${cellKey}"` : ""}>${editable ? "+" : ""}</div>`
        );
        continue;
      }

      const student = studentsById[studentId];
      const status = getStudentStatus(studentId, studentsById);
      const name = student ? student.name || "이름 없음" : "(삭제된 학생)";
      const meta = student ? `학번 ${student.sid || "-"}` : "";
      cells.push(`
        <div class="seat-cell seat-cell--${status}">
          <div class="seat-cell__name">${escapeHtml(name)}</div>
          ${meta ? `<div class="seat-cell__meta">${escapeHtml(meta)}</div>` : ""}
          ${editable ? `<button type="button" class="seat-cell__unassign" data-unassign-cell="${cellKey}">×</button>` : ""}
        </div>
      `);
    }
  }

  seatGridEl.innerHTML = cells.join("");
}

function render() {
  dateEl.textContent = formatToday();
  ensureActiveRoom();
  renderRoomTabs();
  renderEditToggle();
  const activeRoom = state.activeRoomId ? state.rooms[state.activeRoomId] : null;
  renderRoomSettingsPanel(activeRoom);
  renderGrid(activeRoom);
}

function resizeRoom(dimension, dir) {
  const room = state.rooms[state.activeRoomId];
  if (!room) return;
  const current = Number(room[dimension]) || 1;
  const next = Math.max(MIN_SIZE, current + dir);
  if (next === current) return;

  const rows = dimension === "rows" ? next : Number(room.rows) || 1;
  const cols = dimension === "cols" ? next : Number(room.cols) || 1;
  const updates = { [`rooms/${state.activeRoomId}/${dimension}`]: next };
  const seatMap = room.seatMap || {};
  for (const cellKey of Object.keys(seatMap)) {
    const m = /^r(\d+)c(\d+)$/.exec(cellKey);
    if (!m) continue;
    if (Number(m[1]) >= rows || Number(m[2]) >= cols) {
      updates[`rooms/${state.activeRoomId}/seatMap/${cellKey}`] = null;
    }
  }
  update(ref(db), updates);
}

function toggleRoomGrade(grade) {
  const room = state.rooms[state.activeRoomId];
  if (!room) return;
  const grades = new Set(room.grades || []);
  if (grades.has(grade)) grades.delete(grade);
  else grades.add(grade);
  set(ref(db, `rooms/${state.activeRoomId}/grades`), Array.from(grades).sort());
}

function assignStudent(targetCellKey, studentId) {
  const targetRoomId = state.activeRoomId;
  const updates = {};
  for (const [roomId, room] of Object.entries(state.rooms)) {
    const seatMap = (room && room.seatMap) || {};
    for (const [cellKey, sid] of Object.entries(seatMap)) {
      if (sid === studentId && !(roomId === targetRoomId && cellKey === targetCellKey)) {
        updates[`rooms/${roomId}/seatMap/${cellKey}`] = null;
      }
    }
  }
  updates[`rooms/${targetRoomId}/seatMap/${targetCellKey}`] = studentId;
  update(ref(db), updates);
  state.editingCellKey = null;
}

function unassignSeat(cellKey) {
  set(ref(db, `rooms/${state.activeRoomId}/seatMap/${cellKey}`), null);
}

roomTabsEl.addEventListener("click", (event) => {
  const btn = event.target.closest("[data-room-id]");
  if (!btn) return;
  state.activeRoomId = btn.dataset.roomId;
  state.editingCellKey = null;
  render();
});

editModeToggle.addEventListener("click", () => {
  state.editMode = !state.editMode;
  state.editingCellKey = null;
  render();
});

addRoomBtn.addEventListener("click", () => {
  const newRef = push(ref(db, "rooms"));
  set(newRef, { name: "새 실", grades: [], rows: 3, cols: 4, seatMap: {} }).then(() => {
    state.activeRoomId = newRef.key;
    render();
  });
});

deleteRoomBtn.addEventListener("click", () => {
  const roomIds = Object.keys(state.rooms);
  if (roomIds.length <= 1 || !state.activeRoomId) return;
  const room = state.rooms[state.activeRoomId];
  const name = room ? room.name : "이 실";
  if (!confirm(`${name}을(를) 삭제할까요? 배정된 좌석 정보도 함께 삭제됩니다.`)) return;
  remove(ref(db, `rooms/${state.activeRoomId}`));
  state.activeRoomId = null;
});

roomNameInput.addEventListener("change", () => {
  if (!state.activeRoomId) return;
  const value = roomNameInput.value.trim() || "이름 없음";
  set(ref(db, `rooms/${state.activeRoomId}/name`), value);
});

roomGradeToggleRow.addEventListener("click", (event) => {
  const btn = event.target.closest("[data-grade]");
  if (!btn) return;
  toggleRoomGrade(btn.dataset.grade);
});

rowsMinusBtn.addEventListener("click", () => resizeRoom("rows", -1));
rowsPlusBtn.addEventListener("click", () => resizeRoom("rows", 1));
colsMinusBtn.addEventListener("click", () => resizeRoom("cols", -1));
colsPlusBtn.addEventListener("click", () => resizeRoom("cols", 1));

seatGridEl.addEventListener("click", (event) => {
  const unassignBtn = event.target.closest("[data-unassign-cell]");
  if (unassignBtn) {
    unassignSeat(unassignBtn.dataset.unassignCell);
    return;
  }
  const cancelBtn = event.target.closest("[data-cancel-cell]");
  if (cancelBtn) {
    state.editingCellKey = null;
    render();
    return;
  }
  const emptyCell = event.target.closest("[data-empty-cell]");
  if (emptyCell) {
    if (!canEditRoom(state.activeRoomId)) return;
    const room = state.rooms[state.activeRoomId];
    const hasEligible = Object.values(getStudentsById()).some((s) => (room.grades || []).includes(s.grade));
    if (!hasEligible) {
      alert("이 실은 대상 학년이 지정되지 않았거나, 지정된 학년에 등록된 학생이 없습니다.\n편집 모드에서 대상 학년을 먼저 지정해 주세요.");
      return;
    }
    state.editingCellKey = emptyCell.dataset.emptyCell;
    render();
  }
});

seatGridEl.addEventListener("change", (event) => {
  const select = event.target.closest("[data-assign-select]");
  if (!select) return;
  const studentId = select.value;
  if (!studentId) {
    state.editingCellKey = null;
    render();
    return;
  }
  assignStudent(select.dataset.assignSelect, studentId);
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
      state.role = profile.role || "teacher";
      state.managedRoomIds = Object.keys(profile.managedRooms || {});
      currentUserNameEl.textContent = profile.name || loginId;
      currentUserRoleBadgeEl.textContent = state.role;
      currentUserRoleBadgeEl.className = `role-badge role-badge--${state.role}`;
      render();
    },
    { onlyOnce: true }
  );
});

logoutBtn.addEventListener("click", () => {
  signOut(auth).then(() => window.location.replace("./login.html"));
});

render();

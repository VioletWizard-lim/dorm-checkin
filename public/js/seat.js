import { supabase, requireStaff, signOutTo, describeError, showPageError } from "./supabase-client.js";
import { liveTable } from "./live-table.js";
import {
  GRADES,
  groupStudentsByGrade,
  outingsByStudent,
  roomsById,
  isScheduledOuting,
  createStartTimeTicker,
} from "./adapters.js";
import { outingPassData } from "./outing-pass.js";
import { createPassDialog } from "./pass-dialog.js";

const MIN_SIZE = 1;
let currentTeacherName = "";
let outingsLive = null;
let roomsLive = null;

// outings는 날짜별로 저장된다(check.js 참고). 좌석 배치판은 항상 "오늘"만 보여준다.
function getDateKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
const TODAY_KEY = getDateKey();

// "명령퇴사"(기간제 상태)는 students.html에서 설정하며 "자리 없음"보다 우선한다.
function isOnLeave(student, dateKey) {
  const leave = student && student.leaveOfAbsence;
  if (!leave || !leave.from || !leave.to) return false;
  return dateKey >= leave.from && dateKey <= leave.to;
}

const dateEl = document.getElementById("todayDate");
const roomTabsEl = document.getElementById("roomTabs");
const addRoomBtn = document.getElementById("addRoomBtn");
const editModeToggle = document.getElementById("editModeToggle");
const editControlsLoadingHint = document.getElementById("editControlsLoadingHint");
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
const manageLink = document.getElementById("manageLink");
const accountsLink = document.getElementById("accountsLink");
const navLoadingHint = document.getElementById("navLoadingHint");
const currentUserNameEl = document.getElementById("currentUserName");
const currentUserRoleBadgeEl = document.getElementById("currentUserRoleBadge");

const state = {
  studentsByGrade: { "1": {}, "2": {}, "3": {} },
  outings: {},
  rooms: {},
  activeRoomId: null,
  editMode: false,
  role: "teacher",
  roleResolved: false,
  managedRoomIds: [],
  editingCellKey: null,
  actionCellKey: null, // 보기 모드에서 좌석을 눌러 출석 상태를 바꿀 때 쓰는, editingCellKey와 별개인 상태
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
  const student = studentsById[studentId];
  // 우선순위: 명령퇴사 > 자리 없음 > 외출중 > 오늘 방과후 > 재실
  if (isOnLeave(student, TODAY_KEY)) return "leave";
  const outing = state.outings[studentId];
  // "unauthorized"는 예전 상태 이름(자리비움과 합쳐지기 전) — 기존 데이터 호환용으로 계속 away 취급
  if (outing && (outing.status === "away" || outing.status === "unauthorized")) return "away";
  // 외출 예정(승인됐지만 외출 시각 전)은 아직 자리에 있으므로 외출 색으로 칠하지 않는다.
  if (outing && outing.status === "out" && !isScheduledOuting(outing, TODAY_KEY, TODAY_KEY)) return "out";
  const todayIdx = todayWeekdayIndex();
  if (student && todayIdx !== null && Array.isArray(student.afterschoolDays) && student.afterschoolDays[todayIdx]) {
    return "afterschool";
  }
  return "in";
}

// 출석 상태 조작 버튼을 어떤 걸 보여줄지 결정할 때 쓰는, 방과후 색칠은 빼고 outings만 본 "실제" 상태.
function getRawOutingStatus(studentId) {
  const outing = state.outings[studentId];
  const status = outing && outing.status;
  if (status === "away" || status === "unauthorized") return "away";
  if (status === "out" && isScheduledOuting(outing, TODAY_KEY, TODAY_KEY)) return "scheduled";
  return status === "out" ? "out" : "in";
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
  editControlsLoadingHint.hidden = state.roleResolved;
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
      const scheduledOuting = isScheduledOuting(state.outings[studentId], TODAY_KEY, TODAY_KEY);
      const meta = student
        ? scheduledOuting
          ? `${state.outings[studentId].startTime} 외출 예정`
          : `학번 ${student.sid || "-"}`
        : "";
      // 보기 모드에서는(편집 모드가 아니고, 학생 데이터가 남아있고, 명령퇴사 중이 아니면)
      // 좌석을 눌러 바로 출석 상태를 바꿀 수 있다 — 명령퇴사는 students.html에서만 설정.
      const onLeave = isOnLeave(student, TODAY_KEY);
      const rawStatus = getRawOutingStatus(studentId);
      // 기숙사부는 보기만 — 외출중·외출 예정 좌석에서 외출증만 볼 수 있다(서버 can_write_outings도 막음)
      const readOnly = state.role === "dormStaff";
      const canAct =
        !state.editMode && !!student && !onLeave && (!readOnly || rawStatus === "out" || rawStatus === "scheduled");

      if (state.actionCellKey === cellKey && canAct) {
        let actionButtonsHtml;
        if (readOnly) {
          actionButtonsHtml = `<button type="button" class="seat-cell__action-btn" data-seat-pass="${escapeHtml(studentId)}">외출증</button>`;
        } else if (rawStatus === "in") {
          // "외출"(재실 -> 외출중)은 여기서 할 수 없다 — check.html에서만.
          actionButtonsHtml = `<button type="button" class="seat-cell__action-btn" data-seat-mark-away="${escapeHtml(studentId)}">자리없음</button>`;
        } else if (rawStatus === "scheduled") {
          actionButtonsHtml = `<button type="button" class="seat-cell__action-btn" data-seat-pass="${escapeHtml(studentId)}">외출증</button><button type="button" class="seat-cell__action-btn" data-seat-restore="${escapeHtml(studentId)}" data-confirm-cancel="${escapeHtml(name)}">외출 취소</button>`;
        } else if (rawStatus === "out") {
          actionButtonsHtml = `<button type="button" class="seat-cell__action-btn" data-seat-pass="${escapeHtml(studentId)}">외출증</button><button type="button" class="seat-cell__action-btn" data-seat-restore="${escapeHtml(studentId)}">복귀</button>`;
        } else {
          actionButtonsHtml = `<button type="button" class="seat-cell__action-btn" data-seat-restore="${escapeHtml(studentId)}">재실로</button>`;
        }
        cells.push(`
          <div class="seat-cell seat-cell--${status} seat-cell--action">
            <div class="seat-cell__name">${escapeHtml(name)}</div>
            <div class="seat-cell__actions">
              ${actionButtonsHtml}
              <button type="button" class="seat-cell__action-btn seat-cell__action-btn--cancel" data-seat-cancel-action>취소</button>
            </div>
          </div>
        `);
        continue;
      }

      cells.push(`
        <div class="seat-cell seat-cell--${status}${canAct ? " seat-cell--clickable" : ""}" ${canAct ? `data-attendance-cell="${cellKey}"` : ""}>
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
  updateStartTicker(Object.values(state.outings));
  passDialog.refresh();
}

// 외출증 팝업(check.html과 같은 것): 외출중·외출 예정 학생 좌석을 누르면 나오는 [외출증]
const passDialog = createPassDialog((studentId) => {
  const student = getStudentsById()[studentId];
  const status = student && !isOnLeave(student, TODAY_KEY) ? getRawOutingStatus(studentId) : "in";
  if (status !== "out" && status !== "scheduled") return null;
  return {
    title: `${student.name || "이름 없음"} 외출증${status === "scheduled" ? " (외출 예정)" : ""}`,
    pass: outingPassData(student, state.outings[studentId], TODAY_KEY),
  };
});

// 외출 예정 학생의 외출 시각이 되면 다시 그려서 외출 색으로 바꾼다.
const updateStartTicker = createStartTimeTicker(() => render());

// 저장 결과 처리: 실패하면 알리고, 성공하면 Realtime 알림을 기다리지 않고 바로 다시 읽는다.
async function afterWrite(error, live) {
  if (error) {
    alert(`저장하지 못했습니다: ${describeError(error)}`);
    return false;
  }
  if (live) await live.refresh();
  return true;
}

// 행/열 크기 변경: 줄어든 범위 밖의 좌석 배정은 서버(resize_room)가 함께 지운다.
async function resizeRoom(dimension, dir) {
  const roomId = state.activeRoomId;
  const room = state.rooms[roomId];
  if (!room) return;
  const current = Number(room[dimension]) || 1;
  const next = Math.max(MIN_SIZE, current + dir);
  if (next === current) return;

  const rows = dimension === "rows" ? next : Number(room.rows) || 1;
  const cols = dimension === "cols" ? next : Number(room.cols) || 1;
  const { error } = await supabase.rpc("resize_room", { p_room_id: roomId, p_rows: rows, p_cols: cols });
  await afterWrite(error, roomsLive);
}

async function toggleRoomGrade(grade) {
  const roomId = state.activeRoomId;
  const room = state.rooms[roomId];
  if (!room) return;
  const grades = new Set(room.grades || []);
  if (grades.has(grade)) grades.delete(grade);
  else grades.add(grade);
  const { error } = await supabase
    .from("rooms")
    .update({ grades: Array.from(grades).sort().map(Number) })
    .eq("id", roomId);
  await afterWrite(error, roomsLive);
}

// 그 학생이 다른 자리(다른 실 포함)에 앉아 있던 기록은 서버(assign_seat)가 함께 지운다.
async function assignStudent(targetCellKey, studentId) {
  const roomId = state.activeRoomId;
  state.editingCellKey = null;
  const { error } = await supabase.rpc("assign_seat", {
    p_room_id: roomId,
    p_cell_key: targetCellKey,
    p_student_id: studentId,
  });
  await afterWrite(error, roomsLive);
}

async function unassignSeat(cellKey) {
  const { error } = await supabase.rpc("unassign_seat", { p_room_id: state.activeRoomId, p_cell_key: cellKey });
  await afterWrite(error, roomsLive);
}

// 좌석 배치도에서는 "외출"(재실 -> 외출중)은 할 수 없다 — 그건 사유·이메일까지 딸린 공식적인
// 절차라 check.html에서만 하도록 함. 여기서는 순회하며 바로 처리할 만한 것만: 자리없음 표시/해제,
// 이미 나간 학생의 복귀 체크(둘 다 그냥 "재실"로 되돌리는 동작이라 restoreToIn 하나로 처리).
// 시각(since)과 담당 교사는 서버 트리거가 채운다.
async function saveTodayStatus(studentId, status) {
  const { error } = await supabase
    .from("outings")
    .upsert({ date: TODAY_KEY, student_id: studentId, status }, { onConflict: "date,student_id" });
  await afterWrite(error, outingsLive);
}

function markAway(studentId) {
  return saveTodayStatus(studentId, "away");
}

function restoreToIn(studentId) {
  return saveTodayStatus(studentId, "in");
}

roomTabsEl.addEventListener("click", (event) => {
  const btn = event.target.closest("[data-room-id]");
  if (!btn) return;
  state.activeRoomId = btn.dataset.roomId;
  state.editingCellKey = null;
  state.actionCellKey = null;
  render();
});

editModeToggle.addEventListener("click", () => {
  state.editMode = !state.editMode;
  state.editingCellKey = null;
  state.actionCellKey = null;
  render();
});

addRoomBtn.addEventListener("click", async () => {
  addRoomBtn.disabled = true;
  const { data, error } = await supabase
    .from("rooms")
    .insert({ name: "새 실", grades: [], rows: 3, cols: 4, seat_map: {} })
    .select("id")
    .single();
  const saved = await afterWrite(error, roomsLive);
  addRoomBtn.disabled = false;
  if (!saved) return;
  // 다시 읽은 목록에 새 실이 들어온 뒤에 선택해야 첫 번째 실로 되돌아가지 않는다.
  state.activeRoomId = data.id;
  render();
});

deleteRoomBtn.addEventListener("click", () => {
  const roomIds = Object.keys(state.rooms);
  if (roomIds.length <= 1 || !state.activeRoomId) return;
  const room = state.rooms[state.activeRoomId];
  const name = room ? room.name : "이 실";
  if (!confirm(`${name}을(를) 삭제할까요? 배정된 좌석 정보도 함께 삭제됩니다.`)) return;
  const roomId = state.activeRoomId;
  supabase
    .from("rooms")
    .delete()
    .eq("id", roomId)
    .then(async ({ error }) => {
      if ((await afterWrite(error, roomsLive)) && state.activeRoomId === roomId) {
        state.activeRoomId = null;
        render();
      }
    });
});

roomNameInput.addEventListener("change", async () => {
  if (!state.activeRoomId) return;
  const value = roomNameInput.value.trim() || "이름 없음";
  const { error } = await supabase.from("rooms").update({ name: value }).eq("id", state.activeRoomId);
  await afterWrite(error, roomsLive);
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

  const cancelActionBtn = event.target.closest("[data-seat-cancel-action]");
  if (cancelActionBtn) {
    state.actionCellKey = null;
    render();
    return;
  }

  const markAwayBtn = event.target.closest("[data-seat-mark-away]");
  if (markAwayBtn) {
    if (window.confirm("이 학생을 '자리 없음'으로 표시할까요?")) {
      markAway(markAwayBtn.dataset.seatMarkAway);
    }
    state.actionCellKey = null;
    render();
    return;
  }

  const passBtn = event.target.closest("[data-seat-pass]");
  if (passBtn) {
    state.actionCellKey = null;
    render();
    passDialog.open(passBtn.dataset.seatPass);
    return;
  }

  const restoreBtn = event.target.closest("[data-seat-restore]");
  if (restoreBtn) {
    // 승인된 외출(외출 예정)을 취소할 때는 한 번 확인한다.
    if (restoreBtn.dataset.confirmCancel && !window.confirm(`${restoreBtn.dataset.confirmCancel} 학생의 외출을 취소할까요?`)) return;
    restoreToIn(restoreBtn.dataset.seatRestore);
    state.actionCellKey = null;
    render();
    return;
  }

  const attendanceCell = event.target.closest("[data-attendance-cell]");
  if (attendanceCell) {
    state.actionCellKey = attendanceCell.dataset.attendanceCell;
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

function reportLoadError(error) {
  showPageError(`데이터를 불러오지 못했습니다(${describeError(error)}). 잠시 후 자동으로 다시 시도합니다.`);
}

async function init() {
  const session = await requireStaff();
  if (!session) return;
  const { loginId, profile } = session;
  // 자습 감독 계정은 외출 체크 화면만 쓸 수 있다.
  if (profile.role === "studyHallSupervisor") {
    window.location.replace("./check.html");
    return;
  }
  state.role = profile.role || "teacher";
  state.roleResolved = true;
  state.managedRoomIds = Object.keys(profile.managedRooms || {});
  currentTeacherName = profile.name || "";
  currentUserNameEl.textContent = currentTeacherName || loginId;
  currentUserRoleBadgeEl.textContent = state.role;
  currentUserRoleBadgeEl.className = `role-badge role-badge--${state.role}`;
  const hasManagedClasses = Object.values(profile.managedClasses || {}).some(
    (classes) => Object.keys(classes || {}).length > 0
  );
  navLoadingHint.hidden = true;
  manageLink.hidden =
    state.role !== "admin" && state.role !== "gradeManager" && state.role !== "dormStaff" && !hasManagedClasses;
  accountsLink.hidden = state.role !== "admin";
  render();

  liveTable({
    table: "students",
    order: ["id"],
    onRows: (rows) => {
      state.studentsByGrade = groupStudentsByGrade(rows);
      render();
    },
    onError: reportLoadError,
  });

  outingsLive = liveTable({
    table: "outings",
    order: ["student_id"],
    eq: { date: TODAY_KEY },
    onRows: (rows) => {
      state.outings = outingsByStudent(rows);
      render();
    },
    onError: reportLoadError,
  });

  roomsLive = liveTable({
    table: "rooms",
    order: ["created_at", "id"],
    onRows: (rows) => {
      state.rooms = roomsById(rows);
      render();
    },
    onError: reportLoadError,
  });
}

logoutBtn.addEventListener("click", () => signOutTo());

render();
init();

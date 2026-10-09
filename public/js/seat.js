import { supabase, requireStaff, signOutTo, describeError, reportLoadError } from "./supabase-client.js";
import { getDateKey, isOnLeave, escapeHtml, formatToday, todayWeekdayIndex } from "./util.js";
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

const TODAY_KEY = getDateKey();

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
const seatBulkBtn = document.getElementById("seatBulkBtn");
const seatBulkWrap = document.getElementById("seatBulkWrap");
const seatBulkRoomName = document.getElementById("seatBulkRoomName");
const seatBulkInput = document.getElementById("seatBulkInput");
const seatBulkPreview = document.getElementById("seatBulkPreview");
const seatBulkSaveBtn = document.getElementById("seatBulkSaveBtn");
const seatBulkCancelBtn = document.getElementById("seatBulkCancelBtn");
const logoutBtn = document.getElementById("logoutBtn");
const manageLink = document.getElementById("manageLink");
const accountsLink = document.getElementById("accountsLink");
const historyLink = document.getElementById("historyLink");
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

// 외출 체크·외출 취소·복귀를 할 수 있는 담당 범위: 관리자 전체, 학년부장 담당 학년, 담임 담당 반(서버 can_manage_student)
function canManageStudent(student) {
  const p = state.profile;
  if (!p || !student) return false;
  if (p.role === "admin") return true;
  if (p.role === "gradeManager") return Boolean((p.managedGrades || {})[student.grade]);
  if (p.role === "teacher") return Boolean(((p.managedClasses || {})[student.grade] || {})[student.cls]);
  return false;
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
  const canBulk = canEditRoom(state.activeRoomId);
  seatBulkBtn.hidden = !canBulk;
  if (!canBulk && !seatBulkWrap.hidden) closeSeatBulk();
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
        // 학번을 입력하고 Enter → 배정 후 다음 빈자리로(사용자 요청: 학번으로 빠르게 연속 배정). 목록에서 골라도 됨
        cells.push(`
          <div class="seat-cell seat-cell--editing" data-cell-key="${cellKey}">
            <div class="seat-cell__pick">
              <input type="text" class="seat-cell__sid" data-assign-sid="${cellKey}" inputmode="numeric" autocomplete="off" placeholder="학번 입력 후 Enter">
              <select class="seat-cell__select" data-assign-select="${cellKey}">
                <option value="">또는 목록에서 선택</option>
                ${optionsHtml}
              </select>
            </div>
            <button type="button" class="seat-cell__cancel" data-cancel-cell="${cellKey}">×</button>
          </div>
        `);
        continue;
      }

      if (!studentId) {
        const clickable = editable ? " seat-cell--clickable" : "";
        cells.push(
          `<div class="seat-cell seat-cell--empty${clickable}" ${editable ? `data-empty-cell="${cellKey}" data-cell-key="${cellKey}"` : ""}>${editable ? "+" : ""}</div>`
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
          // 외출 취소는 담당 범위만(서버 outings_check_scope와 같은 규칙)
          actionButtonsHtml = `<button type="button" class="seat-cell__action-btn" data-seat-pass="${escapeHtml(studentId)}">외출증</button>${
            canManageStudent(student)
              ? `<button type="button" class="seat-cell__action-btn" data-seat-restore="${escapeHtml(studentId)}" data-confirm-cancel="${escapeHtml(name)}">외출 취소</button>`
              : ""
          }`;
        } else if (rawStatus === "out") {
          // 복귀는 담당 범위 + 자습 감독(확인 창 한 번)
          const manage = canManageStudent(student);
          const supervisor = state.role === "studyHallSupervisor";
          actionButtonsHtml = `<button type="button" class="seat-cell__action-btn" data-seat-pass="${escapeHtml(studentId)}">외출증</button>${
            manage || supervisor
              ? `<button type="button" class="seat-cell__action-btn" data-seat-restore="${escapeHtml(studentId)}"${manage ? "" : ` data-confirm-return="${escapeHtml(name)}"`}>복귀</button>`
              : ""
          }`;
        } else {
          actionButtonsHtml = `<button type="button" class="seat-cell__action-btn" data-seat-restore="${escapeHtml(studentId)}">재실로</button>`;
        }
        cells.push(`
          <div class="seat-cell seat-cell--${status} seat-cell--action" data-action-cell="${cellKey}">
            <div class="seat-cell__name">${escapeHtml(name)}</div>
            <div class="seat-cell__actions">
              ${actionButtonsHtml}
              <button type="button" class="seat-cell__action-btn seat-cell__action-btn--cancel" data-seat-cancel-action>취소</button>
            </div>
          </div>
        `);
        continue;
      }

      // 편집 모드에서는 배정된 좌석을 끌어서 다른 자리로 옮긴다(빈자리 = 이동, 학생 자리 = 맞바꿈)
      const dragAttrs = editable ? ` data-drag-cell="${cellKey}" data-cell-key="${cellKey}"` : "";
      cells.push(`
        <div class="seat-cell seat-cell--${status}${canAct ? " seat-cell--clickable" : ""}${editable ? " seat-cell--draggable" : ""}" ${canAct ? `data-attendance-cell="${cellKey}"` : ""}${dragAttrs}>
          <div class="seat-cell__name">${escapeHtml(name)}</div>
          ${meta ? `<div class="seat-cell__meta">${escapeHtml(meta)}</div>` : ""}
          ${editable ? `<button type="button" class="seat-cell__unassign" data-unassign-cell="${cellKey}">×</button>` : ""}
        </div>
      `);
    }
  }

  // 실시간 갱신으로 다시 그려도 입력 중인 학번과 커서는 그대로 둔다
  const sidInput = seatGridEl.querySelector("[data-assign-sid]");
  const pendingSid = sidInput && sidInput.dataset.assignSid === state.editingCellKey ? sidInput.value : "";
  seatGridEl.innerHTML = cells.join("");
  const newSidInput = seatGridEl.querySelector("[data-assign-sid]");
  if (newSidInput) {
    newSidInput.value = pendingSid;
    newSidInput.focus();
  }
}

function render() {
  dateEl.textContent = formatToday();
  ensureActiveRoom();
  renderRoomTabs();
  renderEditToggle();
  const activeRoom = state.activeRoomId ? state.rooms[state.activeRoomId] : null;
  renderRoomSettingsPanel(activeRoom);
  if (!seatBulkWrap.hidden) renderSeatBulkPreview(); // 실을 바꾸거나 명단·좌석이 바뀌면 미리보기도 다시
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
// continueToNext면 배정한 뒤 다음 빈자리(오른쪽 → 다음 줄)를 바로 열어 학번을 이어서 입력할 수 있게 한다.
async function assignStudent(targetCellKey, studentId, { continueToNext = false } = {}) {
  const roomId = state.activeRoomId;
  state.editingCellKey = null;
  const { error } = await supabase.rpc("assign_seat", {
    p_room_id: roomId,
    p_cell_key: targetCellKey,
    p_student_id: studentId,
  });
  const ok = await afterWrite(error, roomsLive);
  if (ok && continueToNext && state.activeRoomId === roomId && state.editMode) {
    state.editingCellKey = nextEmptyCellKey(state.rooms[roomId], targetCellKey);
    render();
  }
}

function nextEmptyCellKey(room, afterCellKey) {
  if (!room) return null;
  const rows = Number(room.rows) || 1;
  const cols = Number(room.cols) || 1;
  const seatMap = room.seatMap || {};
  const [, r0, c0] = /^r(\d+)c(\d+)$/.exec(afterCellKey) || [, "0", "-1"];
  for (let i = Number(r0) * cols + Number(c0) + 1; i < rows * cols; i++) {
    const key = `r${Math.floor(i / cols)}c${i % cols}`;
    if (!seatMap[key]) return key;
  }
  return null;
}

// 학번으로 배정: 이 실의 대상 학년 학생 중 학번이 같은 학생
function assignBySid(cellKey, rawSid) {
  const sid = rawSid.replace(/\s+/g, "");
  if (!sid) return;
  const room = state.rooms[state.activeRoomId];
  const grades = (room && room.grades) || [];
  const matches = Object.values(getStudentsById()).filter((s) => s.sid === sid && grades.includes(s.grade));
  if (matches.length === 0) {
    const elsewhere = Object.values(getStudentsById()).find((s) => s.sid === sid);
    alert(
      elsewhere
        ? `학번 ${sid} ${elsewhere.name || ""} 학생은 ${elsewhere.grade}학년이라 이 실(대상 학년 ${grades.join("·") || "없음"})에 배정할 수 없습니다.`
        : `학번 ${sid} 학생이 명단에 없습니다.`
    );
    return;
  }
  if (matches.length > 1) {
    alert(`학번 ${sid} 학생이 여러 명입니다. 목록에서 골라 주세요.`);
    return;
  }
  const student = matches[0];
  const seatedElsewhere = getSeatedRoomNameByStudentId()[student.id];
  if (seatedElsewhere && !confirm(`${student.name}(${sid})은(는) 지금 ${seatedElsewhere}에 앉아 있습니다. 이 자리로 옮길까요?`)) return;
  assignStudent(cellKey, student.id, { continueToNext: true });
  render();
}

// 끌어서 옮기기: 빈자리면 이동, 다른 학생이 있으면 맞바꾼다(서버 move_seat가 한 번에 처리)
async function moveSeat(fromCellKey, toCellKey) {
  const { error } = await supabase.rpc("move_seat", {
    p_room_id: state.activeRoomId,
    p_from_cell: fromCellKey,
    p_to_cell: toCellKey,
  });
  await afterWrite(error, roomsLive);
}

// 마우스·터치(전자칠판) 모두 Pointer Events로 처리한다. 조금(6px) 움직여야 끌기로 보고,
// 그보다 적게 움직이면 보통 클릭(× 해제 등)으로 둔다.
const DRAG_THRESHOLD = 6;
let drag = null; // { fromCellKey, startX, startY, ghost, targetEl, pointerId }
let suppressNextClick = false;

function dropTargetAt(x, y) {
  const el = document.elementFromPoint(x, y);
  const cell = el && el.closest("#seatGrid [data-cell-key]");
  return cell || null;
}

function setDropTarget(el) {
  if (drag.targetEl === el) return;
  if (drag.targetEl) drag.targetEl.classList.remove("seat-cell--drop-target");
  drag.targetEl = el && el.dataset.cellKey !== drag.fromCellKey ? el : null;
  if (drag.targetEl) drag.targetEl.classList.add("seat-cell--drop-target");
}

function endDrag() {
  if (!drag) return;
  if (drag.ghost) drag.ghost.remove();
  if (drag.targetEl) drag.targetEl.classList.remove("seat-cell--drop-target");
  const source = seatGridEl.querySelector(`[data-drag-cell="${drag.fromCellKey}"]`);
  if (source) source.classList.remove("seat-cell--dragging");
  document.body.classList.remove("is-dragging-seat");
  drag = null;
}

seatGridEl.addEventListener("pointerdown", (event) => {
  if (!state.editMode || event.button > 0) return;
  if (event.target.closest("button, input, select")) return;
  const cell = event.target.closest("[data-drag-cell]");
  if (!cell || !canEditRoom(state.activeRoomId)) return;
  drag = { fromCellKey: cell.dataset.dragCell, startX: event.clientX, startY: event.clientY, ghost: null, targetEl: null, pointerId: event.pointerId };
});

document.addEventListener("pointermove", (event) => {
  if (!drag || event.pointerId !== drag.pointerId) return;
  if (!drag.ghost) {
    if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < DRAG_THRESHOLD) return;
    const source = seatGridEl.querySelector(`[data-drag-cell="${drag.fromCellKey}"]`);
    if (!source) {
      endDrag();
      return;
    }
    state.editingCellKey = null;
    const rect = source.getBoundingClientRect();
    drag.ghost = source.cloneNode(true);
    drag.ghost.classList.add("seat-cell--ghost");
    drag.ghost.style.width = `${rect.width}px`;
    drag.ghost.style.height = `${rect.height}px`;
    drag.offsetX = drag.startX - rect.left;
    drag.offsetY = drag.startY - rect.top;
    document.body.append(drag.ghost);
    source.classList.add("seat-cell--dragging");
    document.body.classList.add("is-dragging-seat");
  }
  event.preventDefault();
  drag.ghost.style.left = `${event.clientX - drag.offsetX}px`;
  drag.ghost.style.top = `${event.clientY - drag.offsetY}px`;
  setDropTarget(dropTargetAt(event.clientX, event.clientY));
});

document.addEventListener("pointerup", (event) => {
  if (!drag || event.pointerId !== drag.pointerId) return;
  const wasDragging = Boolean(drag.ghost);
  const from = drag.fromCellKey;
  const target = wasDragging ? dropTargetAt(event.clientX, event.clientY) : null;
  endDrag();
  if (!wasDragging) return;
  suppressNextClick = true; // 끌기를 마친 뒤 따라오는 click(빈자리 열기 등)은 무시
  setTimeout(() => (suppressNextClick = false), 0);
  const to = target && target.dataset.cellKey;
  if (to && to !== from) moveSeat(from, to);
});

document.addEventListener("pointercancel", endDrag);

// Esc로도 열린 좌석 버튼을 닫는다
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.actionCellKey) {
    state.actionCellKey = null;
    render();
  }
});

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

// ───────────── 좌석 일괄 등록(사용자 요청) ─────────────
// 탭이 있는 줄이 있으면 "자리 모양 그대로"(줄 = 행, 칸 = 열), 없으면 학번 목록을 앞자리부터 차례로 채운다.
// 칸에서 다섯 자리 숫자(학번)만 읽으므로 "10305 홍길동"처럼 이름이 같이 있어도 된다.
let seatBulkPlan = null; // { seatMap, count, errors }

function parseSeatBulk(text, room) {
  const rows = Number(room.rows) || 1;
  const cols = Number(room.cols) || 1;
  const lines = text.replace(/\s+$/, "").split(/\r?\n/);
  const cells = []; // { r, c, raw }
  if (lines.some((line) => line.includes("\t"))) {
    lines.forEach((line, r) => line.split("\t").forEach((raw, c) => cells.push({ r, c, raw: raw.trim() })));
  } else {
    const tokens = text.split(/[\s,]+/).filter(Boolean);
    tokens.forEach((raw, i) => cells.push({ r: Math.floor(i / cols), c: i % cols, raw }));
  }
  const bySid = new Map(Object.values(getStudentsById()).map((s) => [s.sid, s]));
  const grades = room.grades || [];
  const seatMap = {};
  const grid = {}; // 미리보기: cellKey → { text, error }
  const errors = [];
  const seen = new Map(); // studentId → cellKey
  for (const { r, c, raw } of cells) {
    if (!raw) continue;
    const key = `r${r}c${c}`;
    const match = /(\d{5})/.exec(raw);
    if (r >= rows || c >= cols) {
      errors.push(`${r + 1}행 ${c + 1}열 "${raw}": 이 실(${rows}행×${cols}열)보다 큽니다. 편집 모드에서 행·열을 먼저 늘려 주세요.`);
      continue;
    }
    if (!match) {
      grid[key] = { text: raw, error: true };
      errors.push(`${r + 1}행 ${c + 1}열 "${raw}": 학번(다섯 자리 숫자)을 찾지 못했습니다.`);
      continue;
    }
    const student = bySid.get(match[1]);
    if (!student) {
      grid[key] = { text: match[1], error: true };
      errors.push(`${r + 1}행 ${c + 1}열: 학번 ${match[1]} 학생이 명단에 없습니다.`);
      continue;
    }
    if (!grades.includes(student.grade)) {
      grid[key] = { text: student.name, error: true };
      errors.push(`${r + 1}행 ${c + 1}열: ${student.name}(${student.sid})은(는) ${student.grade}학년이라 이 실(대상 학년 ${grades.join("·") || "없음"})에 앉을 수 없습니다.`);
      continue;
    }
    if (seen.has(student.id)) {
      grid[key] = { text: student.name, error: true };
      errors.push(`${r + 1}행 ${c + 1}열: ${student.name}(${student.sid})이(가) 위에 이미 있습니다.`);
      continue;
    }
    seen.set(student.id, key);
    seatMap[key] = student.id;
    grid[key] = { text: student.name, error: false };
  }
  return { seatMap, grid, count: Object.keys(seatMap).length, errors, rows, cols };
}

function renderSeatBulkPreview() {
  const room = state.rooms[state.activeRoomId];
  if (!room) return;
  seatBulkRoomName.textContent = `${room.name || "이름 없음"} (${room.rows}행×${room.cols}열)`;
  const text = seatBulkInput.value;
  if (!text.trim()) {
    seatBulkPlan = null;
    seatBulkPreview.innerHTML = "";
    seatBulkSaveBtn.disabled = true;
    seatBulkSaveBtn.textContent = "좌석표 저장 (0명)";
    return;
  }
  const plan = parseSeatBulk(text, room);
  seatBulkPlan = plan;
  const cellsHtml = [];
  for (let r = 0; r < plan.rows; r++) {
    for (let c = 0; c < plan.cols; c++) {
      const g = plan.grid[`r${r}c${c}`];
      const cls = !g ? " seat-bulk-grid__cell--empty" : g.error ? " seat-bulk-grid__cell--error" : "";
      cellsHtml.push(`<div class="seat-bulk-grid__cell${cls}">${g ? escapeHtml(g.text) : "빈자리"}</div>`);
    }
  }
  seatBulkPreview.innerHTML =
    `<div class="seat-bulk-grid" style="grid-template-columns: repeat(${plan.cols}, minmax(64px, 1fr))">${cellsHtml.join("")}</div>` +
    (plan.errors.length > 0
      ? `<div class="bulk-preview__errors">${plan.errors.map((e) => `<div>${escapeHtml(e)}</div>`).join("")}</div>`
      : "");
  // 오류가 하나라도 있으면 저장하지 않는다(고친 뒤 다시) — 일부만 들어간 좌석표가 생기지 않게
  seatBulkSaveBtn.disabled = plan.count === 0 || plan.errors.length > 0;
  seatBulkSaveBtn.textContent = `좌석표 저장 (${plan.count}명)`;
}

function closeSeatBulk() {
  seatBulkWrap.hidden = true;
  seatBulkPlan = null;
}

seatBulkBtn.addEventListener("click", () => {
  if (!canEditRoom(state.activeRoomId)) return;
  state.editingCellKey = null;
  seatBulkInput.value = "";
  renderSeatBulkPreview();
  seatBulkWrap.hidden = false;
  render();
  seatBulkInput.focus();
});

seatBulkCancelBtn.addEventListener("click", closeSeatBulk);
seatBulkInput.addEventListener("input", renderSeatBulkPreview);

seatBulkSaveBtn.addEventListener("click", async () => {
  const room = state.rooms[state.activeRoomId];
  if (!room || !seatBulkPlan || seatBulkPlan.errors.length > 0 || seatBulkPlan.count === 0) return;
  const filled = Object.keys(room.seatMap || {}).length;
  const ok = confirm(
    `${room.name || "이 실"}의 좌석표를 새로 저장합니다(${seatBulkPlan.count}명).` +
      (filled > 0 ? `\n지금 배정된 ${filled}자리는 새 좌석표로 바뀝니다.` : "") +
      "\n다른 실에 앉아 있던 학생은 그 자리가 비워집니다."
  );
  if (!ok) return;
  seatBulkSaveBtn.disabled = true;
  const { error } = await supabase.rpc("set_room_seats", { p_room_id: state.activeRoomId, p_seat_map: seatBulkPlan.seatMap });
  if (await afterWrite(error, roomsLive)) closeSeatBulk();
  else renderSeatBulkPreview();
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
  if (suppressNextClick) {
    suppressNextClick = false;
    return;
  }
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
    // 자습 감독의 복귀는 한 번 더 확인한다(사용자 요청)
    if (restoreBtn.dataset.confirmReturn && !window.confirm(`${restoreBtn.dataset.confirmReturn} 학생이 복귀한 것이 확실한가요?`)) return;
    restoreToIn(restoreBtn.dataset.seatRestore);
    state.actionCellKey = null;
    render();
    return;
  }

  // 버튼이 열린 좌석을 다시 누르면(버튼 말고 좌석 자리) 닫고 원래대로(사용자 요청)
  if (event.target.closest("[data-action-cell]")) {
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

seatGridEl.addEventListener("keydown", (event) => {
  const input = event.target.closest("[data-assign-sid]");
  if (!input) return;
  if (event.key === "Enter") {
    event.preventDefault();
    assignBySid(input.dataset.assignSid, input.value);
  } else if (event.key === "Escape") {
    state.editingCellKey = null;
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

async function init() {
  const session = await requireStaff();
  if (!session) return;
  const { loginId, profile } = session;
  state.role = profile.role || "teacher";
  state.profile = profile;
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
  historyLink.hidden = state.role !== "admin" && state.role !== "gradeManager" && !hasManagedClasses;
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

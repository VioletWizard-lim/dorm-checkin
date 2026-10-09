import { requireStaff, signOutTo, reportLoadError } from "./supabase-client.js";
import { getDateKey, isOnLeave, escapeHtml, formatToday, formatTime, todayWeekdayIndex } from "./util.js";
import { liveTable } from "./live-table.js";
import {
  GRADES,
  groupStudentsByGrade,
  outingsByStudent,
  roomsById,
  isScheduledOuting,
  createStartTimeTicker,
} from "./adapters.js";

const TODAY_KEY = getDateKey();

const logoutBtn = document.getElementById("logoutBtn");
const currentUserNameEl = document.getElementById("currentUserName");
const currentUserRoleBadgeEl = document.getElementById("currentUserRoleBadge");
const manageLink = document.getElementById("manageLink");
const accountsLink = document.getElementById("accountsLink");
const afterschoolLink = document.getElementById("afterschoolLink");
const historyLink = document.getElementById("historyLink");
const navLoadingHint = document.getElementById("navLoadingHint");
const dateEl = document.getElementById("todayDate");
const gradeChipsEl = document.getElementById("gradeChips");
const chipsEl = document.getElementById("filterChips");
const outListEl = document.getElementById("outPanelList");
const outCountEl = document.getElementById("outPanelCount");
const awayListEl = document.getElementById("awayPanelList");
const awayCountEl = document.getElementById("awayPanelCount");
const leaveListEl = document.getElementById("leavePanelList");
const leaveCountEl = document.getElementById("leavePanelCount");
const afterschoolListEl = document.getElementById("afterschoolPanelList");
const afterschoolCountEl = document.getElementById("afterschoolPanelCount");

const state = {
  isAfterschoolDay: false, // 오늘이 방과후 있는 날인지(afterschool_dates)
  studentsByGrade: { "1": {}, "2": {}, "3": {} },
  outings: {},
  rooms: {},
  activeGradeFilter: "all",
  activeRoomFilter: "all",
};

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

function renderOutingPanel(students, statuses, listEl, countEl, extraLabel, emptyText) {
  const statusList = Array.isArray(statuses) ? statuses : [statuses];
  // 외출 예정(승인됐지만 외출 시각 전)은 외출중 패널 맨 아래에 따로 표시하고 인원에서는 뺀다.
  const isScheduled = (s) => isScheduledOuting(state.outings[s.id], TODAY_KEY, TODAY_KEY);
  const matched = students
    .filter((s) => state.outings[s.id] && statusList.includes(state.outings[s.id].status))
    .sort((a, b) => {
      const sa = isScheduled(a);
      const sb = isScheduled(b);
      if (sa !== sb) return sa ? 1 : -1;
      if (sa) return state.outings[a.id].startTime.localeCompare(state.outings[b.id].startTime);
      return (state.outings[a.id]?.since || 0) - (state.outings[b.id]?.since || 0);
    });

  const scheduledCount = matched.filter(isScheduled).length;
  countEl.textContent = `${matched.length - scheduledCount}명${scheduledCount ? ` · 예정 ${scheduledCount}명` : ""}`;

  if (matched.length === 0) {
    listEl.innerHTML = `<div class="display-panel__empty">${emptyText}</div>`;
    return;
  }

  listEl.innerHTML = matched
    .map((s) => {
      const outing = state.outings[s.id];
      const scheduled = isScheduled(s);
      return `
        <div class="display-card${scheduled ? " display-card--scheduled" : ""}">
          <div class="display-card__avatar">${escapeHtml((s.name || "?").charAt(0))}</div>
          <div class="display-card__info">
            <div class="display-card__name">${escapeHtml(s.name || "이름 없음")}</div>
            <div class="display-card__meta">학번 ${escapeHtml(s.sid || "-")} · ${escapeHtml(s.cls || "-")}</div>
          </div>
          <div class="display-card__extra">${escapeHtml((outing && outing.startTime) || formatTime(outing && outing.since))} ${scheduled ? "외출 예정" : extraLabel}</div>
        </div>
      `;
    })
    .join("");
}

function renderAfterschoolPanel(students) {
  // 방과후는 방과후 일정(afterschool.html)에서 고른 "방과후 있는 날"에만, 학생의 방과후 요일대로
  const todayIdx = state.isAfterschoolDay ? todayWeekdayIndex() : null;
  const afterschoolStudents = todayIdx === null
    ? []
    : students
        .filter((s) => Array.isArray(s.afterschoolDays) && s.afterschoolDays[todayIdx])
        .sort((a, b) => (a.sid || "").localeCompare(b.sid || ""));

  afterschoolCountEl.textContent = `${afterschoolStudents.length}명`;

  if (afterschoolStudents.length === 0) {
    const emptyText = todayIdx === null ? "오늘은 방과후가 없는 날입니다." : "오늘 방과후 학생이 없습니다.";
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

function renderLeavePanel(leaveStudents) {
  leaveStudents = leaveStudents.slice().sort((a, b) => (a.sid || "").localeCompare(b.sid || ""));

  leaveCountEl.textContent = `${leaveStudents.length}명`;

  if (leaveStudents.length === 0) {
    leaveListEl.innerHTML = `<div class="display-panel__empty">명령퇴사 중인 학생이 없습니다.</div>`;
    return;
  }

  leaveListEl.innerHTML = leaveStudents
    .map((s) => {
      const leave = s.leaveOfAbsence || {};
      return `
        <div class="display-card">
          <div class="display-card__avatar">${escapeHtml((s.name || "?").charAt(0))}</div>
          <div class="display-card__info">
            <div class="display-card__name">${escapeHtml(s.name || "이름 없음")}</div>
            <div class="display-card__meta">학번 ${escapeHtml(s.sid || "-")} · ${escapeHtml(s.cls || "-")}</div>
          </div>
          <div class="display-card__extra">~${escapeHtml(leave.to || "")}</div>
        </div>
      `;
    })
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

  // 명령퇴사 중인 학생은 그 기간 동안 자리 없음·외출·방과후 판정에서 제외하고 별도 패널에만 표시한다.
  const onLeave = filtered.filter((s) => isOnLeave(s, TODAY_KEY));
  const notOnLeave = filtered.filter((s) => !isOnLeave(s, TODAY_KEY));

  // "unauthorized"는 예전 상태 이름(자리비움과 합쳐지기 전) — 기존 데이터 호환용으로 계속 같이 조회
  renderOutingPanel(notOnLeave, ["away", "unauthorized"], awayListEl, awayCountEl, "자리 없음", "자리 없음으로 표시된 학생이 없습니다.");
  renderOutingPanel(notOnLeave, "out", outListEl, outCountEl, "외출", "외출중인 학생이 없습니다.");
  renderLeavePanel(onLeave);
  renderAfterschoolPanel(notOnLeave);
  updateStartTicker(Object.values(state.outings));
}

// 외출 예정 학생의 외출 시각이 되면 다시 그린다.
const updateStartTicker = createStartTimeTicker(() => render());

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

async function init() {
  const session = await requireStaff();
  if (!session) return;
  const { loginId, profile } = session;
  const role = profile.role || "teacher";
  currentUserNameEl.textContent = profile.name || loginId;
  currentUserRoleBadgeEl.textContent = role;
  currentUserRoleBadgeEl.className = `role-badge role-badge--${role}`;
  const hasManagedClasses = Object.values(profile.managedClasses || {}).some(
    (classes) => Object.keys(classes || {}).length > 0
  );
  navLoadingHint.hidden = true;
  manageLink.hidden = role !== "admin" && role !== "gradeManager" && role !== "dormStaff" && !hasManagedClasses;
  accountsLink.hidden = role !== "admin";
  afterschoolLink.hidden = role !== "admin";
  historyLink.hidden = role !== "admin" && role !== "gradeManager" && !hasManagedClasses;

  liveTable({
    table: "afterschool_dates",
    select: "date",
    order: ["date"],
    eq: { date: TODAY_KEY },
    onRows: (rows) => {
      state.isAfterschoolDay = rows.length > 0;
      render();
    },
    onError: reportLoadError,
  });

  liveTable({
    table: "students",
    order: ["id"],
    onRows: (rows) => {
      state.studentsByGrade = groupStudentsByGrade(rows);
      render();
    },
    onError: reportLoadError,
  });

  liveTable({
    table: "outings",
    order: ["student_id"],
    eq: { date: TODAY_KEY },
    onRows: (rows) => {
      state.outings = outingsByStudent(rows);
      render();
    },
    onError: reportLoadError,
  });

  liveTable({
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

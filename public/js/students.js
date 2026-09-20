import { auth, db } from "./firebase-init.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  ref,
  onValue,
  push,
  set,
  update,
  remove,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";
import { FAKE_EMAIL_DOMAIN } from "./firebase-config.js";

const ALL_GRADES = ["1", "2", "3"];
const DAY_LABELS = ["월", "화", "수", "목", "금"];

const logoutBtn = document.getElementById("logoutBtn");
const currentUserNameEl = document.getElementById("currentUserName");
const currentUserRoleBadgeEl = document.getElementById("currentUserRoleBadge");
const gradeTabsEl = document.getElementById("gradeTabs");
const rosterListEl = document.getElementById("rosterList");
const addStudentBtn = document.getElementById("addStudentBtn");
const formWrap = document.getElementById("formWrap");
const studentForm = document.getElementById("studentForm");
const editingIdInput = document.getElementById("editingId");
const inputName = document.getElementById("inputName");
const inputSid = document.getElementById("inputSid");
const inputCls = document.getElementById("inputCls");
const inputEmail = document.getElementById("inputEmail");
const dayToggleRow = document.getElementById("dayToggleRow");
const inputLeaveFrom = document.getElementById("inputLeaveFrom");
const inputLeaveTo = document.getElementById("inputLeaveTo");
const inputLeaveReason = document.getElementById("inputLeaveReason");
const cancelFormBtn = document.getElementById("cancelFormBtn");

function getDateKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
const TODAY_KEY = getDateKey();

// "명령퇴사"는 시작~종료일이 있는 기간제 상태다(예: 장기 결석). 그 기간 동안은
// 무단외출·자리비움 판정에서 제외하고 현황판 등에 별도로 표시한다(check.js/display.js/seat.js도 동일 로직 사용).
function isOnLeave(student, dateKey) {
  const leave = student && student.leaveOfAbsence;
  if (!leave || !leave.from || !leave.to) return false;
  return dateKey >= leave.from && dateKey <= leave.to;
}

const bulkAddBtn = document.getElementById("bulkAddBtn");
const bulkFormWrap = document.getElementById("bulkFormWrap");
const bulkInput = document.getElementById("bulkInput");
const bulkPreviewEl = document.getElementById("bulkPreview");
const bulkSaveBtn = document.getElementById("bulkSaveBtn");
const cancelBulkFormBtn = document.getElementById("cancelBulkFormBtn");
let bulkPreviewRows = [];

const state = {
  allowedGrades: [],
  activeGrade: null,
  studentsByGrade: {},
  allowedClassesByGrade: {}, // { [grade]: string[] } — 비어있으면 그 학년 전체 담당
  dayFlags: [false, false, false, false, false],
  clsManuallyEdited: false,
};

// 해당 학년에 반 단위 제한이 있으면 허용된 반 목록을, 없으면(학년 전체 담당) null을 반환
function getClassRestriction(grade) {
  const classes = state.allowedClassesByGrade[grade];
  return classes && classes.length > 0 ? classes : null;
}

// 학번 형식: 앞 1자리 학년 + 다음 2자리 반 + 마지막 2자리 번호 (예: "10305" = 1학년 3반 5번)
function deriveClsFromSid(sid) {
  const match = /^(\d)(\d{2})\d{2}$/.exec(sid.trim());
  if (!match) return null;
  const [, grade, cls] = match;
  return `${grade}학년 ${Number(cls)}반`;
}

function parseBulkInput(text, classRestriction) {
  const rows = [];
  const errors = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const parts = trimmed
      .split(/\t|,/)
      .map((p) => p.trim())
      .filter((p) => p !== "");
    const [name, sid, email] = parts;
    if (!name || !sid) {
      errors.push(`${i + 1}번째 줄을 확인해 주세요: "${trimmed}"`);
      return;
    }
    const cls = deriveClsFromSid(sid) || "";
    if (classRestriction && cls && !classRestriction.includes(cls)) {
      errors.push(`${i + 1}번째 줄: "${name}"(${cls})은(는) 담당 반(${classRestriction.join(", ")})이 아닙니다.`);
      return;
    }
    rows.push({ name, sid, cls, email: email || "" });
  });
  return { rows, errors };
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// textarea 기본 동작은 Tab을 누르면 포커스가 다음 요소로 넘어가 버려서,
// 엑셀 붙여넣기가 아니라 직접 타이핑할 때는 탭 구분자를 입력할 수 없다.
// Tab(Shift 없이)을 가로채 실제 탭 문자를 커서 위치에 삽입한다.
function insertTabOnKeydown(event) {
  if (event.key !== "Tab" || event.shiftKey) return;
  event.preventDefault();
  const el = event.target;
  const start = el.selectionStart;
  const end = el.selectionEnd;
  el.value = el.value.slice(0, start) + "\t" + el.value.slice(end);
  el.selectionStart = el.selectionEnd = start + 1;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function renderDayToggle() {
  dayToggleRow.innerHTML = DAY_LABELS.map((label, i) => {
    const active = state.dayFlags[i];
    return `<button type="button" class="day-toggle${active ? " is-active" : ""}" data-day-index="${i}">${label}</button>`;
  }).join("");
}

function renderGradeTabs() {
  gradeTabsEl.innerHTML = state.allowedGrades
    .map((grade) => {
      const active = state.activeGrade === grade;
      return `<button type="button" class="filter-chip${active ? " is-active" : ""}" data-grade="${grade}">${grade}학년</button>`;
    })
    .join("");
}

function renderRoster() {
  if (!state.activeGrade) return;
  const students = state.studentsByGrade[state.activeGrade] || {};
  const classRestriction = getClassRestriction(state.activeGrade);
  let entries = Object.entries(students);
  if (classRestriction) {
    entries = entries.filter(([, s]) => classRestriction.includes(s.cls));
  }
  entries.sort((a, b) => (a[1].sid || "").localeCompare(b[1].sid || ""));

  if (entries.length === 0) {
    rosterListEl.innerHTML = `<div class="student-list__empty">등록된 학생이 없습니다.</div>`;
    return;
  }

  rosterListEl.innerHTML = entries
    .map(([id, s]) => {
      const flags = s.afterschoolDays || [false, false, false, false, false];
      const days = flags
        .map((on, i) => `<span class="day-pill${on ? " is-active" : ""}">${DAY_LABELS[i]}</span>`)
        .join("");
      const onLeave = isOnLeave(s, TODAY_KEY);
      const leave = s.leaveOfAbsence;
      const leaveBadge = onLeave
        ? `<div class="status-badge status-badge--leave">명령퇴사 중 (~${escapeHtml(leave.to)})</div>`
        : leave && leave.from && leave.to
          ? `<div class="since-text">명령퇴사 예정: ${escapeHtml(leave.from)} ~ ${escapeHtml(leave.to)}</div>`
          : "";
      return `
        <div class="student-card">
          <div class="student-avatar ${onLeave ? "student-avatar--leave" : "student-avatar--in"}">${escapeHtml((s.name || "?").charAt(0))}</div>
          <div class="student-info">
            <div class="student-name">${escapeHtml(s.name || "이름 없음")}</div>
            <div class="student-meta">학번 ${escapeHtml(s.sid || "-")} · ${escapeHtml(s.cls || "-")}</div>
            ${s.email ? `<div class="student-meta">${escapeHtml(s.email)}</div>` : ""}
          </div>
          <div class="day-pill-row">${days}</div>
          ${leaveBadge}
          <div class="roster-actions">
            <button type="button" class="btn-secondary btn-small" data-edit-id="${escapeHtml(id)}">수정</button>
            <button type="button" class="btn-danger btn-small" data-delete-id="${escapeHtml(id)}">삭제</button>
          </div>
        </div>
      `;
    })
    .join("");
}

function openFormForAdd() {
  editingIdInput.value = "";
  inputName.value = "";
  inputSid.value = "";
  inputEmail.value = "";
  inputLeaveFrom.value = "";
  inputLeaveTo.value = "";
  inputLeaveReason.value = "";
  state.dayFlags = [false, false, false, false, false];

  const classRestriction = getClassRestriction(state.activeGrade);
  if (classRestriction && classRestriction.length === 1) {
    inputCls.value = classRestriction[0];
    state.clsManuallyEdited = true; // 학번 입력으로 자동 덮어쓰기되지 않게
  } else {
    inputCls.value = "";
    state.clsManuallyEdited = false;
  }

  renderDayToggle();
  formWrap.hidden = false;
  inputName.focus();
}

function openFormForEdit(id) {
  const s = (state.studentsByGrade[state.activeGrade] || {})[id];
  if (!s) return;
  closeBulkForm();
  editingIdInput.value = id;
  inputName.value = s.name || "";
  inputSid.value = s.sid || "";
  inputCls.value = s.cls || "";
  inputEmail.value = s.email || "";
  const leave = s.leaveOfAbsence || {};
  inputLeaveFrom.value = leave.from || "";
  inputLeaveTo.value = leave.to || "";
  inputLeaveReason.value = leave.reason || "";
  state.dayFlags = (s.afterschoolDays || [false, false, false, false, false]).slice();
  // 기존 학생은 이미 반이 저장되어 있으니, 학번을 고치더라도 자동으로 덮어쓰지 않는다.
  state.clsManuallyEdited = true;
  renderDayToggle();
  formWrap.hidden = false;
  inputName.focus();
}

function closeForm() {
  formWrap.hidden = true;
}

function openBulkForm() {
  closeForm();
  bulkInput.value = "";
  bulkPreviewRows = [];
  renderBulkPreview();
  bulkFormWrap.hidden = false;
  bulkInput.focus();
}

function closeBulkForm() {
  bulkFormWrap.hidden = true;
}

function renderBulkPreview() {
  const { rows, errors } = parseBulkInput(bulkInput.value, getClassRestriction(state.activeGrade));
  bulkPreviewRows = rows;

  const parts = [];
  if (rows.length > 0) {
    parts.push(
      `<div class="bulk-preview__list">${rows
        .map(
          (r) =>
            `<div class="bulk-preview__row">${escapeHtml(r.name)} · ${escapeHtml(r.sid)} · ${escapeHtml(r.cls || "반 확인 필요")}${r.email ? ` · ${escapeHtml(r.email)}` : ""}</div>`
        )
        .join("")}</div>`
    );
  }
  if (errors.length > 0) {
    parts.push(
      `<div class="bulk-preview__errors">${errors.map((e) => `<div>${escapeHtml(e)}</div>`).join("")}</div>`
    );
  }
  bulkPreviewEl.innerHTML = parts.join("");

  bulkSaveBtn.disabled = rows.length === 0;
  bulkSaveBtn.textContent = `일괄 저장 (${rows.length}명)`;
}

addStudentBtn.addEventListener("click", () => {
  if (!state.activeGrade) return;
  closeBulkForm();
  openFormForAdd();
});

bulkAddBtn.addEventListener("click", () => {
  if (!state.activeGrade) return;
  openBulkForm();
});

cancelFormBtn.addEventListener("click", () => {
  closeForm();
});

cancelBulkFormBtn.addEventListener("click", () => {
  closeBulkForm();
});

bulkInput.addEventListener("input", renderBulkPreview);
bulkInput.addEventListener("keydown", insertTabOnKeydown);

bulkSaveBtn.addEventListener("click", () => {
  if (bulkPreviewRows.length === 0 || !state.activeGrade) return;
  const updates = {};
  for (const row of bulkPreviewRows) {
    const newKey = push(ref(db, `students/${state.activeGrade}`)).key;
    updates[`students/${state.activeGrade}/${newKey}`] = {
      name: row.name,
      sid: row.sid,
      cls: row.cls,
      email: row.email || "",
      afterschoolDays: [false, false, false, false, false],
    };
  }
  update(ref(db), updates);
  closeBulkForm();
});

inputSid.addEventListener("input", () => {
  if (state.clsManuallyEdited) return;
  const derived = deriveClsFromSid(inputSid.value);
  if (derived) inputCls.value = derived;
});

inputCls.addEventListener("input", () => {
  state.clsManuallyEdited = true;
});

dayToggleRow.addEventListener("click", (event) => {
  const btn = event.target.closest("[data-day-index]");
  if (!btn) return;
  const i = Number(btn.dataset.dayIndex);
  state.dayFlags[i] = !state.dayFlags[i];
  renderDayToggle();
});

gradeTabsEl.addEventListener("click", (event) => {
  const btn = event.target.closest("[data-grade]");
  if (!btn) return;
  state.activeGrade = btn.dataset.grade;
  closeForm();
  closeBulkForm();
  renderGradeTabs();
  renderRoster();
});

rosterListEl.addEventListener("click", (event) => {
  const editBtn = event.target.closest("[data-edit-id]");
  if (editBtn) {
    openFormForEdit(editBtn.dataset.editId);
    return;
  }
  const deleteBtn = event.target.closest("[data-delete-id]");
  if (deleteBtn) {
    const id = deleteBtn.dataset.deleteId;
    const s = (state.studentsByGrade[state.activeGrade] || {})[id];
    const name = s ? s.name : "이 학생";
    if (confirm(`${name}을(를) 명단에서 삭제할까요?`)) {
      remove(ref(db, `students/${state.activeGrade}/${id}`));
    }
  }
});

studentForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = inputName.value.trim();
  const sid = inputSid.value.trim();
  const cls = inputCls.value.trim();
  const email = inputEmail.value.trim();

  if (!name || !sid || !cls) {
    alert("이름, 학번, 반을 모두 입력해 주세요.");
    return;
  }

  const classRestriction = getClassRestriction(state.activeGrade);
  if (classRestriction && !classRestriction.includes(cls)) {
    alert(`담당 반(${classRestriction.join(", ")})의 학생만 등록·수정할 수 있습니다.`);
    return;
  }

  const leaveFrom = inputLeaveFrom.value;
  const leaveTo = inputLeaveTo.value;
  if ((leaveFrom && !leaveTo) || (!leaveFrom && leaveTo)) {
    alert("명령퇴사 기간은 시작일과 종료일을 모두 입력해 주세요.");
    return;
  }
  if (leaveFrom && leaveTo && leaveFrom > leaveTo) {
    alert("명령퇴사 종료일은 시작일보다 빠를 수 없습니다.");
    return;
  }

  const data = {
    name,
    sid,
    cls,
    email,
    afterschoolDays: state.dayFlags.slice(),
  };
  if (leaveFrom && leaveTo) {
    data.leaveOfAbsence = { from: leaveFrom, to: leaveTo, reason: inputLeaveReason.value.trim() };
  }

  const editingId = editingIdInput.value;
  if (editingId) {
    set(ref(db, `students/${state.activeGrade}/${editingId}`), data);
  } else {
    const newRef = push(ref(db, `students/${state.activeGrade}`));
    set(newRef, data);
  }
  closeForm();
});

function initForGrades(allowedGrades) {
  state.allowedGrades = allowedGrades;
  state.activeGrade = allowedGrades[0] || null;
  renderGradeTabs();

  if (!state.activeGrade) {
    rosterListEl.innerHTML = `<div class="student-list__empty">담당 학년이 없습니다. 관리자에게 문의해 주세요.</div>`;
    addStudentBtn.disabled = true;
    bulkAddBtn.disabled = true;
    return;
  }

  addStudentBtn.disabled = false;
  bulkAddBtn.disabled = false;

  for (const grade of allowedGrades) {
    onValue(ref(db, `students/${grade}`), (snapshot) => {
      state.studentsByGrade[grade] = snapshot.val() || {};
      if (grade === state.activeGrade) {
        renderRoster();
      }
    });
  }
}

onAuthStateChanged(auth, (user) => {
  if (!user) {
    window.location.replace("./login.html");
    return;
  }

  onValue(
    ref(db, `users/${user.uid}`),
    (snapshot) => {
      const profile = snapshot.val() || {};
      if (profile.disabled) {
        signOut(auth).then(() => window.location.replace("./login.html?disabled=1"));
        return;
      }
      const role = profile.role;
      const loginId = (user.email || "").replace(`@${FAKE_EMAIL_DOMAIN}`, "");

      function showCurrentUser() {
        currentUserNameEl.textContent = profile.name || loginId;
        currentUserRoleBadgeEl.textContent = role;
        currentUserRoleBadgeEl.className = `role-badge role-badge--${role}`;
      }

      if (role === "admin") {
        showCurrentUser();
        initForGrades(ALL_GRADES);
      } else if (role === "gradeManager") {
        showCurrentUser();
        const managed = profile.managedGrades || {};
        const allowed = ALL_GRADES.filter((g) => managed[g]);
        initForGrades(allowed);
      } else if (role === "teacher") {
        // teacher는 담임을 맡은 반(managedClasses)이 있을 때만 그 반의 명단을 관리할 수 있다.
        const managedClasses = profile.managedClasses || {};
        const allowedGradesForTeacher = Object.keys(managedClasses).filter(
          (g) => Object.keys(managedClasses[g] || {}).length > 0
        );
        if (allowedGradesForTeacher.length === 0) {
          window.location.replace("./check.html");
          return;
        }
        showCurrentUser();
        state.allowedClassesByGrade = {};
        for (const g of allowedGradesForTeacher) {
          state.allowedClassesByGrade[g] = Object.keys(managedClasses[g]);
        }
        initForGrades(allowedGradesForTeacher.sort());
      } else {
        window.location.replace("./check.html");
      }
    },
    { onlyOnce: true }
  );
});

logoutBtn.addEventListener("click", () => {
  signOut(auth).then(() => window.location.replace("./login.html"));
});

renderDayToggle();

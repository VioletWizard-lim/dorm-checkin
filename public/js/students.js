import { auth, db } from "./firebase-init.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  ref,
  onValue,
  push,
  set,
  remove,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";

const ALL_GRADES = ["1", "2", "3"];
const DAY_LABELS = ["월", "화", "수", "목", "금"];

const gradeTabsEl = document.getElementById("gradeTabs");
const rosterListEl = document.getElementById("rosterList");
const addStudentBtn = document.getElementById("addStudentBtn");
const formWrap = document.getElementById("formWrap");
const studentForm = document.getElementById("studentForm");
const editingIdInput = document.getElementById("editingId");
const inputName = document.getElementById("inputName");
const inputSid = document.getElementById("inputSid");
const inputCls = document.getElementById("inputCls");
const dayToggleRow = document.getElementById("dayToggleRow");
const cancelFormBtn = document.getElementById("cancelFormBtn");

const state = {
  allowedGrades: [],
  activeGrade: null,
  studentsByGrade: {},
  dayFlags: [false, false, false, false, false],
};

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
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
  const entries = Object.entries(students).sort((a, b) =>
    (a[1].sid || "").localeCompare(b[1].sid || "")
  );

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
      return `
        <div class="student-card">
          <div class="student-avatar student-avatar--in">${escapeHtml((s.name || "?").charAt(0))}</div>
          <div class="student-info">
            <div class="student-name">${escapeHtml(s.name || "이름 없음")}</div>
            <div class="student-meta">학번 ${escapeHtml(s.sid || "-")} · ${escapeHtml(s.cls || "-")}</div>
          </div>
          <div class="day-pill-row">${days}</div>
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
  inputCls.value = "";
  state.dayFlags = [false, false, false, false, false];
  renderDayToggle();
  formWrap.hidden = false;
  inputName.focus();
}

function openFormForEdit(id) {
  const s = (state.studentsByGrade[state.activeGrade] || {})[id];
  if (!s) return;
  editingIdInput.value = id;
  inputName.value = s.name || "";
  inputSid.value = s.sid || "";
  inputCls.value = s.cls || "";
  state.dayFlags = (s.afterschoolDays || [false, false, false, false, false]).slice();
  renderDayToggle();
  formWrap.hidden = false;
  inputName.focus();
}

function closeForm() {
  formWrap.hidden = true;
}

addStudentBtn.addEventListener("click", () => {
  if (!state.activeGrade) return;
  openFormForAdd();
});

cancelFormBtn.addEventListener("click", () => {
  closeForm();
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

  if (!name || !sid || !cls) {
    alert("이름, 학번, 반을 모두 입력해 주세요.");
    return;
  }

  const data = {
    name,
    sid,
    cls,
    afterschoolDays: state.dayFlags.slice(),
  };

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
    return;
  }

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
      const role = profile.role;

      if (role === "admin") {
        initForGrades(ALL_GRADES);
      } else if (role === "gradeManager") {
        const managed = profile.managedGrades || {};
        const allowed = ALL_GRADES.filter((g) => managed[g]);
        initForGrades(allowed);
      } else {
        window.location.replace("./check.html");
      }
    },
    { onlyOnce: true }
  );
});

renderDayToggle();

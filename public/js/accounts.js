import { supabase, requireStaff, signOutTo, describeError, callFunction, reportLoadError } from "./supabase-client.js";
import { escapeHtml, insertTabOnKeydown } from "./util.js";
import { liveTable } from "./live-table.js";
import { GRADES, groupStudentsByGrade, managedClassesToRows, roomsById, userFromProfile } from "./adapters.js";

const ROLES = ["teacher", "gradeManager", "admin", "studyHallSupervisor", "dormStaff", "afterschoolTeacher"];
// 서버(staff-accounts 함수)와 같은 규칙: 영문·숫자 32자 이하, 소문자로 저장
const ID_PATTERN = /^[A-Za-z0-9]{1,32}$/;
const PASSWORD_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
const MAX_ACCOUNTS_PER_REQUEST = 200;

const logoutBtn = document.getElementById("logoutBtn");
const currentUserNameEl = document.getElementById("currentUserName");
const currentUserRoleBadgeEl = document.getElementById("currentUserRoleBadge");
const accountListEl = document.getElementById("accountList");
const bulkInput = document.getElementById("bulkAccountInput");
const bulkPreviewEl = document.getElementById("bulkAccountPreview");
const bulkCreateBtn = document.getElementById("bulkCreateBtn");
const resultWrap = document.getElementById("resultWrap");
const resultListEl = document.getElementById("resultList");
const resultCopyEl = document.getElementById("resultCopy");
const bulkResetBtn = document.getElementById("bulkResetBtn");
const accountFilterEl = document.getElementById("accountFilter");

// 계정 목록 분류(사용자 요청: 역할별로 나눠 보기). 담임과 담당 반 없는 일반 교사는 나눠서 보여 준다
const ACCOUNT_GROUPS = [
  { key: "admin", label: "관리자" },
  { key: "gradeManager", label: "학년부장" },
  { key: "homeroom", label: "담임" },
  { key: "teacher", label: "일반 교사 (담당 반 없음)" },
  { key: "studyHallSupervisor", label: "자습 감독" },
  { key: "dormStaff", label: "기숙사부" },
  { key: "afterschoolTeacher", label: "방과후 선생님" },
  { key: "disabled", label: "삭제됨" },
];

function accountGroupOf(u) {
  if (u.disabled) return "disabled";
  const role = u.role || "teacher";
  if (role !== "teacher") return role;
  const classes = u.managedClasses || {};
  return Object.values(classes).some((c) => Object.keys(c || {}).length > 0) ? "homeroom" : "teacher";
}

const state = {
  users: {},
  rooms: {},
  studentsByGrade: { "1": {}, "2": {}, "3": {} },
  currentUid: "",
  editingUid: null,
  editName: "",
  editRole: "teacher",
  editGrades: [],
  editRooms: [],
  editClasses: {}, // { [grade]: string[] } — 비어있으면 그 학년 전체 담당
  accountFilter: "all", // 분류 탭: "all" 또는 ACCOUNT_GROUPS의 key
  // 이 화면에서 만든 계정·재발급한 비밀번호(다시 조회할 수 없어서 새로고침 전까지만 보여줌)
  passwordResults: [],
};
let profilesLive = null;

function getClassesInGrade(grade) {
  const set = new Set();
  for (const student of Object.values(state.studentsByGrade[grade] || {})) {
    if (student && student.cls) set.add(student.cls);
  }
  return Array.from(set).sort();
}
let bulkPreviewRows = [];

function generatePassword() {
  const values = crypto.getRandomValues(new Uint32Array(8));
  return Array.from(values, (n) => PASSWORD_CHARS[n % PASSWORD_CHARS.length]).join("");
}

// 일괄 생성에서 쓰는 역할 이름(사용자 요청: 한글 이름으로 입력). 띄어쓰기·대소문자는 무시한다.
// 관리자는 일괄 생성으로 만들지 않는다(실수로 여러 명이 생기지 않게 — 만든 뒤 "정보 수정"에서 한 명씩)
const BULK_ROLE_NAMES = {
  교사: "teacher",
  일반교사: "teacher",
  담임: "teacher",
  teacher: "teacher",
  학년관리자: "gradeManager",
  학년부장: "gradeManager",
  grademanager: "gradeManager",
  자습감독: "studyHallSupervisor",
  studyhallsupervisor: "studyHallSupervisor",
  기숙사관리자: "dormStaff",
  기숙사부: "dormStaff",
  dormstaff: "dormStaff",
  방과후선생님: "afterschoolTeacher",
  방과후교사: "afterschoolTeacher",
  방과후: "afterschoolTeacher",
  afterschoolteacher: "afterschoolTeacher",
};
const ADMIN_ROLE_NAMES = new Set(["관리자", "admin"]);
const ROLE_LABELS = {
  teacher: "교사",
  gradeManager: "학년관리자",
  studyHallSupervisor: "자습감독",
  dormStaff: "기숙사관리자",
  afterschoolTeacher: "방과후선생님",
};

function roleKeyOf(text) {
  return (text || "").replace(/\s+/g, "").toLowerCase();
}

function parseBulkInput(text) {
  const rows = [];
  const errors = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const parts = trimmed
      .split(/\t|,/)
      .map((p) => p.trim())
      .filter((p) => p !== "");
    const [rawUserId, name, ...rest] = parts;
    // 세 번째 칸이 역할 이름이면 역할(그다음이 비밀번호), 아니면 예전처럼 비밀번호
    let role = "teacher";
    if (rest.length > 0 && ADMIN_ROLE_NAMES.has(roleKeyOf(rest[0]))) {
      errors.push(`${i + 1}번째 줄: 관리자는 일괄 생성으로 만들 수 없습니다. 만든 뒤 "정보 수정"에서 바꿔 주세요 ("${trimmed}")`);
      return;
    }
    if (rest.length > 0 && BULK_ROLE_NAMES[roleKeyOf(rest[0])]) role = BULK_ROLE_NAMES[roleKeyOf(rest.shift())];
    const passwordRaw = rest[0];

    if (!rawUserId || !ID_PATTERN.test(rawUserId)) {
      errors.push(`${i + 1}번째 줄: 아이디는 영문/숫자 32자 이하만 사용할 수 있습니다 ("${trimmed}")`);
      return;
    }
    // 로그인 아이디는 대소문자를 구분하지 않고 소문자로 저장된다.
    const userId = rawUserId.toLowerCase();
    if (!name) {
      errors.push(`${i + 1}번째 줄: 이름을 입력해 주세요 ("${trimmed}")`);
      return;
    }
    if (passwordRaw && passwordRaw.length < 6) {
      errors.push(`${i + 1}번째 줄: 비밀번호는 6자 이상이어야 합니다 ("${trimmed}")`);
      return;
    }
    rows.push({ userId, name, role, password: passwordRaw || generatePassword(), autoGenerated: !passwordRaw });
  });
  return { rows, errors };
}

function renderBulkPreview() {
  const { rows, errors } = parseBulkInput(bulkInput.value);
  bulkPreviewRows = rows;

  const parts = [];
  if (rows.length > 0) {
    parts.push(
      `<div class="bulk-preview__list">${rows
        .map(
          (r) =>
            `<div class="bulk-preview__row">${escapeHtml(r.userId)} · ${escapeHtml(r.name)} · ${ROLE_LABELS[r.role]} · 비밀번호 ${escapeHtml(r.password)}${r.autoGenerated ? " (자동 생성)" : ""}</div>`
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

  bulkCreateBtn.disabled = rows.length === 0;
  bulkCreateBtn.textContent = `계정 생성 (${rows.length}명)`;
}

// 계정 생성은 Edge Function(staff-accounts)이 한다 — 브라우저에서는 다른 사람 계정을 만들 수 없음.
// 비밀번호는 미리보기에 보여준 값을 그대로 보내서, 화면에 보인 비밀번호와 실제 비밀번호가 항상 같다.
async function runBulkCreate() {
  if (bulkPreviewRows.length === 0) return;
  const rows = bulkPreviewRows;
  bulkCreateBtn.disabled = true;
  bulkCreateBtn.textContent = "생성 중...";

  const results = [];
  for (let start = 0; start < rows.length; start += MAX_ACCOUNTS_PER_REQUEST) {
    const chunk = rows.slice(start, start + MAX_ACCOUNTS_PER_REQUEST);
    let chunkResults = null;
    let failure = "";
    try {
      const data = await callFunction("staff-accounts", {
        action: "create",
        accounts: chunk.map((r) => ({ loginId: r.userId, name: r.name, role: r.role, password: r.password })),
      });
      chunkResults = Array.isArray(data && data.results) ? data.results : null;
      if (!chunkResults) failure = "서버 응답을 확인하지 못했습니다.";
    } catch (err) {
      failure = err.message;
    }
    chunk.forEach((row, i) => {
      const res = chunkResults ? chunkResults[i] : null;
      results.push({
        kind: "create",
        userId: row.userId,
        name: row.name,
        password: row.password,
        ok: !!(res && res.ok),
        errorText: res && !res.ok ? res.error : failure || "계정을 만들지 못했습니다.",
      });
    });
  }

  addPasswordResults(results);
  bulkInput.value = "";
  renderBulkPreview();
  if (profilesLive) await profilesLive.refresh();
}

function addPasswordResults(results) {
  state.passwordResults = [...results, ...state.passwordResults];
  renderResults();
}

// 생성·재발급 결과. 성공한 것만 "아이디[탭]이름[탭]비밀번호" 줄로 모아 엑셀에 붙여넣기 쉽게 보여준다.
function renderResults() {
  const results = state.passwordResults;
  resultWrap.hidden = results.length === 0;
  resultListEl.innerHTML = results
    .map(
      (r) => `
        <div class="student-card">
          <div class="student-info">
            <div class="student-name">${escapeHtml(r.userId)}</div>
            <div class="student-meta">${escapeHtml(r.name || "이름 미등록")}</div>
          </div>
          ${
            r.ok
              ? `<div class="status-badge status-badge--in">${r.kind === "reset" ? "재발급됨" : "생성됨"}</div><div class="since-text">비밀번호: ${escapeHtml(r.password)}</div>`
              : `<div class="status-badge status-badge--out">실패</div><div class="since-text">${escapeHtml(r.errorText)}</div>`
          }
        </div>
      `
    )
    .join("");
  resultCopyEl.value = results
    .filter((r) => r.ok)
    .map((r) => [r.userId, r.name || "", r.password].join("\t"))
    .join("\n");
}

function renderAccountFilter(groups) {
  const total = Object.keys(state.users).length;
  const chip = (key, label, count) =>
    `<button type="button" class="filter-chip${state.accountFilter === key ? " is-active" : ""}" data-account-filter="${key}">${label} ${count}</button>`;
  accountFilterEl.innerHTML = [
    chip("all", "전체", total),
    ...ACCOUNT_GROUPS.filter((g) => groups.get(g.key).length > 0).map((g) => chip(g.key, g.label, groups.get(g.key).length)),
  ].join("");
}

function renderAccountList() {
  const entries = Object.entries(state.users);
  entries.sort((a, b) => (a[1].id || a[0]).localeCompare(b[1].id || b[0]));
  const groups = new Map(ACCOUNT_GROUPS.map((g) => [g.key, []]));
  for (const entry of entries) groups.get(accountGroupOf(entry[1])).push(entry);
  // 고른 분류에 계정이 없어지면(역할을 바꾼 뒤 등) 전체로
  if (state.accountFilter !== "all" && !(groups.get(state.accountFilter) || []).length) state.accountFilter = "all";
  renderAccountFilter(groups);

  if (entries.length === 0) {
    accountListEl.innerHTML = `<div class="student-list__empty">등록된 계정이 없습니다.</div>`;
    return;
  }
  const renderEntry = ([uid, u]) => (state.editingUid === uid ? renderEditRow(uid, u) : renderAccountRow(uid, u));
  accountListEl.innerHTML = ACCOUNT_GROUPS.filter((g) => state.accountFilter === "all" || state.accountFilter === g.key)
    .filter((g) => groups.get(g.key).length > 0)
    .map(
      (g) =>
        `<div class="account-group__title">${g.label} (${groups.get(g.key).length}명)</div>` +
        groups.get(g.key).map(renderEntry).join("")
    )
    .join("");
}

accountFilterEl.addEventListener("click", (event) => {
  const btn = event.target.closest("[data-account-filter]");
  if (!btn) return;
  state.accountFilter = btn.dataset.accountFilter;
  renderAccountList();
});

function renderAccountRow(uid, u) {
  const isSelf = uid === state.currentUid;

  if (u.disabled) {
    return `
      <div class="student-card student-card--disabled">
        <div class="student-info">
          <div class="student-name">${escapeHtml(u.id || uid)}</div>
          <div class="student-meta">${escapeHtml(u.name || "이름 미등록")}</div>
        </div>
        <div class="role-badge role-badge--disabled">삭제됨</div>
      </div>
    `;
  }

  const role = u.role || "teacher";

  let assignments = "";
  if (role === "gradeManager") {
    const gradeText =
      Object.keys(u.managedGrades || {})
        .sort()
        .map((g) => `${g}학년`)
        .join(", ") || "담당 학년 없음";
    const roomText =
      Object.entries(state.rooms)
        .filter(([rid]) => (u.managedRooms || {})[rid])
        .map(([, r]) => r.name || "이름 없음")
        .join(", ") || "담당 실 없음";
    assignments = `${gradeText} · ${roomText}`;
  } else if (role === "teacher") {
    const managedClasses = u.managedClasses || {};
    const classText = Object.keys(managedClasses)
      .sort()
      .flatMap((g) => Object.keys(managedClasses[g] || {}))
      .join(", ");
    if (classText) assignments = `담당 반: ${classText}`;
  }

  return `
    <div class="student-card">
      <div class="student-info">
        <div class="student-name">${escapeHtml(u.id || uid)}</div>
        <div class="student-meta">${escapeHtml(u.name || "이름 미등록")}</div>
      </div>
      <div class="role-badge role-badge--${role}">${role}</div>
      ${assignments ? `<div class="since-text">${escapeHtml(assignments)}</div>` : ""}
      ${
        isSelf
          ? `<div class="since-text ml-auto">본인 계정</div>`
          : `<div class="roster-actions">
               <button type="button" class="btn-secondary btn-small" data-edit-role="${escapeHtml(uid)}">정보 수정</button>
               <button type="button" class="btn-secondary btn-small" data-reset-password="${escapeHtml(uid)}">비밀번호 재발급</button>
               <button type="button" class="btn-danger btn-small" data-delete-account="${escapeHtml(uid)}">삭제</button>
             </div>`
      }
    </div>
  `;
}

function renderEditRow(uid, u) {
  const roleToggleHtml = ROLES.map(
    (r) =>
      `<button type="button" class="grade-toggle${state.editRole === r ? " is-active" : ""}" data-edit-set-role="${r}">${r}</button>`
  ).join("");

  let extraFieldsHtml = "";
  if (state.editRole === "gradeManager") {
    const gradesHtml = GRADES.map((g) => {
      const active = state.editGrades.includes(g);
      return `<button type="button" class="grade-toggle${active ? " is-active" : ""}" data-edit-grade="${g}">${g}학년</button>`;
    }).join("");

    const roomEntries = Object.entries(state.rooms);
    const roomsHtml =
      roomEntries.length > 0
        ? roomEntries
            .map(([rid, r]) => {
              const active = state.editRooms.includes(rid);
              return `<button type="button" class="grade-toggle${active ? " is-active" : ""}" data-edit-room="${escapeHtml(rid)}">${escapeHtml(r.name || "이름 없음")}</button>`;
            })
            .join("")
        : `<span class="field-hint">등록된 실이 없습니다.</span>`;

    extraFieldsHtml = `
      <div class="field-hint">담당 학년 (학년 전체)</div>
      <div class="grade-toggle-row">${gradesHtml}</div>
      <div class="field-hint">담당 실</div>
      <div class="grade-toggle-row">${roomsHtml}</div>
    `;
  } else if (state.editRole === "teacher") {
    const classSectionsHtml = GRADES.map((g) => {
      const classesInGrade = getClassesInGrade(g);
      const selected = state.editClasses[g] || [];
      const classesHtml =
        classesInGrade.length > 0
          ? classesInGrade
              .map((c) => {
                const active = selected.includes(c);
                return `<button type="button" class="grade-toggle${active ? " is-active" : ""}" data-edit-class="${g}" data-edit-class-value="${escapeHtml(c)}">${escapeHtml(c)}</button>`;
              })
              .join("")
          : `<span class="field-hint">등록된 학생이 없습니다.</span>`;
      return `
        <div class="field-hint">${g}학년</div>
        <div class="grade-toggle-row">${classesHtml}</div>
      `;
    }).join("");

    extraFieldsHtml = `
      <div class="field-hint">담당 반 (선택 — 담임을 맡은 반이 있으면 골라주세요)</div>
      ${classSectionsHtml}
    `;
  }

  return `
    <div class="student-card account-edit-card">
      <div class="student-info">
        <div class="student-name">${escapeHtml(u.id || uid)}</div>
      </div>
      <div class="account-edit-fields">
        <div class="field">
          <label>이름</label>
          <input type="text" data-edit-name value="${escapeHtml(state.editName)}" placeholder="이름 입력" autocomplete="off">
        </div>
        <div class="field-hint">역할</div>
        <div class="grade-toggle-row">${roleToggleHtml}</div>
        ${extraFieldsHtml}
      </div>
      <div class="roster-actions">
        <button type="button" class="btn-secondary btn-small" data-cancel-edit-role>취소</button>
        <button type="button" class="btn-add btn-small" data-save-role="${escapeHtml(uid)}">저장</button>
      </div>
    </div>
  `;
}

bulkInput.addEventListener("input", renderBulkPreview);
bulkInput.addEventListener("keydown", insertTabOnKeydown);
bulkCreateBtn.addEventListener("click", runBulkCreate);
bulkResetBtn.addEventListener("click", resetAllPasswords);

accountListEl.addEventListener("click", (event) => {
  const deleteBtn = event.target.closest("[data-delete-account]");
  if (deleteBtn) {
    deleteAccount(deleteBtn.dataset.deleteAccount, deleteBtn);
    return;
  }

  const resetBtn = event.target.closest("[data-reset-password]");
  if (resetBtn) {
    resetPassword(resetBtn.dataset.resetPassword, resetBtn);
    return;
  }

  const editBtn = event.target.closest("[data-edit-role]");
  if (editBtn) {
    const uid = editBtn.dataset.editRole;
    const u = state.users[uid] || {};
    const managedClasses = u.managedClasses || {};
    state.editingUid = uid;
    state.editName = u.name || "";
    state.editRole = u.role || "teacher";
    state.editGrades = Object.keys(u.managedGrades || {});
    state.editRooms = Object.keys(u.managedRooms || {});
    state.editClasses = {};
    for (const g of Object.keys(managedClasses)) {
      state.editClasses[g] = Object.keys(managedClasses[g] || {});
    }
    renderAccountList();
    return;
  }

  const cancelBtn = event.target.closest("[data-cancel-edit-role]");
  if (cancelBtn) {
    state.editingUid = null;
    renderAccountList();
    return;
  }

  const setRoleBtn = event.target.closest("[data-edit-set-role]");
  if (setRoleBtn) {
    state.editRole = setRoleBtn.dataset.editSetRole;
    renderAccountList();
    return;
  }

  const gradeBtn = event.target.closest("[data-edit-grade]");
  if (gradeBtn) {
    const g = gradeBtn.dataset.editGrade;
    state.editGrades = state.editGrades.includes(g)
      ? state.editGrades.filter((x) => x !== g)
      : [...state.editGrades, g];
    renderAccountList();
    return;
  }

  const classBtn = event.target.closest("[data-edit-class]");
  if (classBtn) {
    const g = classBtn.dataset.editClass;
    const c = classBtn.dataset.editClassValue;
    const current = state.editClasses[g] || [];
    state.editClasses[g] = current.includes(c) ? current.filter((x) => x !== c) : [...current, c];
    renderAccountList();
    return;
  }

  const roomBtn = event.target.closest("[data-edit-room]");
  if (roomBtn) {
    const rid = roomBtn.dataset.editRoom;
    state.editRooms = state.editRooms.includes(rid)
      ? state.editRooms.filter((x) => x !== rid)
      : [...state.editRooms, rid];
    renderAccountList();
    return;
  }

  const saveBtn = event.target.closest("[data-save-role]");
  if (saveBtn) {
    saveRole(saveBtn.dataset.saveRole, saveBtn);
  }
});

accountListEl.addEventListener("input", (event) => {
  const nameInput = event.target.closest("[data-edit-name]");
  if (nameInput) {
    state.editName = nameInput.value;
  }
});

async function saveRole(uid, saveBtn) {
  // 역할을 바꾸면 그 역할에서 쓰지 않는 담당 범위는 비운다(예전 users/{uid}를 통째로 덮어쓰던 것과 같은 결과).
  const patch = {
    name: state.editName.trim() || null,
    role: state.editRole,
    managed_grades: state.editRole === "gradeManager" ? state.editGrades.map(Number).sort() : [],
    managed_rooms: state.editRole === "gradeManager" ? state.editRooms.slice() : [],
    managed_classes: state.editRole === "teacher" ? managedClassesToRows(state.editClasses) : [],
  };

  saveBtn.disabled = true;
  saveBtn.textContent = "저장 중...";
  const { data, error } = await supabase.from("profiles").update(patch).eq("id", uid).select("id");
  // 권한 밖의 행은 서버(RLS)가 조용히 건너뛰므로 실제로 바뀐 행이 있는지 확인한다.
  const failure = error ? describeError(error) : data.length === 0 ? "권한이 없거나 계정을 찾을 수 없습니다." : "";
  if (failure) {
    alert(`저장에 실패했습니다: ${failure}`);
    saveBtn.disabled = false;
    saveBtn.textContent = "저장";
    return;
  }
  // 다시 읽은 값으로 목록을 그려야 잠깐이라도 예전 역할이 보이지 않는다.
  if (profilesLive) await profilesLive.refresh();
  state.editingUid = null;
  renderAccountList();
}

function accountLabel(uid) {
  const u = state.users[uid] || {};
  return u.name ? `${u.id || uid} (${u.name})` : u.id || uid;
}

async function deleteAccount(uid, btn) {
  const confirmed = window.confirm(
    `${accountLabel(uid)} 계정을 삭제할까요?\n\n` +
      "이 계정으로는 더 이상 로그인할 수 없게 됩니다(이미 열려 있는 화면도 데이터를 읽지 못함).\n" +
      "목록에는 \"삭제됨\"으로 남아 처리 이력을 확인할 수 있습니다."
  );
  if (!confirmed) return;

  btn.disabled = true;
  btn.textContent = "삭제 중...";
  try {
    await callFunction("staff-accounts", { action: "disable", userId: uid });
    if (profilesLive) await profilesLive.refresh();
  } catch (err) {
    alert(`삭제에 실패했습니다: ${err.message}`);
    btn.disabled = false;
    btn.textContent = "삭제";
  }
}

// password를 주면 그 값으로, 없으면 서버가 자동으로 만든다.
async function requestNewPassword(uid, password) {
  const u = state.users[uid] || {};
  try {
    const data = await callFunction("staff-accounts", { action: "reset-password", userId: uid, ...(password ? { password } : {}) });
    if (!data || typeof data.password !== "string") throw new Error("서버 응답을 확인하지 못했습니다.");
    return { kind: "reset", userId: u.id || uid, name: u.name, password: data.password, ok: true };
  } catch (err) {
    return { kind: "reset", userId: u.id || uid, name: u.name, ok: false, errorText: err.message };
  }
}

async function resetPassword(uid, btn) {
  const answer = window.prompt(
    `${accountLabel(uid)} 계정의 새 비밀번호를 입력해 주세요(6자 이상).\n비워 두고 확인을 누르면 자동으로 만듭니다.\n\n지금 쓰는 비밀번호로는 더 이상 로그인할 수 없게 됩니다.`,
    ""
  );
  if (answer === null) return;
  const password = answer.trim();
  if (password && password.length < 6) {
    alert("비밀번호는 6자 이상이어야 합니다.");
    return;
  }
  btn.disabled = true;
  btn.textContent = "발급 중...";
  const result = await requestNewPassword(uid, password);
  btn.disabled = false;
  btn.textContent = "비밀번호 재발급";
  addPasswordResults([result]);
  resultWrap.scrollIntoView({ behavior: "smooth", block: "start" });
}

// 본인을 제외한 모든(삭제되지 않은) 계정의 비밀번호를 한 번에 새로 발급한다 — Supabase로 옮긴 직후처럼
// 모든 교사에게 새 비밀번호를 나눠줘야 할 때 쓴다.
function getResettableUids() {
  return Object.entries(state.users)
    .filter(([uid, u]) => uid !== state.currentUid && !u.disabled)
    .sort((a, b) => (a[1].id || a[0]).localeCompare(b[1].id || b[0]))
    .map(([uid]) => uid);
}

let bulkResetting = false;

function renderBulkResetButton() {
  if (bulkResetting) return; // 진행 중 표시를 목록 갱신이 덮어쓰지 않게
  const count = getResettableUids().length;
  bulkResetBtn.disabled = count === 0;
  bulkResetBtn.textContent = `비밀번호 일괄 재발급 (${count}명)`;
}

async function resetAllPasswords() {
  const uids = getResettableUids();
  if (uids.length === 0) return;
  const confirmed = window.confirm(
    `본인을 제외한 ${uids.length}명의 비밀번호를 모두 새로 발급할까요?\n\n` +
      "지금 쓰는 비밀번호로는 더 이상 로그인할 수 없게 됩니다. 새 비밀번호는 아래 결과 목록에서 복사해 전달해 주세요."
  );
  if (!confirmed) return;
  bulkResetting = true;
  bulkResetBtn.disabled = true;
  const results = [];
  for (const [i, uid] of uids.entries()) {
    bulkResetBtn.textContent = `발급 중... (${i + 1}/${uids.length})`;
    results.push(await requestNewPassword(uid));
  }
  bulkResetting = false;
  addPasswordResults(results);
  renderBulkResetButton();
  resultWrap.scrollIntoView({ behavior: "smooth", block: "start" });
}

logoutBtn.addEventListener("click", () => signOutTo());

function initAccountsPage() {
  // 학생 계정(3단계에서 추가)은 이 목록에 넣지 않는다 — 교직원만.
  profilesLive = liveTable({
    table: "profiles",
    order: ["id"],
    eq: { kind: "staff" },
    onRows: (rows) => {
      state.users = Object.fromEntries(rows.map((row) => [row.id, userFromProfile(row)]));
      renderAccountList();
      renderBulkResetButton();
    },
    onError: reportLoadError,
  });

  liveTable({
    table: "rooms",
    order: ["created_at", "id"],
    onRows: (rows) => {
      state.rooms = roomsById(rows);
      renderAccountList();
    },
    onError: reportLoadError,
  });

  liveTable({
    table: "students",
    order: ["id"],
    select: "id,grade,cls",
    onRows: (rows) => {
      state.studentsByGrade = groupStudentsByGrade(rows);
      if (state.editingUid) renderAccountList();
    },
    onError: reportLoadError,
  });
}

async function init() {
  const session = await requireStaff();
  if (!session) return;
  const { uid, loginId, profile } = session;
  if (profile.role !== "admin") {
    window.location.replace("./check.html");
    return;
  }
  state.currentUid = uid;
  currentUserNameEl.textContent = profile.name || loginId;
  currentUserRoleBadgeEl.textContent = "admin";
  currentUserRoleBadgeEl.className = "role-badge role-badge--admin";
  initAccountsPage();
}

renderBulkPreview();
renderBulkResetButton();
init();

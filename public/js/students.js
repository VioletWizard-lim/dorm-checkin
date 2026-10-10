import { supabase, requireStaff, signOutTo, describeError, callFunction, reportLoadError } from "./supabase-client.js";
import { getDateKey, isOnLeave, escapeHtml, insertTabOnKeydown, outingBanOn, outingBanText } from "./util.js";
import { liveTable } from "./live-table.js";
import {
  GRADES as ALL_GRADES,
  formatPhone,
  groupStudentsByGrade,
  normalizeLoginId,
  normalizePhone,
  studentToRow,
  STUDENT_COLUMNS,
} from "./adapters.js";
import { addContacts, addLeaveReasons, allOf } from "./private-fields.js";

// 학생 계정 발급 요청 한 번에 보낼 최대 인원(student-accounts 함수 제한)
const MAX_ACCOUNTS_PER_REQUEST = 200;

const DAY_LABELS = ["월", "화", "수", "목", "금"];

const logoutBtn = document.getElementById("logoutBtn");
const currentUserNameEl = document.getElementById("currentUserName");
const currentUserRoleBadgeEl = document.getElementById("currentUserRoleBadge");
const accountsLink = document.getElementById("accountsLink");
const afterschoolLink = document.getElementById("afterschoolLink");
const historyLink = document.getElementById("historyLink");
const navLoadingHint = document.getElementById("navLoadingHint");
const gradeTabsEl = document.getElementById("gradeTabs");
const rosterListEl = document.getElementById("rosterList");
const addStudentBtn = document.getElementById("addStudentBtn");
const formWrap = document.getElementById("formWrap");
const studentInfoFields = document.getElementById("studentInfoFields");
const leaveOnlyTitle = document.getElementById("leaveOnlyTitle");
const leaveFields = document.getElementById("leaveFields");
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
const banFields = document.getElementById("banFields");
const inputBanFrom = document.getElementById("inputBanFrom");
const inputBanTo = document.getElementById("inputBanTo");
const inputBanReason = document.getElementById("inputBanReason");
const cancelFormBtn = document.getElementById("cancelFormBtn");
const submitFormBtn = document.getElementById("submitFormBtn");
const inputLoginId = document.getElementById("inputLoginId");
const loginIdHint = document.getElementById("loginIdHint");
const inputPhone = document.getElementById("inputPhone");
const inputParentPhone = document.getElementById("inputParentPhone");
const bulkIssueBtn = document.getElementById("bulkIssueBtn");
const accountResultWrap = document.getElementById("accountResultWrap");
const accountResultList = document.getElementById("accountResultList");
const accountResultCopy = document.getElementById("accountResultCopy");
const accountResultDownloadBtn = document.getElementById("accountResultDownloadBtn");
const issueOnSaveLabel = document.getElementById("issueOnSaveLabel");
const issueOnSaveCheck = document.getElementById("issueOnSaveCheck");
const issueOnBulkLabel = document.getElementById("issueOnBulkLabel");
const issueOnBulkCheck = document.getElementById("issueOnBulkCheck");
const classDeleteBtn = document.getElementById("classDeleteBtn");
const classDeleteWrap = document.getElementById("classDeleteWrap");
const classDeleteChips = document.getElementById("classDeleteChips");
const classDeleteSaveBtn = document.getElementById("classDeleteSaveBtn");
const cancelClassDeleteBtn = document.getElementById("cancelClassDeleteBtn");

const TODAY_KEY = getDateKey();

const bulkAddBtn = document.getElementById("bulkAddBtn");
const bulkFormWrap = document.getElementById("bulkFormWrap");
const bulkInput = document.getElementById("bulkInput");
const bulkPreviewEl = document.getElementById("bulkPreview");
const bulkSaveBtn = document.getElementById("bulkSaveBtn");
const cancelBulkFormBtn = document.getElementById("cancelBulkFormBtn");
let bulkPreviewRows = [];
let studentsLive = null;
let accountsLive = null;

// 이 화면이 있는 경로(GitHub Pages면 "/dorm-checkin/"). 학생 비밀번호 문자의 접속 주소에 쓴다
const APP_PATH = new URL(".", window.location.href).pathname;

const state = {
  allowedGrades: [],
  activeGrade: null,
  studentsByGrade: {},
  allowedClassesByGrade: {}, // { [grade]: string[] } — 비어있으면 그 학년 전체 담당
  dayFlags: [false, false, false, false, false],
  clsManuallyEdited: false,
  accounts: {}, // { [studentId]: { loginId } } — 학생 계정(profiles, kind = 'student')
  accountsLoaded: false,
  accountResults: [], // 이 화면에서 발급·재발급한 비밀번호(새로고침 전까지만 보여줌)
  // 기숙사부(dormStaff): 명단은 모두 보지만 바꿀 수 있는 건 명령퇴사 기간뿐(서버 트리거도 막음).
  // 학생 추가·삭제·다른 정보 수정·학생 계정 발급/재발급/삭제는 할 수 없다.
  leaveOnly: false,
  // 명령퇴사 기간은 관리자·기숙사부만(담임·학년부장은 칸이 안 보임 — 서버 트리거도 막음)
  canEditLeave: false,
  canEditBan: false, // 외출 금지: 관리자·학년부장만(서버 students_ban_editors)
  // 학생 계정 발급·비밀번호 재발급·계정 삭제·반 단위 삭제는 관리자만
  isAdmin: false,
  classDeleteSelected: new Set(), // 반 단위 삭제에서 고른 반(cls)
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

// 학생의 학년: 반("2학년 1반")에서, 없으면 학번 첫 자리에서. 둘 다 아니면 null(지금 학년 탭으로 저장)
// 고른 학년 탭과 상관없이 학번대로 저장되게 한다(사용자 요청 — 1학년 탭에서 2학년 학번을 넣으면 2학년으로)
function gradeOfStudent(cls, sid) {
  const fromCls = /^([1-3])학년/.exec((cls || "").trim());
  if (fromCls) return fromCls[1];
  const fromSid = /^([1-3])\d{4}$/.exec((sid || "").trim());
  return fromSid ? fromSid[1] : null;
}

// 엑셀에서 복사한 줄: 이름 · 학번 · ID · 학생 연락처 · 학부모 연락처 · 이메일(학번 뒤는 선택, 빈 칸 가능).
// 예전 형식("이름 학번 이메일")도 세 번째 칸에 @가 있으면 이메일로 읽는다.
// 지금 학년에 같은 학번이 있으면 새로 추가하지 않고 그 학생의 정보를 갱신한다(existingId).
// 학번 마지막 2자리 = 번호 (예: "10305" → 5)
function deriveNumberFromSid(sid) {
  const match = /^\d{3}(\d{2})$/.exec((sid || "").trim());
  return match ? String(Number(match[1])) : "";
}

// 학년은 학번으로 정한다(어느 학년 탭에서 붙여넣어도 됨). 학번 형식이 아니면 지금 학년 탭으로
function parseBulkInput(text) {
  const rows = [];
  const errors = [];
  const existingBySid = new Map();
  for (const grade of state.allowedGrades) {
    for (const [id, s] of Object.entries(state.studentsByGrade[grade] || {})) existingBySid.set(s.sid, { id, grade, ...s });
  }
  const seenSids = new Set();
  const seenLoginIds = new Set();
  text.split(/\r?\n/).forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const parts = (trimmed.includes("\t") ? trimmed.split("\t") : trimmed.split(",")).map((p) => p.trim());
    const [name, sid] = parts;
    const legacy = (parts[2] || "").includes("@");
    const [rawLoginId, rawPhone, rawParentPhone, rawEmail] = legacy ? ["", "", "", parts[2]] : parts.slice(2);
    const label = `${i + 1}번째 줄`;
    if (!name || !sid) {
      errors.push(`${label}을 확인해 주세요: "${trimmed}"`);
      return;
    }
    if (seenSids.has(sid)) {
      errors.push(`${label}: 학번 ${sid}이(가) 위에 이미 있습니다.`);
      return;
    }
    const loginId = normalizeLoginId(rawLoginId);
    const phone = normalizePhone(rawPhone);
    const parentPhone = normalizePhone(rawParentPhone);
    if (loginId === null) {
      errors.push(`${label}: ID는 영문·숫자와 . _ - 만 쓸 수 있습니다 ("${rawLoginId}").`);
      return;
    }
    if (phone === null || parentPhone === null) {
      errors.push(`${label}: 연락처는 010으로 시작하는 휴대폰 번호로 입력해 주세요.`);
      return;
    }
    if (loginId && seenLoginIds.has(loginId)) {
      errors.push(`${label}: ID ${loginId}이(가) 위에 이미 있습니다.`);
      return;
    }
    const existing = existingBySid.get(sid) || null;
    const cls = existing ? existing.cls : deriveClsFromSid(sid) || "";
    const grade = existing ? existing.grade : gradeOfStudent(cls, sid) || state.activeGrade;
    if (!state.allowedGrades.includes(grade)) {
      errors.push(`${label}: "${name}"(학번 ${sid})은(는) ${grade}학년이라 추가할 수 없습니다(담당 학년이 아님).`);
      return;
    }
    const classRestriction = getClassRestriction(grade);
    if (classRestriction && cls && !classRestriction.includes(cls)) {
      errors.push(`${label}: "${name}"(${cls})은(는) 담당 반(${classRestriction.join(", ")})이 아닙니다.`);
      return;
    }
    seenSids.add(sid);
    if (loginId) seenLoginIds.add(loginId);
    rows.push({
      existingId: existing ? existing.id : null,
      grade,
      name,
      sid,
      cls,
      loginId,
      phone,
      parentPhone,
      email: (rawEmail || "").trim(),
    });
  });
  return { rows, errors };
}

function renderDayToggle() {
  dayToggleRow.innerHTML = DAY_LABELS.map((label, i) => {
    const active = state.dayFlags[i];
    return `<button type="button" class="day-toggle${active ? " is-active" : ""}" data-day-index="${i}"${state.leaveOnly ? " disabled" : ""}>${label}</button>`;
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
      const banNow = outingBanOn(s, TODAY_KEY);
      const ban = s.outingBan;
      const banBadge = banNow
        ? `<div class="status-badge status-badge--ban" title="${escapeHtml(banNow.reason || "")}">${escapeHtml(outingBanText(banNow))}</div>`
        : ban && ban.to >= TODAY_KEY
          ? `<div class="since-text">외출 금지 예정: ${escapeHtml(ban.from)} ~ ${escapeHtml(ban.to)}</div>`
          : "";
      // 외출 금지 해제는 버튼 하나로(사용자 요청 — 수정 폼에서 날짜를 지우지 않아도 됨)
      const liftBanButton =
        state.canEditBan && ban && ban.to >= TODAY_KEY
          ? `<button type="button" class="btn-secondary btn-small" data-lift-ban="${escapeHtml(id)}">외출 금지 해제</button>`
          : "";
      // 목록에는 학번·이름·반·번호만 보여준다(ID·연락처·이메일은 "수정"을 눌러야 보임).
      const seatNo = deriveNumberFromSid(s.sid);
      const hasAccount = Boolean(state.accounts[id]);
      const accountChip = state.leaveOnly
        ? ""
        : hasAccount
        ? `<span class="account-chip account-chip--active">계정 있음</span>`
        : `<span class="account-chip">${s.loginId ? "계정 없음" : "ID 미등록"}</span>`;
      // 학생 계정 발급·비번 재발급·계정 삭제는 관리자만(사용자 요청 — 서버 함수도 거부)
      const accountButtons = !state.isAdmin
        ? ""
        : hasAccount
        ? `<button type="button" class="btn-secondary btn-small" data-reset-account="${escapeHtml(id)}">비번 재발급</button>
           <button type="button" class="btn-secondary btn-small" data-delete-account="${escapeHtml(id)}">계정 삭제</button>`
        : s.loginId
          ? `<button type="button" class="btn-secondary btn-small" data-issue-account="${escapeHtml(id)}">계정 발급</button>`
          : "";
      return `
        <div class="student-card">
          <div class="student-avatar ${onLeave ? "student-avatar--leave" : "student-avatar--in"}">${escapeHtml((s.name || "?").charAt(0))}</div>
          <div class="student-info">
            <div class="student-name">${escapeHtml(s.name || "이름 없음")}</div>
            <div class="student-meta">학번 ${escapeHtml(s.sid || "-")} · ${escapeHtml(s.cls || "-")}${seatNo ? ` ${seatNo}번` : ""}</div>
          </div>
          <div class="day-pill-row">${days}</div>
          ${leaveBadge}
          ${banBadge}
          ${accountChip}
          <div class="roster-actions">
            ${liftBanButton}
            ${accountButtons}
            ${
              state.leaveOnly
                ? `<button type="button" class="btn-secondary btn-small" data-edit-id="${escapeHtml(id)}">명령퇴사 설정</button>`
                : `<button type="button" class="btn-secondary btn-small" data-edit-id="${escapeHtml(id)}">수정</button>
            ${
              // 계정이 있는 학생을 명단에서 지우는 건 관리자만(계정도 함께 지워지므로)
              hasAccount && !state.isAdmin
                ? ""
                : `<button type="button" class="btn-danger btn-small" data-delete-id="${escapeHtml(id)}">삭제</button>`
            }`
            }
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
  inputLoginId.value = "";
  inputPhone.value = "";
  inputParentPhone.value = "";
  setLoginIdLocked(false);
  inputLeaveFrom.value = "";
  inputLeaveTo.value = "";
  inputLeaveReason.value = "";
  inputBanFrom.value = "";
  inputBanTo.value = "";
  inputBanReason.value = "";
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
  leaveFields.hidden = !state.canEditLeave;
  banFields.hidden = !state.canEditBan;
  issueOnSaveLabel.hidden = !state.isAdmin; // 새 학생을 추가할 때만(수정할 때는 숨김)
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
  inputLoginId.value = s.loginId || "";
  inputPhone.value = formatPhone(s.phone);
  inputParentPhone.value = formatPhone(s.parentPhone);
  // 계정이 있으면 아이디를 바꿀 수 없다(서버 트리거도 막음) — 바꾸려면 계정을 삭제한 뒤 다시 발급
  setLoginIdLocked(Boolean(state.accounts[id]));
  const leave = s.leaveOfAbsence || {};
  inputLeaveFrom.value = leave.from || "";
  inputLeaveTo.value = leave.to || "";
  inputLeaveReason.value = leave.reason || "";
  const ban = s.outingBan || {};
  inputBanFrom.value = ban.from || "";
  inputBanTo.value = ban.to || "";
  inputBanReason.value = ban.reason || "";
  state.dayFlags = (s.afterschoolDays || [false, false, false, false, false]).slice();
  // 기존 학생은 이미 반이 저장되어 있으니, 학번을 고치더라도 자동으로 덮어쓰지 않는다.
  state.clsManuallyEdited = true;
  renderDayToggle();
  // 기숙사부는 명령퇴사 칸만 고칠 수 있다 — 다른 학생 정보(ID·연락처 등)는 아예 보이지 않게 한다
  studentInfoFields.hidden = state.leaveOnly;
  leaveOnlyTitle.hidden = !state.leaveOnly;
  leaveOnlyTitle.textContent = `${s.name || "이름 없음"} (학번 ${s.sid || "-"}) 명령퇴사 기간`;
  leaveFields.hidden = !state.canEditLeave;
  banFields.hidden = !state.canEditBan;
  issueOnSaveLabel.hidden = true;
  formWrap.hidden = false;
  (state.leaveOnly ? inputLeaveFrom : inputName).focus();
}

function setLoginIdLocked(locked) {
  inputLoginId.disabled = locked;
  loginIdHint.textContent = locked
    ? "계정이 발급되어 있어 바꿀 수 없습니다. 바꾸려면 계정을 삭제한 뒤 다시 발급하세요."
    : "계정을 발급하면 학생이 이 아이디로 로그인합니다.";
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
  const { rows, errors } = parseBulkInput(bulkInput.value);
  bulkPreviewRows = rows;

  const parts = [];
  if (rows.length > 0) {
    parts.push(
      `<div class="bulk-preview__list">${rows
        .map((r) => {
          const fields = [
            r.name,
            r.sid,
            r.cls || `${r.grade}학년 · 반 확인 필요`,
            r.loginId ? `ID ${r.loginId}` : "",
            r.phone ? `학생 ${formatPhone(r.phone)}` : "",
            r.parentPhone ? `학부모 ${formatPhone(r.parentPhone)}` : "",
            r.email,
          ].filter(Boolean);
          const tag = r.existingId ? "정보 갱신" : "새로 추가";
          return `<div class="bulk-preview__row">[${tag}] ${escapeHtml(fields.join(" · "))}</div>`;
        })
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

// 같은 ID가 이미 다른 학생에게 있을 때(unique 제약) 알아보기 쉬운 문장으로
function describeStudentSaveError(error) {
  if (error && error.code === "23505" && /login_id/.test(String(error.message || error.details || ""))) {
    return "이미 다른 학생이 쓰는 ID입니다.";
  }
  return describeError(error);
}

addStudentBtn.addEventListener("click", () => {
  if (!state.activeGrade) return;
  closeBulkForm();
  openFormForAdd();
});

bulkAddBtn.addEventListener("click", () => {
  if (!state.activeGrade) return;
  closeClassDelete();
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

// 저장 결과 처리: 실패하면 알리고, 성공하면 Realtime 알림을 기다리지 않고 바로 다시 읽는다.
async function afterWrite(error) {
  if (error) {
    alert(`저장하지 못했습니다: ${describeStudentSaveError(error)}`);
    return false;
  }
  await Promise.all([studentsLive ? studentsLive.refresh() : null, accountsLive ? accountsLive.refresh() : null]);
  return true;
}

bulkSaveBtn.addEventListener("click", async () => {
  if (bulkPreviewRows.length === 0 || !state.activeGrade) return;
  const newRows = bulkPreviewRows
    .filter((row) => !row.existingId)
    .map((row) =>
      studentToRow(row.grade, {
        name: row.name,
        sid: row.sid,
        cls: row.cls,
        email: row.email,
        loginId: row.loginId,
        phone: row.phone,
        parentPhone: row.parentPhone,
        afterschoolDays: [false, false, false, false, false],
      })
    );
  const updates = bulkPreviewRows.filter((row) => row.existingId);
  bulkSaveBtn.disabled = true;
  bulkSaveBtn.textContent = "저장 중...";

  // 새 학생은 한 번에 저장한다 — 하나라도 실패하면 새 학생은 전부 저장되지 않으므로 고친 뒤 다시 누르면 된다.
  const savedWithId = []; // 저장한 학생 중 ID가 있는 학생(저장하면서 계정 발급용)
  if (newRows.length > 0) {
    // 아이디 칸은 다시 읽을 수 없으므로(열 권한) 보낸 순서대로 맞춘다
    const { data: inserted, error } = await supabase.from("students").insert(newRows).select("id");
    if (!error) savedWithId.push(...inserted.filter((r, i) => newRows[i] && newRows[i].login_id).map((r) => r.id));
    if (error) {
      alert(`새 학생을 저장하지 못했습니다(정보 갱신도 하지 않았습니다): ${describeStudentSaveError(error)}`);
      renderBulkPreview();
      return;
    }
  }
  // 이미 있는 학생은 입력한 칸만 갱신한다(빈 칸은 그대로 둠).
  const failures = [];
  for (const row of updates) {
    const patch = { name: row.name };
    if (row.loginId) patch.login_id = row.loginId;
    if (row.phone) patch.phone = row.phone;
    if (row.parentPhone) patch.parent_phone = row.parentPhone;
    if (row.email) patch.email = row.email;
    const { data, error } = await supabase.from("students").update(patch).eq("id", row.existingId).select("id");
    if (error || data.length === 0) {
      failures.push(`${row.name}(${row.sid}): ${error ? describeStudentSaveError(error) : "권한이 없거나 이미 삭제된 학생입니다."}`);
    } else if (row.loginId || findStudent(row.existingId)?.loginId) {
      savedWithId.push(row.existingId);
    }
  }
  await afterWrite(null);
  if (issueOnSaveWanted(issueOnBulkCheck)) {
    const ids = withoutAccount(savedWithId);
    if (ids.length > 0) await issueAccounts(ids, bulkSaveBtn);
  }
  if (failures.length > 0) {
    alert(`다음 학생은 정보를 갱신하지 못했습니다.\n${failures.join("\n")}`);
    renderBulkPreview();
    return;
  }
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
  if (!btn || state.leaveOnly) return;
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
  closeClassDelete();
  renderGradeTabs();
  renderRoster();
  renderBulkIssueButton();
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
    const accountNote = state.accounts[id] ? "\n학생 계정(로그인)도 함께 삭제됩니다." : "";
    if (confirm(`${name}을(를) 명단에서 삭제할까요?${accountNote}`)) {
      deleteStudent(id);
    }
    return;
  }
  const liftBanBtn = event.target.closest("[data-lift-ban]");
  if (liftBanBtn) {
    liftOutingBan(liftBanBtn.dataset.liftBan, liftBanBtn);
    return;
  }
  const issueBtn = event.target.closest("[data-issue-account]");
  if (issueBtn) {
    issueAccounts([issueBtn.dataset.issueAccount], issueBtn);
    return;
  }
  const resetBtn = event.target.closest("[data-reset-account]");
  if (resetBtn) {
    resetAccountPassword(resetBtn.dataset.resetAccount, resetBtn);
    return;
  }
  const deleteAccountBtn = event.target.closest("[data-delete-account]");
  if (deleteAccountBtn) deleteAccount(deleteAccountBtn.dataset.deleteAccount, deleteAccountBtn);
});

// "저장하면서 학생 계정도 발급"(관리자만, 기본 체크) — 학생 추가와 계정 발급을 한 번에(사용자 요청)
function issueOnSaveWanted(checkbox) {
  return state.isAdmin && checkbox.checked;
}

// 아직 계정이 없는 학생만(저장 직후 afterWrite로 계정 목록을 다시 읽은 뒤에 부른다)
function withoutAccount(ids) {
  return [...new Set(ids)].filter((id) => id && !state.accounts[id]);
}

// 학생 찾기(모든 학년 — 붙여넣기로 다른 학년 학생도 함께 저장·발급할 수 있어서)
function findStudent(id) {
  for (const grade of Object.keys(state.studentsByGrade)) {
    const s = (state.studentsByGrade[grade] || {})[id];
    if (s) return { id, grade, ...s };
  }
  return null;
}

// 학생 계정 발급(여러 명). 서버(student-accounts)가 권한·아이디·중복을 확인하고 6자리 비밀번호를 만든다.
async function issueAccounts(studentIds, btn) {
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "발급 중...";
  const results = [];
  for (let start = 0; start < studentIds.length; start += MAX_ACCOUNTS_PER_REQUEST) {
    const chunk = studentIds.slice(start, start + MAX_ACCOUNTS_PER_REQUEST);
    let chunkResults = null;
    let failure = "";
    try {
      const data = await callFunction("student-accounts", { action: "issue", studentIds: chunk, appPath: APP_PATH });
      chunkResults = Array.isArray(data && data.results) ? data.results : null;
      if (!chunkResults) failure = "서버 응답을 확인하지 못했습니다.";
    } catch (err) {
      failure = err.message;
    }
    for (const [i, studentId] of chunk.entries()) {
      const res = chunkResults ? chunkResults.find((r) => r.studentId === studentId) || chunkResults[i] : null;
      const s = findStudent(studentId) || { name: "", sid: "" };
      results.push({
        kind: "issue",
        name: s.name,
        sid: s.sid,
        loginId: res && res.ok ? res.loginId : s.loginId || "",
        password: res && res.ok ? res.password || "" : "",
        sms: res && res.ok ? res.sms : "",
        smsError: res && res.ok ? res.smsError || "" : "",
        ok: Boolean(res && res.ok),
        errorText: res && !res.ok ? res.error : failure || "계정을 만들지 못했습니다.",
      });
    }
  }
  btn.disabled = false;
  btn.textContent = originalText;
  addAccountResults(results);
  if (accountsLive) await accountsLive.refresh();
}

async function resetAccountPassword(studentId, btn) {
  const s = findStudent(studentId) || { name: "이 학생", sid: "" };
  if (!confirm(`${s.name}의 비밀번호를 새로 발급할까요?\n지금 쓰는 비밀번호로는 더 이상 로그인할 수 없게 됩니다.`)) return;
  btn.disabled = true;
  try {
    const data = await callFunction("student-accounts", { action: "reset-password", studentId, appPath: APP_PATH });
    addAccountResults([
      {
        kind: "reset",
        name: s.name,
        sid: s.sid,
        loginId: data.loginId,
        password: data.password || "",
        sms: data.sms,
        smsError: data.smsError || "",
        ok: true,
      },
    ]);
  } catch (err) {
    addAccountResults([{ kind: "reset", name: s.name, sid: s.sid, loginId: s.loginId, ok: false, errorText: err.message }]);
  }
  btn.disabled = false;
}

async function deleteAccount(studentId, btn) {
  const s = findStudent(studentId) || { name: "이 학생" };
  if (!confirm(`${s.name}의 학생 계정을 삭제할까요?\n학생은 더 이상 로그인할 수 없고, 명단에는 그대로 남습니다.`)) return;
  btn.disabled = true;
  try {
    await callFunction("student-accounts", { action: "delete", studentId });
    if (accountsLive) await accountsLive.refresh();
  } catch (err) {
    alert(`계정을 삭제하지 못했습니다: ${err.message}`);
    btn.disabled = false;
  }
}

// 지금 보이는 학년(담임은 담당 반)에서 ID가 있고 계정이 아직 없는 학생
function getIssuableStudentIds() {
  const classRestriction = getClassRestriction(state.activeGrade);
  return Object.entries(state.studentsByGrade[state.activeGrade] || {})
    .filter(([id, s]) => s.loginId && !state.accounts[id] && (!classRestriction || classRestriction.includes(s.cls)))
    .sort((a, b) => (a[1].sid || "").localeCompare(b[1].sid || ""))
    .map(([id]) => id);
}

function renderBulkIssueButton() {
  const count = state.activeGrade && state.accountsLoaded ? getIssuableStudentIds().length : 0;
  bulkIssueBtn.disabled = count === 0;
  bulkIssueBtn.textContent = `계정 일괄 발급 (${count}명)`;
}

bulkIssueBtn.addEventListener("click", async () => {
  const ids = getIssuableStudentIds();
  if (ids.length === 0) return;
  if (!confirm(`ID가 등록되어 있고 계정이 없는 ${ids.length}명의 계정을 발급할까요?`)) return;
  await issueAccounts(ids, bulkIssueBtn);
  renderBulkIssueButton();
});

function addAccountResults(results) {
  const at = new Date();
  state.accountResults = [...results.map((r) => ({ ...r, at })), ...state.accountResults];
  renderAccountResults();
  accountResultWrap.scrollIntoView({ behavior: "smooth", block: "start" });
}

// 비밀번호를 어떻게 전달했는지(서버가 학생에게 문자로 보냈으면 비밀번호는 화면에 오지 않음)
function describeDelivery(r) {
  if (r.sms === "sent") return "비밀번호를 학생에게 문자로 보냈습니다";
  const reason =
    r.sms === "failed" ? `문자 실패(${r.smsError || "발송 실패"}) — ` : r.sms === "no-phone" ? "학생 연락처 없음 — " : "";
  return `${reason}비밀번호: ${r.password}`;
}

// 발급·재발급 결과. 화면에 비밀번호가 온 것만 "이름[탭]학번[탭]아이디[탭]비밀번호" 줄로 모아 엑셀에 붙여넣기 쉽게 보여준다.
function renderAccountResults() {
  const results = state.accountResults;
  accountResultWrap.hidden = results.length === 0;
  accountResultList.innerHTML = results
    .map(
      (r) => `
        <div class="student-card">
          <div class="student-info">
            <div class="student-name">${escapeHtml(r.name || "-")}</div>
            <div class="student-meta">학번 ${escapeHtml(r.sid || "-")} · ID ${escapeHtml(r.loginId || "-")}</div>
          </div>
          ${
            r.ok
              ? `<div class="status-badge status-badge--in">${r.kind === "reset" ? "재발급됨" : "발급됨"}</div><div class="since-text">${escapeHtml(describeDelivery(r))}</div>`
              : `<div class="status-badge status-badge--out">실패</div><div class="since-text">${escapeHtml(r.errorText)}</div>`
          }
        </div>
      `
    )
    .join("");
  accountResultCopy.value = results
    .filter((r) => r.ok && r.password && r.sms !== "sent")
    .map((r) => [r.name, r.sid, r.loginId, r.password].join("\t"))
    .join("\n");
}

// 발급·재발급한 비밀번호를 CSV 파일로 내려받는다(서버에 저장하지 않으므로 관리자가 따로 보관 — 사용자 요청).
// 엑셀에서 한글이 깨지지 않게 BOM을 붙이고, 수식으로 읽히지 않게 =·+·-·@로 시작하는 칸은 앞에 '를 붙인다.
function csvCell(value) {
  let text = String(value ?? "");
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function formatDateTime(date) {
  return `${getDateKey(date)} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

accountResultDownloadBtn.addEventListener("click", () => {
  const rows = state.accountResults.filter((r) => r.ok && r.password);
  if (rows.length === 0) {
    alert("파일로 받을 비밀번호가 없습니다.");
    return;
  }
  const lines = [
    ["이름", "학번", "아이디", "비밀번호", "구분", "전달", "시각"],
    ...rows.map((r) => [
      r.name,
      r.sid,
      r.loginId,
      r.password,
      r.kind === "reset" ? "재발급" : "발급",
      r.sms === "sent" ? "문자 보냄" : "직접 전달",
      formatDateTime(r.at),
    ]),
  ];
  const csv = "﻿" + lines.map((cells) => cells.map(csvCell).join(",")).join("\r\n") + "\r\n";
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `student-passwords_${formatDateTime(new Date()).replace(" ", "_").replace(":", "")}.csv`;
  document.body.append(link);
  link.click();
  setTimeout(() => {
    link.remove();
    URL.revokeObjectURL(url);
  }, 1000);
});

// 반 단위 삭제(관리자만): 지금 학년 탭의 반을 골라 그 반 학생을 한 번에 지운다(테스트로 넣은 반 정리 등).
// 서버 함수(student-accounts, delete-students)가 학생 계정까지 함께 지운다.
function studentsByClassInActiveGrade() {
  const byClass = new Map();
  for (const [id, s] of Object.entries(state.studentsByGrade[state.activeGrade] || {})) {
    const cls = s.cls || "(반 없음)";
    if (!byClass.has(cls)) byClass.set(cls, []);
    byClass.get(cls).push(id);
  }
  return new Map([...byClass.entries()].sort((a, b) => a[0].localeCompare(b[0], "ko", { numeric: true })));
}

function selectedClassDeleteIds() {
  const byClass = studentsByClassInActiveGrade();
  return [...state.classDeleteSelected].flatMap((cls) => byClass.get(cls) || []);
}

function renderClassDelete() {
  const byClass = studentsByClassInActiveGrade();
  for (const cls of [...state.classDeleteSelected]) if (!byClass.has(cls)) state.classDeleteSelected.delete(cls);
  classDeleteChips.innerHTML =
    byClass.size === 0
      ? `<span class="field-hint">이 학년에 등록된 학생이 없습니다.</span>`
      : [...byClass.entries()]
          .map(([cls, ids]) => {
            const active = state.classDeleteSelected.has(cls);
            return `<button type="button" class="filter-chip${active ? " is-active" : ""}" data-delete-cls="${escapeHtml(cls)}">${escapeHtml(cls)} (${ids.length}명)</button>`;
          })
          .join("");
  const count = selectedClassDeleteIds().length;
  classDeleteSaveBtn.disabled = count === 0;
  classDeleteSaveBtn.textContent = `삭제 (${count}명)`;
}

function closeClassDelete() {
  classDeleteWrap.hidden = true;
  state.classDeleteSelected.clear();
}

classDeleteBtn.addEventListener("click", () => {
  if (!state.activeGrade || !state.isAdmin) return;
  closeForm();
  closeBulkForm();
  state.classDeleteSelected.clear();
  renderClassDelete();
  classDeleteWrap.hidden = false;
});

cancelClassDeleteBtn.addEventListener("click", closeClassDelete);

classDeleteChips.addEventListener("click", (event) => {
  const btn = event.target.closest("[data-delete-cls]");
  if (!btn) return;
  const cls = btn.dataset.deleteCls;
  if (state.classDeleteSelected.has(cls)) state.classDeleteSelected.delete(cls);
  else state.classDeleteSelected.add(cls);
  renderClassDelete();
});

classDeleteSaveBtn.addEventListener("click", async () => {
  const ids = selectedClassDeleteIds();
  if (ids.length === 0) return;
  const classes = [...state.classDeleteSelected].join(", ");
  const withAccount = ids.filter((id) => state.accounts[id]).length;
  const accountNote = withAccount > 0 ? `\n학생 계정 ${withAccount}개도 함께 지워집니다.` : "";
  const answer = prompt(
    `${classes} 학생 ${ids.length}명을 명단에서 지웁니다.${accountNote}\n좌석 배정·외출 기록도 함께 지워지고 되돌릴 수 없습니다.\n\n계속하려면 "삭제"라고 입력하세요.`
  );
  if (answer === null) return;
  if (answer.trim() !== "삭제") {
    alert('"삭제"라고 입력하지 않아 지우지 않았습니다.');
    return;
  }
  classDeleteSaveBtn.disabled = true;
  classDeleteSaveBtn.textContent = "삭제 중...";
  let failed = 0;
  let failure = "";
  for (let start = 0; start < ids.length; start += MAX_ACCOUNTS_PER_REQUEST) {
    const chunk = ids.slice(start, start + MAX_ACCOUNTS_PER_REQUEST);
    try {
      const data = await callFunction("student-accounts", { action: "delete-students", studentIds: chunk });
      const results = Array.isArray(data && data.results) ? data.results : [];
      failed += chunk.length - results.filter((r) => r.ok).length;
      const firstError = results.find((r) => !r.ok);
      if (firstError && !failure) failure = firstError.error;
    } catch (err) {
      failed += chunk.length;
      if (!failure) failure = err.message;
    }
  }
  await afterWrite(null);
  if (failed > 0) {
    alert(`${ids.length - failed}명을 지웠고 ${failed}명은 지우지 못했습니다: ${failure}`);
    renderClassDelete();
    return;
  }
  closeClassDelete();
});

// 권한 밖의 행은 서버(RLS)가 조용히 건너뛰므로, 실제로 바뀐 행이 있는지 확인한다.
// 계정이 있는 학생은 로그인 정보가 남지 않도록 서버 함수가 계정과 명단을 함께 지운다.
async function deleteStudent(id) {
  if (state.accounts[id]) {
    try {
      await callFunction("student-accounts", { action: "delete", studentId: id, withStudent: true });
    } catch (err) {
      alert(`삭제하지 못했습니다: ${err.message}`);
      return;
    }
    await afterWrite(null);
    return;
  }
  const { data, error } = await supabase.from("students").delete().eq("id", id).select("id");
  if (!error && data.length === 0) {
    alert("삭제하지 못했습니다: 권한이 없거나 이미 삭제된 학생입니다.");
    return;
  }
  await afterWrite(error);
}

// 외출 금지 해제(관리자·학년부장, 서버 students_ban_editors도 확인) — 확인 창 없이 바로
async function liftOutingBan(id, btn) {
  btn.disabled = true;
  const { data, error } = await supabase
    .from("students")
    .update({ ban_from: null, ban_to: null, ban_reason: null })
    .eq("id", id)
    .select("id");
  btn.disabled = false;
  if (!error && data.length === 0) {
    alert("해제하지 못했습니다: 권한이 없거나 이미 삭제된 학생입니다.");
    return;
  }
  await afterWrite(error);
}

// 명령퇴사 기간 검사(학생 추가·수정 폼, 기숙사부의 명령퇴사 설정이 같이 씀). 문제가 있으면 alert하고 null
function readLeaveInputs() {
  const leaveFrom = inputLeaveFrom.value;
  const leaveTo = inputLeaveTo.value;
  if ((leaveFrom && !leaveTo) || (!leaveFrom && leaveTo)) {
    alert("명령퇴사 기간은 시작일과 종료일을 모두 입력해 주세요.");
    return null;
  }
  if (leaveFrom && leaveTo && leaveFrom > leaveTo) {
    alert("명령퇴사 종료일은 시작일보다 빠를 수 없습니다.");
    return null;
  }
  return leaveFrom && leaveTo ? { from: leaveFrom, to: leaveTo, reason: inputLeaveReason.value.trim() } : {};
}

// 외출 금지 기간 검사(학년부장·관리자). 문제가 있으면 alert하고 null
function readBanInputs() {
  const from = inputBanFrom.value;
  const to = inputBanTo.value;
  if ((from && !to) || (!from && to)) {
    alert("외출 금지 기간은 시작일과 종료일을 모두 입력해 주세요.");
    return null;
  }
  if (from && to && from > to) {
    alert("외출 금지 종료일은 시작일보다 빠를 수 없습니다.");
    return null;
  }
  return from && to ? { from, to, reason: inputBanReason.value.trim() } : {};
}

// 기숙사부: 명령퇴사 칸만 저장한다(서버도 다른 칸이 바뀌면 거부)
async function saveLeaveOnly(id) {
  const leave = readLeaveInputs();
  if (!leave) return;
  submitFormBtn.disabled = true;
  const { data: saved, error } = await supabase
    .from("students")
    .update({ leave_from: leave.from || null, leave_to: leave.to || null, leave_reason: leave.from ? leave.reason || null : null })
    .eq("id", id)
    .select("id");
  submitFormBtn.disabled = false;
  if (!error && saved.length === 0) {
    alert("저장하지 못했습니다: 권한이 없거나 이미 삭제된 학생입니다.");
    return;
  }
  if (!(await afterWrite(error))) return;
  closeForm();
}

studentForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.leaveOnly) {
    if (editingIdInput.value) await saveLeaveOnly(editingIdInput.value);
    return;
  }
  const name = inputName.value.trim();
  const sid = inputSid.value.trim();
  const cls = inputCls.value.trim();
  const email = inputEmail.value.trim();

  if (!name || !sid || !cls) {
    alert("이름, 학번, 반을 모두 입력해 주세요.");
    return;
  }

  // 학년은 반·학번대로(고른 학년 탭과 다르면 그 학년으로 저장)
  const grade = gradeOfStudent(cls, sid) || state.activeGrade;
  if (!state.allowedGrades.includes(grade)) {
    alert(`${grade}학년은 담당 학년이 아니라 저장할 수 없습니다. 반·학번을 확인해 주세요.`);
    return;
  }
  const classRestriction = getClassRestriction(grade);
  if (classRestriction && !classRestriction.includes(cls)) {
    alert(`담당 반(${classRestriction.join(", ")})의 학생만 등록·수정할 수 있습니다.`);
    return;
  }

  const loginId = normalizeLoginId(inputLoginId.value);
  if (loginId === null) {
    alert("ID는 영문·숫자와 . _ - 만 쓸 수 있습니다(64자 이하).");
    return;
  }
  const phone = normalizePhone(inputPhone.value);
  const parentPhone = normalizePhone(inputParentPhone.value);
  if (phone === null || parentPhone === null) {
    alert("연락처는 010으로 시작하는 휴대폰 번호로 입력해 주세요(예: 010-1234-5678).");
    return;
  }

  const leave = readLeaveInputs();
  if (!leave) return;
  const ban = state.canEditBan ? readBanInputs() : {};
  if (!ban) return;

  const data = {
    name,
    sid,
    cls,
    email,
    loginId,
    phone,
    parentPhone,
    afterschoolDays: state.dayFlags.slice(),
  };
  if (leave.from) data.leaveOfAbsence = leave;
  if (ban.from) data.outingBan = ban;

  const row = studentToRow(grade, data);
  if (!state.canEditBan) {
    // 외출 금지 칸은 학년부장·관리자만(지금 값을 그대로 둠)
    delete row.ban_from;
    delete row.ban_to;
    delete row.ban_reason;
  }
  if (!state.canEditLeave) {
    // 담임·학년부장은 명령퇴사 칸을 건드리지 않는다(지금 값을 그대로 둠)
    delete row.leave_from;
    delete row.leave_to;
    delete row.leave_reason;
  }
  const editingId = editingIdInput.value;
  submitFormBtn.disabled = true;
  const { data: saved, error } = editingId
    ? await supabase.from("students").update(row).eq("id", editingId).select("id")
    : await supabase.from("students").insert(row).select("id");
  submitFormBtn.disabled = false;
  if (!error && saved.length === 0) {
    alert("저장하지 못했습니다: 권한이 없거나 이미 삭제된 학생입니다.");
    return;
  }
  if (!(await afterWrite(error))) return;
  const toIssue = !editingId && loginId && issueOnSaveWanted(issueOnSaveCheck) ? withoutAccount([saved[0].id]) : [];
  if (toIssue.length > 0) await issueAccounts(toIssue, submitFormBtn);
  closeForm();
});

// 아이디·연락처·이메일(담당 범위)과 명령퇴사 사유는 서버가 허용된 사람에게만 준다(사용자 요청, private-fields.js).
// 명단 행에 붙여 두면 수정 폼·여러 명 추가가 지금처럼 쓴다. 기숙사부는 연락처를 쓰지 않으므로 읽지 않음
function studentExtras(rows) {
  return state.leaveOnly ? addLeaveReasons(rows) : allOf(addContacts, addLeaveReasons)(rows);
}

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
  addStudentBtn.hidden = state.leaveOnly;
  bulkAddBtn.hidden = state.leaveOnly;
  bulkIssueBtn.hidden = !state.isAdmin;
  classDeleteBtn.hidden = !state.isAdmin;
  issueOnBulkLabel.hidden = !state.isAdmin;

  studentsLive = liveTable({
    table: "students",
    select: STUDENT_COLUMNS,
    order: ["id"],
    augment: studentExtras,
    onRows: (rows) => {
      state.studentsByGrade = groupStudentsByGrade(rows);
      renderRoster();
      renderBulkIssueButton();
      if (!classDeleteWrap.hidden) renderClassDelete();
    },
    onError: reportLoadError,
  });
  accountsLive = liveTable({
    table: "profiles",
    select: "id,student_id,login_id",
    eq: { kind: "student" },
    order: ["id"],
    onRows: (rows) => {
      state.accounts = Object.fromEntries(rows.map((row) => [row.student_id, { loginId: row.login_id }]));
      state.accountsLoaded = true;
      renderRoster();
      renderBulkIssueButton();
    },
    onError: reportLoadError,
  });
}

async function init() {
  const session = await requireStaff();
  if (!session) return;
  const { loginId, profile } = session;
  const role = profile.role;
  navLoadingHint.hidden = true;
  accountsLink.hidden = role !== "admin";
  afterschoolLink.hidden = role !== "admin";
  // 이 화면에 들어오는 사람 중 외출 기록을 못 보는 건 기숙사부뿐
  historyLink.hidden = role === "dormStaff";

  function showCurrentUser() {
    currentUserNameEl.textContent = profile.name || loginId;
    currentUserRoleBadgeEl.textContent = role;
    currentUserRoleBadgeEl.className = `role-badge role-badge--${role}`;
  }
  state.isAdmin = role === "admin";
  state.canEditLeave = role === "admin" || role === "dormStaff";
  state.canEditBan = role === "admin" || role === "gradeManager";

  if (role === "admin" || role === "dormStaff") {
    showCurrentUser();
    state.leaveOnly = role === "dormStaff";
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
}

logoutBtn.addEventListener("click", () => signOutTo());

renderDayToggle();
init();

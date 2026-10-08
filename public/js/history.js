// 외출 기록 화면: outing_log(외출할 때마다 한 줄, DB 트리거가 쌓음)를 기간·학년·이름으로 본다.
// 볼 수 있는 범위는 서버(RLS)가 정한다 — 담임은 담당 반, 학년부장은 담당 학년, 관리자는 전체. 기숙사부·일반 교사·자습 감독은 못 들어옴.
import { supabase, requireStaff, signOutTo, describeError, showPageError } from "./supabase-client.js";
import { GRADES, groupStudentsByGrade } from "./adapters.js";

const navLoadingHint = document.getElementById("navLoadingHint");
const accountsLink = document.getElementById("accountsLink");
const logoutBtn = document.getElementById("logoutBtn");
const currentUserNameEl = document.getElementById("currentUserName");
const currentUserRoleBadgeEl = document.getElementById("currentUserRoleBadge");
const searchInput = document.getElementById("search");
const fromDateEl = document.getElementById("fromDate");
const toDateEl = document.getElementById("toDate");
const gradeChipsEl = document.getElementById("gradeChips");
const summaryEl = document.getElementById("historySummary");
const bodyEl = document.getElementById("historyBody");

const MAX_ROWS = 2000;
const DEFAULT_DAYS = 7; // 처음에는 최근 1주일

function getDateKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
const TODAY_KEY = getDateKey();

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function formatDateLabel(dateKey) {
  const [y, m, d] = dateKey.split("-").map(Number);
  const weekday = ["일", "월", "화", "수", "목", "금", "토"][new Date(y, m - 1, d).getDay()];
  return `${m}/${d}(${weekday})`;
}

const state = {
  studentsById: {},
  rows: [],
  allowedGrades: [],
  activeGrade: "all",
  searchTerm: "",
};

// 복귀 칸: 복귀 시각 / 외출 시각 전에 끝났으면 "외출 취소" / 아직이면 "외출 중"(오늘)·"복귀 기록 없음"(지난 날)
function describeEnd(row) {
  if (row.ended_at) {
    const time = formatTime(row.ended_at);
    const endedDate = getDateKey(new Date(row.ended_at));
    if (row.start_time && endedDate === row.date && time < row.start_time) return { text: `외출 취소 ${time}`, cls: "history-end--cancel" };
    return { text: time, cls: "" };
  }
  return row.date === TODAY_KEY ? { text: "외출 중", cls: "history-end--out" } : { text: "복귀 기록 없음", cls: "history-end--missing" };
}

function renderGradeChips() {
  const grades = state.allowedGrades;
  if (grades.length <= 1) {
    gradeChipsEl.innerHTML = "";
    return;
  }
  gradeChipsEl.innerHTML = ["all", ...grades]
    .map((g) => {
      const label = g === "all" ? "전체" : `${g}학년`;
      return `<button type="button" class="filter-chip${state.activeGrade === g ? " is-active" : ""}" data-grade="${g}">${label}</button>`;
    })
    .join("");
}

function render() {
  renderGradeChips();
  const term = state.searchTerm.trim();
  const rows = state.rows.filter((row) => {
    const s = state.studentsById[row.student_id];
    if (state.activeGrade !== "all" && (!s || s.grade !== state.activeGrade)) return false;
    if (term && !(s && (s.name || "").includes(term))) return false;
    return true;
  });
  const truncated = state.rows.length >= MAX_ROWS ? ` (최근 ${MAX_ROWS}건까지만 보여요 — 기간을 줄여 주세요)` : "";
  summaryEl.textContent = `${rows.length}건${truncated}`;
  if (rows.length === 0) {
    bodyEl.innerHTML = `<tr><td colspan="8" class="history-empty">이 기간에 외출 기록이 없습니다.</td></tr>`;
    return;
  }
  bodyEl.innerHTML = rows
    .map((row) => {
      const s = state.studentsById[row.student_id] || {};
      const end = describeEnd(row);
      const out = row.start_time || formatTime(row.out_at);
      const via = row.request_id ? `<span class="history-tag">신청</span>` : "";
      return `
        <tr>
          <td>${escapeHtml(formatDateLabel(row.date))}</td>
          <td><div class="history-name">${escapeHtml(s.name || "(삭제된 학생)")}</div><div class="history-sub">${escapeHtml(s.sid || "")} · ${escapeHtml(s.cls || "")}</div></td>
          <td>${escapeHtml(out)} ${via}</td>
          <td class="${end.cls}">${escapeHtml(end.text)}</td>
          <td>${escapeHtml(row.expected_return || "-")}</td>
          <td>${escapeHtml(row.reason || "-")}</td>
          <td>${escapeHtml(row.out_by_name || "-")}</td>
          <td>${escapeHtml(row.ended_by_name || "-")}</td>
        </tr>
      `;
    })
    .join("");
}

let loadSeq = 0;
async function loadRows() {
  const from = fromDateEl.value;
  const to = toDateEl.value;
  if (!from || !to || from > to) {
    summaryEl.textContent = "기간을 올바르게 골라 주세요.";
    bodyEl.innerHTML = "";
    return;
  }
  const seq = ++loadSeq;
  summaryEl.textContent = "불러오는 중...";
  const { data, error } = await supabase
    .from("outing_log")
    .select("*")
    .gte("date", from)
    .lte("date", to)
    .order("date", { ascending: false })
    .order("out_at", { ascending: false })
    .limit(MAX_ROWS);
  if (seq !== loadSeq) return; // 그 사이에 기간을 또 바꿨으면 버림
  if (error) {
    showPageError(`외출 기록을 불러오지 못했습니다(${describeError(error)}).`);
    summaryEl.textContent = "";
    return;
  }
  state.rows = data || [];
  render();
}

async function loadStudents() {
  const { data, error } = await supabase.from("students").select("id, grade, name, sid, cls");
  if (error) {
    showPageError(`학생 명단을 불러오지 못했습니다(${describeError(error)}).`);
    return;
  }
  state.studentsById = {};
  for (const [grade, group] of Object.entries(groupStudentsByGrade(data || []))) {
    for (const [id, s] of Object.entries(group)) state.studentsById[id] = { ...s, grade };
  }
}

gradeChipsEl.addEventListener("click", (event) => {
  const btn = event.target.closest("[data-grade]");
  if (!btn) return;
  state.activeGrade = btn.dataset.grade;
  render();
});
searchInput.addEventListener("input", (event) => {
  state.searchTerm = event.target.value;
  render();
});
fromDateEl.addEventListener("change", loadRows);
toDateEl.addEventListener("change", loadRows);
// 다른 화면에서 외출·복귀가 생겼을 수 있으니 다시 보일 때 새로 읽는다
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") loadRows();
});
logoutBtn.addEventListener("click", () => signOutTo());

async function init() {
  const session = await requireStaff();
  if (!session) return;
  const { loginId, profile } = session;
  const role = profile.role;
  const managedGrades = Object.keys(profile.managedGrades || {}).filter((g) => profile.managedGrades[g]);
  const classGrades = Object.keys(profile.managedClasses || {}).filter((g) => Object.keys(profile.managedClasses[g] || {}).length > 0);
  if (role === "admin") state.allowedGrades = GRADES.slice();
  else if (role === "gradeManager") state.allowedGrades = GRADES.filter((g) => managedGrades.includes(g));
  else if (role === "teacher" && classGrades.length > 0) state.allowedGrades = GRADES.filter((g) => classGrades.includes(g));
  else {
    window.location.replace("./check.html");
    return;
  }
  navLoadingHint.hidden = true;
  accountsLink.hidden = role !== "admin";
  currentUserNameEl.textContent = profile.name || loginId;
  currentUserRoleBadgeEl.textContent = role;
  currentUserRoleBadgeEl.className = `role-badge role-badge--${role}`;

  const from = new Date();
  from.setDate(from.getDate() - (DEFAULT_DAYS - 1));
  fromDateEl.value = getDateKey(from);
  toDateEl.value = TODAY_KEY;
  fromDateEl.max = TODAY_KEY;
  toDateEl.max = TODAY_KEY;

  await loadStudents();
  await loadRows();
}

init();

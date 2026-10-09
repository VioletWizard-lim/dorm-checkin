// 방과후 일정(관리자·방과후 선생님, 사용자 요청)
//   1) 방과후 있는 날: 달력에서 날짜를 눌러 선택/해제(afterschool_dates), 기간·요일로 한 번에 선택/해제
//   2) 요일별 방과후 학생 등록: 요일을 고르고 학번 목록을 붙여넣으면 그 학생들의 그 요일을 켠다(사용자 요청)
//   3) 학생별 방과후 요일 일괄 등록: "학번[탭]요일" 줄을 붙여넣어 students.afterschool_days를 한 번에 바꾼다
// 현황판의 "오늘 방과후"·좌석 색은 방과후 있는 날에만, 학생의 방과후 요일대로 나온다(display.js·seat.js).
import { supabase, requireStaff, signOutTo, describeError, reportLoadError } from "./supabase-client.js";
import { getDateKey, escapeHtml } from "./util.js";
import { liveTable } from "./live-table.js";
import { groupStudentsByGrade } from "./adapters.js";
import { readSheetFile } from "./sheet-read.js";

const DAY_LABELS = ["월", "화", "수", "목", "금"];
const WEEK_HEADERS = ["일", "월", "화", "수", "목", "금", "토"];
const TODAY_KEY = getDateKey();

const logoutBtn = document.getElementById("logoutBtn");
const currentUserNameEl = document.getElementById("currentUserName");
const currentUserRoleBadgeEl = document.getElementById("currentUserRoleBadge");
const calendarEl = document.getElementById("calendar");
const monthTitleEl = document.getElementById("monthTitle");
const monthCountEl = document.getElementById("monthCount");
const prevMonthBtn = document.getElementById("prevMonthBtn");
const nextMonthBtn = document.getElementById("nextMonthBtn");
const thisMonthBtn = document.getElementById("thisMonthBtn");
const rangeFromEl = document.getElementById("rangeFrom");
const rangeToEl = document.getElementById("rangeTo");
const rangeDaysEl = document.getElementById("rangeDays");
const rangeSetBtn = document.getElementById("rangeSetBtn");
const rangeClearBtn = document.getElementById("rangeClearBtn");
const weekdayDaysEl = document.getElementById("weekdayDays");
const weekdayInput = document.getElementById("weekdayInput");
const weekdayReplaceCheck = document.getElementById("weekdayReplace");
const weekdayRemoveCheck = document.getElementById("weekdayRemove");
const weekdayPreviewEl = document.getElementById("weekdayPreview");
const weekdaySaveBtn = document.getElementById("weekdaySaveBtn");
const weekdayFileInput = document.getElementById("weekdayFile");
const weekdayFileNote = document.getElementById("weekdayFileNote");
const weekdayRosterBtn = document.getElementById("weekdayRosterBtn");
const daysInput = document.getElementById("daysInput");
const daysPreviewEl = document.getElementById("daysPreview");
const daysSaveBtn = document.getElementById("daysSaveBtn");

const today = new Date();
const state = {
  year: today.getFullYear(),
  month: today.getMonth(), // 0~11
  dates: new Set(), // 방과후 있는 날 "YYYY-MM-DD"
  loaded: false,
  busy: false,
  rangeDays: [true, true, true, true, true], // 기간 일괄의 요일(월~금)
  studentsBySid: new Map(),
  daysPlan: [], // 붙여넣기 미리보기에서 저장할 학생들
  weekdayDays: [false, false, false, false, false], // 요일별 등록에서 고른 요일
  weekdayPlan: [], // 요일별 등록에서 바뀌는 학생들 { student, flags }
};
let datesLive = null;
let studentsLive = null;

// ───────────── 달력 ─────────────

function monthDates(year, month) {
  const last = new Date(year, month + 1, 0).getDate();
  return Array.from({ length: last }, (_, i) => getDateKey(new Date(year, month, i + 1)));
}

function renderCalendar() {
  monthTitleEl.textContent = `${state.year}년 ${state.month + 1}월`;
  if (!state.loaded) return;
  const keys = monthDates(state.year, state.month);
  const count = keys.filter((k) => state.dates.has(k)).length;
  monthCountEl.textContent = `이 달 방과후 ${count}일`;
  const firstDow = new Date(state.year, state.month, 1).getDay();
  const cells = WEEK_HEADERS.map((d, i) => `<div class="afterschool-cal__head${i === 0 || i === 6 ? " is-weekend" : ""}">${d}</div>`);
  for (let i = 0; i < firstDow; i++) cells.push(`<div class="afterschool-cal__blank"></div>`);
  keys.forEach((key, i) => {
    const dow = (firstDow + i) % 7;
    const classes = ["afterschool-cal__day"];
    if (state.dates.has(key)) classes.push("is-on");
    if (key === TODAY_KEY) classes.push("is-today");
    if (dow === 0 || dow === 6) classes.push("is-weekend");
    cells.push(
      `<button type="button" class="${classes.join(" ")}" data-date="${key}" aria-pressed="${state.dates.has(key)}"${state.busy ? " disabled" : ""}>` +
        `<span class="afterschool-cal__num">${i + 1}</span>${state.dates.has(key) ? `<span class="afterschool-cal__tag">방과후</span>` : ""}</button>`
    );
  });
  calendarEl.innerHTML = cells.join("");
}

function setMonth(year, month) {
  const d = new Date(year, month, 1);
  state.year = d.getFullYear();
  state.month = d.getMonth();
  // 기간 일괄 칸도 보고 있는 달로 맞춘다
  const keys = monthDates(state.year, state.month);
  rangeFromEl.value = keys[0];
  rangeToEl.value = keys[keys.length - 1];
  renderCalendar();
}

async function withBusy(fn) {
  if (state.busy) return;
  state.busy = true;
  renderCalendar();
  rangeSetBtn.disabled = rangeClearBtn.disabled = true;
  try {
    await fn();
  } finally {
    state.busy = false;
    rangeSetBtn.disabled = rangeClearBtn.disabled = false;
    if (datesLive) await datesLive.refresh();
    renderCalendar();
  }
}

async function addDates(keys) {
  if (keys.length === 0) return true;
  const { error } = await supabase
    .from("afterschool_dates")
    .upsert(keys.map((date) => ({ date })), { onConflict: "date", ignoreDuplicates: true });
  if (error) {
    alert(`저장하지 못했습니다: ${describeError(error)}`);
    return false;
  }
  return true;
}

async function removeDates(keys) {
  if (keys.length === 0) return true;
  const { error } = await supabase.from("afterschool_dates").delete().in("date", keys);
  if (error) {
    alert(`저장하지 못했습니다: ${describeError(error)}`);
    return false;
  }
  return true;
}

calendarEl.addEventListener("click", (event) => {
  const btn = event.target.closest("[data-date]");
  if (!btn) return;
  const key = btn.dataset.date;
  withBusy(() => (state.dates.has(key) ? removeDates([key]) : addDates([key])));
});

prevMonthBtn.addEventListener("click", () => setMonth(state.year, state.month - 1));
nextMonthBtn.addEventListener("click", () => setMonth(state.year, state.month + 1));
thisMonthBtn.addEventListener("click", () => setMonth(today.getFullYear(), today.getMonth()));

// ───────────── 기간 일괄 ─────────────

function renderRangeDays() {
  rangeDaysEl.innerHTML = DAY_LABELS.map(
    (label, i) => `<button type="button" class="day-toggle${state.rangeDays[i] ? " is-active" : ""}" data-range-day="${i}">${label}</button>`
  ).join("");
}

rangeDaysEl.addEventListener("click", (event) => {
  const btn = event.target.closest("[data-range-day]");
  if (!btn) return;
  const i = Number(btn.dataset.rangeDay);
  state.rangeDays[i] = !state.rangeDays[i];
  renderRangeDays();
});

// 기간 안에서 고른 요일(월~금)에 해당하는 날짜들. 문제가 있으면 alert하고 null
function rangeKeys() {
  const from = rangeFromEl.value;
  const to = rangeToEl.value;
  if (!from || !to) {
    alert("시작일과 종료일을 모두 골라 주세요.");
    return null;
  }
  if (to < from) {
    alert("종료일이 시작일보다 빠릅니다.");
    return null;
  }
  if (!state.rangeDays.some(Boolean)) {
    alert("요일을 하나 이상 골라 주세요.");
    return null;
  }
  const keys = [];
  const [fy, fm, fd] = from.split("-").map(Number);
  for (let d = new Date(fy, fm - 1, fd); getDateKey(d) <= to; d.setDate(d.getDate() + 1)) {
    const idx = d.getDay() - 1; // 월=0 … 금=4
    if (idx >= 0 && idx <= 4 && state.rangeDays[idx]) keys.push(getDateKey(d));
    if (keys.length > 400) break; // 1년 남짓이면 충분
  }
  if (keys.length > 400) {
    alert("기간이 너무 깁니다. 1년 이내로 골라 주세요.");
    return null;
  }
  return keys;
}

rangeSetBtn.addEventListener("click", () => {
  const keys = rangeKeys();
  if (!keys) return;
  const adding = keys.filter((k) => !state.dates.has(k));
  if (adding.length === 0) {
    alert("이 기간의 고른 요일은 이미 모두 방과후 있는 날입니다.");
    return;
  }
  withBusy(() => addDates(adding));
});

rangeClearBtn.addEventListener("click", () => {
  const keys = rangeKeys();
  if (!keys) return;
  const removing = keys.filter((k) => state.dates.has(k));
  if (removing.length === 0) {
    alert("이 기간의 고른 요일에는 방과후 있는 날이 없습니다.");
    return;
  }
  if (!confirm(`${removing.length}일을 방과후 없는 날로 바꿀까요?`)) return;
  withBusy(() => removeDates(removing));
});

// ───────────── 저장(공통) ─────────────

// rows = [{ student, flags }]. 학생마다 요일이 달라 한 번에 못 하므로 열 명씩 나눠 동시에 저장한다.
// RLS가 건너뛰면 0행이라 실패로 본다. 실패한 학생 설명 목록을 돌려준다
async function saveStudentDays(rows) {
  const failures = [];
  for (let i = 0; i < rows.length; i += 10) {
    await Promise.all(
      rows.slice(i, i + 10).map(async ({ student, flags }) => {
        const { data, error } = await supabase
          .from("students")
          .update({ afterschool_days: flags })
          .eq("id", student.id)
          .select("id");
        if (error || data.length === 0) {
          failures.push(`${student.name}(${student.sid}): ${error ? describeError(error) : "권한이 없거나 이미 삭제된 학생입니다."}`);
        }
      })
    );
  }
  if (studentsLive) await studentsLive.refresh();
  return failures;
}

function studentLine(student, before, after) {
  return `<div class="bulk-preview__row">${escapeHtml(student.name || "이름 없음")} · ${escapeHtml(student.sid)} · ${escapeHtml(student.cls || "")} — ${
    before === after ? `${escapeHtml(after)} (그대로)` : `${escapeHtml(before)} → <b>${escapeHtml(after)}</b>`
  }</div>`;
}

// ───────────── 요일별 방과후 학생 등록 ─────────────

function renderWeekdayDays() {
  weekdayDaysEl.innerHTML = DAY_LABELS.map(
    (label, i) => `<button type="button" class="day-toggle${state.weekdayDays[i] ? " is-active" : ""}" data-weekday="${i}">${label}</button>`
  ).join("");
}

weekdayDaysEl.addEventListener("click", (event) => {
  const btn = event.target.closest("[data-weekday]");
  if (!btn) return;
  const i = Number(btn.dataset.weekday);
  state.weekdayDays[i] = !state.weekdayDays[i];
  renderWeekdayDays();
  renderWeekdayPreview();
});

// ── 방과후 출석부에서 학생 명단 찾기(사용자 요청) ──
// 머리글 줄(학번 / 학년·반·번호 / 이름 칸)을 찾아 그 칸으로 읽는다. 머리글이 없으면 칸마다 다섯 자리 학번을 찾는다.
function detectHeader(cells) {
  const norm = cells.map((c) => (c || "").replace(/\s+/g, ""));
  const find = (re) => norm.findIndex((c) => re.test(c));
  const h = {
    sid: find(/^학번$/),
    grade: find(/^학년$/),
    cls: find(/^반$/),
    num: -1,
    name: find(/^(이름|성명|학생명|학생이름)$/),
  };
  // "번호"가 둘이면(앞은 연번) 반 칸 뒤의 것이 학생 번호
  const nums = norm.flatMap((c, i) => (/^(번호|번)$/.test(c) ? [i] : []));
  h.num = nums.find((i) => i > h.cls) ?? nums[0] ?? -1;
  return h.sid >= 0 || h.name >= 0 || (h.grade >= 0 && h.cls >= 0) ? h : null;
}

const digitsOf = (text) => ((text || "").match(/\d+/) || [""])[0];

function extractRoster(rows) {
  const found = new Map(); // id → student
  const errors = [];
  const studentsByName = new Map();
  for (const s of state.studentsBySid.values()) {
    const list = studentsByName.get(s.name) || [];
    list.push(s);
    studentsByName.set(s.name, list);
  }
  let header = null;
  let anyRow = false;
  rows.forEach((cells, i) => {
    if (cells.every((c) => !c)) return;
    const h = detectHeader(cells);
    if (h) {
      header = h;
      return;
    }
    const label = `${i + 1}번째 줄`;
    const name = header && header.name >= 0 ? (cells[header.name] || "").trim() : "";
    let sids = [];
    if (header && header.sid >= 0) {
      const m = /\d{5}/.exec(cells[header.sid] || "");
      if (m) sids = [m[0]];
    } else if (header && header.grade >= 0 && header.cls >= 0 && header.num >= 0) {
      const g = digitsOf(cells[header.grade]);
      const c = digitsOf(cells[header.cls]);
      const n = digitsOf(cells[header.num]);
      if (g && c && n) sids = [`${g.slice(-1)}${c.padStart(2, "0")}${n.padStart(2, "0")}`];
    } else {
      sids = cells.flatMap((cell) => (cell || "").match(/(?<!\d)\d{5}(?!\d)/g) || []);
    }
    if (sids.length === 0 && name) {
      const matches = studentsByName.get(name) || [];
      anyRow = true;
      if (matches.length === 1) found.set(matches[0].id, matches[0]);
      else if (matches.length > 1) errors.push(`${label}: ${name} 학생이 여러 명입니다(동명이인). 학번 칸을 넣어 주세요.`);
      else errors.push(`${label}: ${name} 학생이 명단에 없습니다.`);
      return;
    }
    for (const sid of sids) {
      anyRow = true;
      const student = state.studentsBySid.get(sid);
      if (!student) errors.push(`${label}: 학번 ${sid}${name ? `(${name})` : ""} 학생이 명단에 없습니다.`);
      else {
        found.set(student.id, student);
        if (name && student.name && name !== student.name) {
          errors.push(`${label}: 학번 ${sid}은(는) 명단에 ${student.name}(으)로 있습니다(출석부: ${name}). 맞는지 확인해 주세요.`);
        }
      }
    }
  });
  if (!anyRow && rows.some((cells) => cells.some(Boolean))) errors.push("출석부에서 학생을 찾지 못했습니다(학번·학년/반/번호·이름 칸 확인).");
  return { found, errors };
}

function textToRows(text) {
  return text.split(/\r?\n/).map((line) => line.split("\t").map((c) => c.trim()));
}

function renderWeekdayPreview() {
  const picked = state.weekdayDays;
  const { found: listed, errors } = extractRoster(textToRows(weekdayInput.value));
  renderRosterButton();
  const hasDay = picked.some(Boolean);
  if (!hasDay && listed.size > 0) errors.push("요일을 하나 이상 골라 주세요.");

  const changes = [];
  const lines = [];
  let unchanged = 0;
  const removeMode = weekdayRemoveCheck.checked; // "빼기": 불러온 학생을 고른 요일에서 뺀다(잘못 넣은 것 되돌리기)
  if (hasDay) {
    for (const student of listed.values()) {
      const before = (student.afterschoolDays || []).slice(0, 5);
      const flags = DAY_LABELS.map((_, i) => (removeMode ? Boolean(before[i]) && !picked[i] : Boolean(before[i]) || picked[i]));
      if (flags.every((f, i) => f === Boolean(before[i]))) unchanged++;
      else changes.push({ student, flags, removed: removeMode });
      lines.push(studentLine(student, daysText(before), daysText(flags)));
    }
    // "명단 새로 바꾸기": 불러온 목록에 없는 학생은 고른 요일에서 뺀다
    if (weekdayReplaceCheck.checked && listed.size > 0) {
      for (const student of state.studentsBySid.values()) {
        if (listed.has(student.id)) continue;
        const before = (student.afterschoolDays || []).slice(0, 5);
        if (!picked.some((p, i) => p && before[i])) continue;
        const flags = DAY_LABELS.map((_, i) => Boolean(before[i]) && !picked[i]);
        changes.push({ student, flags, removed: true });
        lines.push(studentLine(student, daysText(before), daysText(flags)));
      }
    }
  }
  state.weekdayPlan = changes;

  const parts = [];
  if (lines.length > 0) {
    const removed = changes.filter((c) => c.removed).length;
    const summary = removeMode ? [] : [`추가 ${changes.length - removed}명`];
    if (unchanged) summary.push(removeMode ? `원래 없음 ${unchanged}명` : `이미 등록 ${unchanged}명`);
    if (removeMode) summary.unshift(`이 요일에서 빼기 ${removed}명`);
    if (weekdayReplaceCheck.checked) summary.push(`이 요일에서 빼기 ${removed}명`);
    parts.push(`<div class="bulk-preview__summary">${escapeHtml(summary.join(" · "))}</div>`);
    parts.push(`<div class="bulk-preview__list">${lines.join("")}</div>`);
  }
  if (errors.length > 0) {
    parts.push(`<div class="bulk-preview__errors">${errors.map((e) => `<div>${escapeHtml(e)}</div>`).join("")}</div>`);
  }
  weekdayPreviewEl.innerHTML = parts.join("");
  weekdaySaveBtn.disabled = changes.length === 0;
  weekdaySaveBtn.textContent = `저장 (${changes.length}명)`;
}

weekdayInput.addEventListener("input", () => {
  weekdayFileNote.textContent = "";
  renderWeekdayPreview();
});

// 출석부 파일(.xlsx·.csv)을 읽어 표를 입력칸에 넣는다 → 미리보기가 명단을 찾아 보여 준다
weekdayFileInput.addEventListener("change", async () => {
  const file = weekdayFileInput.files && weekdayFileInput.files[0];
  weekdayFileInput.value = "";
  if (!file) return;
  try {
    const rows = await readSheetFile(file);
    weekdayInput.value = rows.map((r) => r.join("\t")).join("\n").replace(/\n+$/, "");
    weekdayFileNote.textContent = `${file.name}에서 ${rows.filter((r) => r.some(Boolean)).length}줄을 읽었습니다.`;
    renderWeekdayPreview();
  } catch (error) {
    alert(error && error.message ? error.message : "파일을 읽지 못했습니다.");
  }
});

// ── 현재 명단 받기(CSV): 고른 요일(안 고르면 방과후 요일이 하나라도 있는 학생) ──
function currentRoster() {
  const picked = state.weekdayDays;
  const anyPicked = picked.some(Boolean);
  return Array.from(state.studentsBySid.values())
    .filter((s) => {
      const days = s.afterschoolDays || [];
      return anyPicked ? picked.some((p, i) => p && days[i]) : days.some(Boolean);
    })
    .sort((a, b) => (a.sid || "").localeCompare(b.sid || ""));
}

function renderRosterButton() {
  const dayText = DAY_LABELS.filter((_, i) => state.weekdayDays[i]).join("·");
  weekdayRosterBtn.textContent = `${dayText ? `${dayText}요일` : "전체"} 현재 명단 받기 (CSV, ${currentRoster().length}명)`;
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

weekdayRosterBtn.addEventListener("click", () => {
  const roster = currentRoster();
  if (roster.length === 0) {
    alert("받을 명단이 없습니다.");
    return;
  }
  const lines = [["학번", "이름", "반", ...DAY_LABELS].map(csvCell).join(",")];
  for (const s of roster) {
    const days = s.afterschoolDays || [];
    lines.push([s.sid, s.name, s.cls, ...DAY_LABELS.map((_, i) => (days[i] ? "O" : ""))].map(csvCell).join(","));
  }
  const blob = new Blob(["\uFEFF" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `afterschool-roster_${TODAY_KEY.replace(/-/g, "")}.csv`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
// 저장 방법(추가만 하기 / 명단 새로 바꾸기 / 빼기): weekdayReplaceCheck·weekdayRemoveCheck가 각 라디오
for (const radio of document.querySelectorAll('input[name="weekdayMode"]')) radio.addEventListener("change", renderWeekdayPreview);

weekdaySaveBtn.addEventListener("click", async () => {
  const rows = state.weekdayPlan;
  if (rows.length === 0) return;
  const removed = rows.filter((r) => r.removed).length;
  const dayText = DAY_LABELS.filter((_, i) => state.weekdayDays[i]).join("·");
  const removeMode = weekdayRemoveCheck.checked;
  const question = removeMode
    ? `불러온 학생 ${removed}명을 ${dayText}요일 방과후에서 뺍니다. 저장할까요?`
    : `불러온 목록에 없는 ${removed}명은 ${dayText}요일 방과후에서 빠집니다. 저장할까요?`;
  if (removed > 0 && !confirm(question)) return;
  weekdaySaveBtn.disabled = true;
  weekdaySaveBtn.textContent = "저장 중...";
  const failures = await saveStudentDays(rows);
  if (failures.length > 0) {
    alert(`다음 학생은 저장하지 못했습니다.\n${failures.join("\n")}`);
    renderWeekdayPreview();
    return;
  }
  weekdayInput.value = "";
  weekdayFileNote.textContent = "";
  renderWeekdayPreview();
  alert(`${rows.length}명의 방과후 요일을 저장했습니다(${dayText}).`);
});

// ───────────── 학생별 방과후 요일 일괄 등록 ─────────────

const FLAG_ON = /^(o|ㅇ|○|◯|v|y|1|예|있음)$/i;
const FLAG_OFF = /^(x|×|n|0|-|아니오|없음)?$/i;

function daysText(flags) {
  const on = DAY_LABELS.filter((_, i) => flags[i]);
  return on.length > 0 ? on.join("·") : "없음";
}

// 한 줄: [이름] 학번 (요일 글자 | 월~금 다섯 칸 O/X)
function parseDaysLine(parts) {
  const sidIndex = parts.findIndex((p) => /^\d{5}$/.test(p));
  if (sidIndex < 0) return { error: "학번(다섯 자리 숫자)을 찾지 못했습니다." };
  const sid = parts[sidIndex];
  const rest = parts.slice(sidIndex + 1);
  if (rest.length >= 5 && rest.slice(0, 5).every((p) => FLAG_ON.test(p) || FLAG_OFF.test(p))) {
    return { sid, flags: rest.slice(0, 5).map((p) => FLAG_ON.test(p)) };
  }
  const text = rest.join(" ").trim();
  if (!text || /^(없음|-|x)$/i.test(text)) return { sid, flags: [false, false, false, false, false] };
  if (/[토일]/.test(text)) return { sid, error: "방과후 요일은 월~금만 넣을 수 있습니다." };
  const flags = DAY_LABELS.map((d) => text.includes(d));
  if (!flags.some(Boolean)) return { sid, error: `요일을 읽지 못했습니다("${text}").` };
  return { sid, flags };
}

function renderDaysPreview() {
  const lines = daysInput.value.split(/\r?\n/);
  const rows = [];
  const errors = [];
  const seen = new Set();
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    const parts = (line.includes("\t") ? line.split("\t") : line.trim().split(/\s+/)).map((p) => p.trim());
    // 탭이 없으면 "10305 월 수 금"처럼 띄어 써도 되게, 학번 뒤를 다시 합쳐 읽는다
    const parsed = parseDaysLine(parts);
    const label = `${i + 1}번째 줄`;
    if (parsed.error) {
      errors.push(`${label}: ${parsed.sid ? `학번 ${parsed.sid} — ` : ""}${parsed.error}`);
      return;
    }
    const student = state.studentsBySid.get(parsed.sid);
    if (!student) {
      errors.push(`${label}: 학번 ${parsed.sid} 학생이 명단에 없습니다.`);
      return;
    }
    if (seen.has(student.id)) {
      errors.push(`${label}: 학번 ${parsed.sid}이(가) 위에 이미 있습니다.`);
      return;
    }
    seen.add(student.id);
    rows.push({ student, flags: parsed.flags });
  });
  state.daysPlan = rows;
  const parts = [];
  if (rows.length > 0) {
    parts.push(
      `<div class="bulk-preview__list">${rows
        .map(({ student, flags }) => studentLine(student, daysText(student.afterschoolDays || []), daysText(flags)))
        .join("")}</div>`
    );
  }
  if (errors.length > 0) {
    parts.push(`<div class="bulk-preview__errors">${errors.map((e) => `<div>${escapeHtml(e)}</div>`).join("")}</div>`);
  }
  daysPreviewEl.innerHTML = parts.join("");
  daysSaveBtn.disabled = rows.length === 0;
  daysSaveBtn.textContent = `일괄 저장 (${rows.length}명)`;
}

daysInput.addEventListener("input", renderDaysPreview);

daysSaveBtn.addEventListener("click", async () => {
  const rows = state.daysPlan;
  if (rows.length === 0) return;
  daysSaveBtn.disabled = true;
  daysSaveBtn.textContent = "저장 중...";
  const failures = await saveStudentDays(rows);
  if (failures.length > 0) {
    alert(`다음 학생은 저장하지 못했습니다.\n${failures.join("\n")}`);
    renderDaysPreview();
    return;
  }
  daysInput.value = "";
  renderDaysPreview();
  alert(`${rows.length}명의 방과후 요일을 저장했습니다.`);
});

// ───────────── 시작 ─────────────

async function init() {
  const session = await requireStaff();
  if (!session) return;
  const { loginId, profile } = session;
  const role = profile.role;
  if (role !== "admin" && role !== "afterschoolTeacher") {
    window.location.replace("./check.html");
    return;
  }
  currentUserNameEl.textContent = profile.name || loginId;
  currentUserRoleBadgeEl.textContent = role;
  currentUserRoleBadgeEl.className = `role-badge role-badge--${role}`;
  // 다른 화면 링크는 관리자에게만(방과후 선생님은 이 화면만 쓴다)
  for (const link of document.querySelectorAll("[data-admin-link]")) link.hidden = role !== "admin";

  renderRangeDays();
  renderWeekdayDays();
  setMonth(state.year, state.month);

  datesLive = liveTable({
    table: "afterschool_dates",
    select: "date",
    order: ["date"],
    onRows: (rows) => {
      state.dates = new Set(rows.map((r) => r.date));
      state.loaded = true;
      renderCalendar();
    },
    onError: reportLoadError,
  });

  studentsLive = liveTable({
    table: "students",
    order: ["id"],
    onRows: (rows) => {
      const byGrade = groupStudentsByGrade(rows);
      state.studentsBySid = new Map();
      for (const group of Object.values(byGrade)) {
        for (const [id, s] of Object.entries(group)) state.studentsBySid.set(s.sid, { id, ...s });
      }
      renderWeekdayPreview();
      renderDaysPreview();
    },
    onError: reportLoadError,
  });
}

logoutBtn.addEventListener("click", () => signOutTo());

init();

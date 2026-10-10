// 방과후 일정(관리자·방과후 선생님, 사용자 요청)
//   1) 방과후 있는 날: 달력에서 날짜를 눌러 선택/해제(afterschool_dates), 기간·요일로 한 번에 선택/해제
//   2) 요일별 방과후 학생 등록: 요일을 고르고 학번 목록을 붙여넣으면 그 학생들의 그 요일을 켠다(사용자 요청)
//   3) 학생별 방과후 요일 일괄 등록: "학번[탭]요일" 줄을 붙여넣어 students.afterschool_days를 한 번에 바꾼다
// 현황판의 "오늘 방과후"·좌석 색은 방과후 있는 날에만, 학생의 방과후 요일대로 나온다(display.js·seat.js).
import { supabase, requireStaff, signOutTo, describeError, reportLoadError } from "./supabase-client.js";
import { renderNav } from "./nav.js";
import { getDateKey, escapeHtml } from "./util.js";
import { liveTable } from "./live-table.js";
import { groupStudentsByGrade, STUDENT_COLUMNS } from "./adapters.js";
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
const columnMapWrap = document.getElementById("columnMapWrap");
const weekdayDetectNote = document.getElementById("weekdayDetectNote");
const columnMapTable = document.getElementById("columnMapTable");
const columnMapStatus = document.getElementById("columnMapStatus");
const columnMapResetBtn = document.getElementById("columnMapResetBtn");
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
  columnMap: null, // 칸 직접 고르기: 칸 번호 → 역할("sid"·"gcn"·"grade"·"cls"·"num"·"name"·""), 없으면 자동
  mapSignature: "", // 지금 입력한 표의 양식(첫 머리글 줄)
  mapRestored: false, // 지난번에 고른 칸을 불러왔는지
  detectKey: "", // 요일을 찾은 표(앞 몇 줄)
  detected: null, // 출석부에서 찾은 요일 { flags, from: "글자"|"날짜" }
  detectApplied: false, // 찾은 요일로 자동으로 골랐는지
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

// ── 방과후 출석부에서 학생 명단 찾기(사용자 요청: 학교마다 양식이 달라도 되게) ──
// 1) 자동: 머리글 줄(학번 / 학년·반·번호 / 학년·반·번호 따로 / 이름)을 찾아 그 칸으로 읽는다. 칸 이름은 띄어쓰기·괄호를 무시하고
//    비슷한 말도 받는다. 머리글이 없으면 칸마다 학번(10305, 1-3-5, 1학년 3반 5번)을 찾고, 없으면 명단의 이름과 같은 칸을 찾는다.
// 2) 직접: "칸 직접 고르기"에서 칸마다 역할을 고르면 그 칸으로만 읽는다. 고른 것은 같은 양식(첫 머리글 줄)마다 이 기기에 기억한다.
const COLUMN_ROLES = [
  ["", "—"],
  ["sid", "학번"],
  ["gcn", "학년·반·번호(한 칸)"],
  ["grade", "학년"],
  ["cls", "반"],
  ["num", "번호"],
  ["name", "이름"],
];
const COLUMN_MAP_KEY = "dormcheckin.afterschoolColumnMaps";

const headerText = (c) => (c || "").replace(/\([^)]*\)/g, "").replace(/\s+/g, "");

function detectHeader(cells) {
  const norm = cells.map(headerText);
  const find = (re) => norm.findIndex((c) => re.test(c));
  const h = {
    sid: find(/^학번$/),
    gcn: find(/^(학년반번호|학년반번|학년[-/·.]반[-/·.]번호?)$/),
    grade: find(/^학년$/),
    cls: find(/^(반|학급)$/),
    num: -1,
    name: find(/^(이름|성명|성함|학생명|학생이름|학생성명|학생)$/),
  };
  // "번호"가 둘이면(앞은 연번) 반 칸 뒤의 것이 학생 번호
  const nums = norm.flatMap((c, i) => (/^(번호|번|출석번호)$/.test(c) ? [i] : []));
  h.num = nums.find((i) => i > h.cls) ?? nums[0] ?? -1;
  return h.sid >= 0 || h.gcn >= 0 || h.name >= 0 || (h.grade >= 0 && h.cls >= 0) ? h : null;
}

const digitsOf = (text) => ((text || "").match(/\d+/) || [""])[0];

function buildSid(g, c, n) {
  if (!/^[1-3]$/.test(String(g)) || !(Number(c) >= 1 && Number(c) <= 99) || !(Number(n) >= 1 && Number(n) <= 99)) return null;
  return `${g}${String(Number(c)).padStart(2, "0")}${String(Number(n)).padStart(2, "0")}`;
}

// 한 칸에서 학번 찾기: 10305 / 1학년 3반 5번 / 1-3-5·1.03.05 / (학번·학년반번호 칸이면) 1305
function sidFromCell(text, { allowFour = false } = {}) {
  const t = (text || "").trim();
  let m = /(?<!\d)\d{5}(?!\d)/.exec(t);
  if (m) return m[0];
  m = /(\d)\s*학년\s*(\d{1,2})\s*반\s*(\d{1,2})\s*번?/.exec(t);
  if (m) return buildSid(m[1], m[2], m[3]);
  m = /(?<!\d)(\d)\s*[-–./·]\s*(\d{1,2})\s*[-–./·]\s*(\d{1,2})(?!\d)/.exec(t);
  if (m) return buildSid(m[1], m[2], m[3]);
  if (allowFour) {
    m = /^(\d)(\d)(\d{2})$/.exec(t);
    if (m) return buildSid(m[1], m[2], m[3]);
  }
  return null;
}

function studentsByNameMap() {
  const byName = new Map();
  for (const s of state.studentsBySid.values()) {
    const key = (s.name || "").replace(/\s+/g, "");
    const list = byName.get(key) || [];
    list.push(s);
    byName.set(key, list);
  }
  return byName;
}

// 칸 역할(header 또는 직접 고른 map)대로 한 줄을 읽는다 → { sids, name }
function readRowByRoles(cells, roles) {
  const cell = (role) => (roles[role] >= 0 ? (cells[roles[role]] || "").trim() : "");
  let sid = null;
  if (roles.sid >= 0) sid = sidFromCell(cell("sid"), { allowFour: true });
  if (!sid && roles.gcn >= 0) sid = sidFromCell(cell("gcn"), { allowFour: true });
  if (!sid && roles.grade >= 0 && roles.cls >= 0 && roles.num >= 0) {
    const g = digitsOf(cell("grade"));
    const c = digitsOf(cell("cls"));
    const n = digitsOf(cell("num"));
    if (g && c && n) sid = buildSid(g.slice(-1), c, n);
  }
  return { sids: sid ? [sid] : [], name: cell("name") };
}

function extractRoster(rows) {
  const found = new Map(); // id → student
  const errors = [];
  const byName = studentsByNameMap();
  const manual = state.columnMap && state.columnMap.some(Boolean) ? state.columnMap : null;
  const manualRoles = {};
  if (manual) manual.forEach((role, i) => role && manualRoles[role] === undefined && (manualRoles[role] = i));
  let header = null;
  let anyRow = false;

  const addByName = (rawName, label) => {
    const name = rawName.replace(/\s+/g, "");
    const matches = byName.get(name) || [];
    if (matches.length === 1) found.set(matches[0].id, matches[0]);
    else if (matches.length > 1) errors.push(`${label}: ${rawName} 학생이 여러 명입니다(동명이인). 학번 칸을 넣어 주세요.`);
    else errors.push(`${label}: ${rawName} 학생이 명단에 없습니다.`);
  };
  const addBySid = (sid, name, label) => {
    const student = state.studentsBySid.get(sid);
    if (!student) {
      errors.push(`${label}: 학번 ${sid}${name ? `(${name})` : ""} 학생이 명단에 없습니다.`);
      return;
    }
    found.set(student.id, student);
    if (name && student.name && name.replace(/\s+/g, "") !== student.name.replace(/\s+/g, "")) {
      errors.push(`${label}: 학번 ${sid}은(는) 명단에 ${student.name}(으)로 있습니다(출석부: ${name}). 맞는지 확인해 주세요.`);
    }
  };

  rows.forEach((cells, i) => {
    if (cells.every((c) => !c)) return;
    const label = `${i + 1}번째 줄`;
    const h = detectHeader(cells);
    if (h) {
      header = h;
      return;
    }
    let sids = [];
    let name = "";
    if (manual) {
      ({ sids, name } = readRowByRoles(cells, manualRoles));
      if (name.length > 10) name = ""; // 제목 줄 같은 긴 글은 이름이 아님
    } else if (header) {
      ({ sids, name } = readRowByRoles(cells, header));
    } else {
      // 한 칸에 학번이 여럿일 수 있다("10305 10302"). 다섯 자리가 없으면 1-3-5·1학년 3반 5번 모양
      sids = cells.flatMap((c) => (c || "").match(/(?<!\d)\d{5}(?!\d)/g) || [sidFromCell(c)].filter(Boolean));
      if (sids.length === 0) {
        // 머리글도 학번도 없으면 명단의 이름과 똑같은 칸을 찾는다(동명이인은 안내)
        for (const c of cells) {
          const key = (c || "").replace(/\s+/g, "");
          if (!key || !byName.has(key)) continue;
          anyRow = true;
          addByName(c.trim(), label);
        }
        return;
      }
    }
    if (sids.length === 0) {
      if (name) {
        anyRow = true;
        addByName(name, label);
      }
      return;
    }
    anyRow = true;
    for (const sid of sids) addBySid(sid, name, label);
  });
  if (!anyRow && rows.some((cells) => cells.some(Boolean))) {
    errors.push(
      manual
        ? "고른 칸에서 학생을 찾지 못했습니다. 칸 지정을 확인해 주세요."
        : '출석부에서 학생을 찾지 못했습니다. 아래 "칸 직접 고르기"에서 학번·이름 칸을 골라 주세요.'
    );
  }
  return { found, errors, anyRow, manual: Boolean(manual) };
}

// ── 칸 직접 고르기 ──
function loadColumnMaps() {
  try {
    return JSON.parse(localStorage.getItem(COLUMN_MAP_KEY) || "{}") || {};
  } catch {
    return {};
  }
}

function saveColumnMap(signature, map) {
  if (!signature) return;
  const maps = loadColumnMaps();
  delete maps[signature];
  if (map && map.some(Boolean)) maps[signature] = map;
  const keys = Object.keys(maps);
  for (const key of keys.slice(0, Math.max(0, keys.length - 20))) delete maps[key]; // 최근 20개 양식만
  try {
    localStorage.setItem(COLUMN_MAP_KEY, JSON.stringify(maps));
  } catch {
    // 저장소를 못 쓰면 기억만 안 함
  }
}

// 양식 구별: 칸이 둘 이상인 첫 줄(보통 머리글)
function sheetSignature(rows) {
  const first = rows.find((cells) => cells.filter(Boolean).length >= 2);
  return first ? first.map(headerText).join("|") : "";
}

// 입력이 바뀔 때: 다른 양식이면 그 양식에서 지난번에 고른 칸을 불러오고, 없으면 자동으로
// ── 출석부에서 요일 찾기(사용자 요청) ──
// 1) 요일 글자: "월요일", "월·수요일", "(월)", "(코딩반 · 월)", "요일: 화, 목", "매주 월수" — 이름 속 글자(김수빈의 "수")는 안 씀
// 2) 없으면 머리글 줄의 날짜 칸(10/5, 10.12, 10월 19일, 2026-10-05)의 요일
const WEEKDAY_CHARS = "월화수목금";
const DAY_LIST = "(?<![가-힣])([월화수목금](?:\\s*[·,、/\\s]\\s*[월화수목금])*)"; // 낱말 중간(이수 화요일의 "수")에서 시작하지 않게
const WEEKDAY_PATTERNS = [
  new RegExp(`${DAY_LIST}\\s*요일`, "g"),
  new RegExp(`요일\\s*[:：]?\\s*${DAY_LIST}(?![가-힣])`, "g"),
  new RegExp(`[(\\[]\\s*${DAY_LIST}\\s*[)\\]]`, "g"),
  new RegExp(`[·|/]\\s*${DAY_LIST}\\s*[)\\]]`, "g"),
  new RegExp(`매주\\s*([월화수목금](?:\\s*[·,、/]?\\s*[월화수목금])*)(?![가-힣])`, "g"),
];

function dateWeekday(cell, today) {
  const m = /^(?:(\d{4})\s*[-./년]\s*)?(\d{1,2})\s*[-./월]\s*(\d{1,2})\s*일?\.?\s*(?:\([월화수목금토일]\))?$/.exec((cell || "").trim());
  if (!m) return -1;
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return -1;
  let year = m[1] ? Number(m[1]) : today.getFullYear();
  let date = new Date(year, month - 1, day);
  // 연도가 없으면 오늘에서 반년 넘게 뒤인 날짜는 작년 것으로 본다(1~2월에 지난 2학기 출석부)
  if (!m[1] && date - today > 183 * 86400000) date = new Date(--year, month - 1, day);
  if (date.getMonth() !== month - 1) return -1;
  return date.getDay() - 1; // 월=0 … 금=4, 주말은 -1·5
}

function detectWeekdays(rows) {
  const flags = [false, false, false, false, false];
  const text = rows.map((cells) => cells.filter(Boolean).join(" ")).join("\n");
  for (const re of WEEKDAY_PATTERNS) {
    for (const m of text.matchAll(re)) {
      for (const ch of m[1]) {
        const i = WEEKDAY_CHARS.indexOf(ch);
        if (i >= 0) flags[i] = true;
      }
    }
  }
  if (flags.some(Boolean)) return { flags, from: "글자" };
  const today = new Date();
  const headerRows = rows.filter((cells) => detectHeader(cells) || cells.filter(Boolean).length >= 3).slice(0, 3);
  const seen = [];
  for (const cells of headerRows) {
    for (const c of cells) {
      const wd = dateWeekday(c, today);
      if (wd !== -1 || /^\d{1,2}\s*[-./월]\s*\d{1,2}/.test((c || "").trim())) seen.push(wd);
    }
    if (seen.length) break;
  }
  // 날짜가 모두 평일일 때만 믿는다(엉뚱한 숫자를 날짜로 읽은 경우 걸러짐)
  if (seen.length && seen.every((wd) => wd >= 0 && wd <= 4)) {
    for (const wd of seen) flags[wd] = true;
    return { flags, from: "날짜" };
  }
  return null;
}

// 입력한 표가 바뀌면 요일을 다시 찾는다. 아직 요일을 안 골랐으면 찾은 요일로 고르고, 이미 골랐으면 바꾸지 않고 안내만
function syncDetectedWeekdays(rows) {
  const key = rows.filter((cells) => cells.some(Boolean)).slice(0, 4).map((cells) => cells.join("\t")).join("\n");
  if (key === state.detectKey) return;
  state.detectKey = key;
  state.detected = key ? detectWeekdays(rows) : null;
  state.detectApplied = false;
  if (state.detected && !state.weekdayDays.some(Boolean)) {
    state.weekdayDays = state.detected.flags.slice();
    state.detectApplied = true;
    renderWeekdayDays();
  }
}

function renderDetectNote() {
  const d = state.detected;
  weekdayDetectNote.hidden = !d;
  if (!d) return;
  const text = daysText(d.flags);
  const same = d.flags.every((f, i) => f === state.weekdayDays[i]);
  const from = d.from === "날짜" ? "출석 날짜" : "출석부 글자";
  if (state.detectApplied && same) {
    weekdayDetectNote.className = "weekday-detect";
    weekdayDetectNote.innerHTML = `${escapeHtml(from)}에서 요일을 찾아 <b>${escapeHtml(text)}</b>을(를) 골랐습니다. 맞는지 확인하세요.`;
  } else if (same) {
    weekdayDetectNote.className = "weekday-detect";
    weekdayDetectNote.innerHTML = `출석부의 요일(<b>${escapeHtml(text)}</b>)과 고른 요일이 같습니다.`;
  } else {
    weekdayDetectNote.className = "weekday-detect weekday-detect--warn";
    weekdayDetectNote.innerHTML = `출석부에는 <b>${escapeHtml(text)}</b>요일로 보입니다(지금 고른 요일: ${escapeHtml(daysText(state.weekdayDays))}). ` +
      `<button type="button" class="btn-secondary btn-small" id="applyDetectedBtn">${escapeHtml(text)}요일로 바꾸기</button>`;
  }
}

function syncColumnMap(rows) {
  const signature = sheetSignature(rows);
  if (signature === state.mapSignature) return;
  state.mapSignature = signature;
  const saved = signature ? loadColumnMaps()[signature] : null;
  state.columnMap = saved || null;
  state.mapRestored = Boolean(saved);
}

function renderColumnMap(rows, result) {
  const sample = rows.filter((cells) => cells.some(Boolean)).slice(0, 8);
  columnMapWrap.hidden = sample.length === 0;
  if (sample.length === 0) return;
  const cols = Math.min(15, Math.max(...sample.map((c) => c.length)));
  const map = state.columnMap || [];
  const select = (i) =>
    `<select data-col-role="${i}">${COLUMN_ROLES.map(
      ([value, label]) => `<option value="${value}"${(map[i] || "") === value ? " selected" : ""}>${label}</option>`
    ).join("")}</select>`;
  columnMapTable.innerHTML =
    `<thead><tr>${Array.from({ length: cols }, (_, i) => `<th>${select(i)}</th>`).join("")}</tr></thead>` +
    `<tbody>${sample
      .map((cells) => `<tr>${Array.from({ length: cols }, (_, i) => `<td>${escapeHtml(cells[i] || "")}</td>`).join("")}</tr>`)
      .join("")}</tbody>`;
  columnMapStatus.textContent = result.manual
    ? state.mapRestored
      ? "지금: 지난번에 이 양식에서 고른 칸으로 찾는 중"
      : "지금: 고른 칸으로 찾는 중"
    : "지금: 자동으로 찾는 중";
  columnMapResetBtn.hidden = !result.manual;
  // 자동으로 아무도 못 찾으면 펼쳐서 직접 고르게 한다
  if (!result.manual && !result.anyRow) columnMapWrap.open = true;
}

columnMapTable.addEventListener("change", (event) => {
  const sel = event.target.closest("[data-col-role]");
  if (!sel) return;
  const map = (state.columnMap || []).slice();
  map[Number(sel.dataset.colRole)] = sel.value;
  state.columnMap = map.some(Boolean) ? map : null;
  state.mapRestored = false;
  saveColumnMap(state.mapSignature, state.columnMap);
  renderWeekdayPreview();
});

weekdayDetectNote.addEventListener("click", (event) => {
  if (!event.target.closest("#applyDetectedBtn") || !state.detected) return;
  state.weekdayDays = state.detected.flags.slice();
  state.detectApplied = true;
  renderWeekdayDays();
  renderWeekdayPreview();
});

columnMapResetBtn.addEventListener("click", () => {
  state.columnMap = null;
  state.mapRestored = false;
  saveColumnMap(state.mapSignature, null);
  renderWeekdayPreview();
});

function textToRows(text) {
  return text.split(/\r?\n/).map((line) => line.split("\t").map((c) => c.trim()));
}

function renderWeekdayPreview() {
  const rows = textToRows(weekdayInput.value);
  syncColumnMap(rows);
  syncDetectedWeekdays(rows); // 요일을 자동으로 고를 수 있어 picked는 그 뒤에 읽는다
  renderDetectNote();
  const picked = state.weekdayDays;
  const result = extractRoster(rows);
  const { found: listed, errors } = result;
  renderColumnMap(rows, result);
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
  // 방과후 선생님은 이 화면만 쓰므로 메뉴에 다른 화면이 없다
  renderNav(profile);

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
    select: STUDENT_COLUMNS,
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

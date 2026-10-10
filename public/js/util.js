// 여러 화면이 같이 쓰는 작은 도우미(예전에는 화면마다 같은 코드를 복사해 두었음).

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// 화면을 연 컴퓨터의 로컬 날짜 "YYYY-MM-DD"(학교 PC는 KST)
export function getDateKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// 헤더의 오늘 날짜: "2026년 10월 8일 (목)"
export function formatToday() {
  const days = ["일", "월", "화", "수", "목", "금", "토"];
  const now = new Date();
  return `${now.getFullYear()}년 ${now.getMonth() + 1}월 ${now.getDate()}일 (${days[now.getDay()]})`;
}

// 시각(timestamptz 문자열·Date·밀리초) → "HH:MM"
export function formatTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

// 명령퇴사 기간(leave_from~leave_to)이 그 날짜를 포함하는지
export function isOnLeave(student, dateKey) {
  const leave = student && student.leaveOfAbsence;
  if (!leave || !leave.from || !leave.to) return false;
  return dateKey >= leave.from && dateKey <= leave.to;
}

// 외출 금지 기간(ban_from~ban_to, 학년부장·관리자가 정함)이 그 날짜를 포함하면 { from, to, reason }, 아니면 null
export function outingBanOn(student, dateKey) {
  const ban = student && student.outingBan;
  return ban && ban.from && ban.to && dateKey >= ban.from && dateKey <= ban.to ? ban : null;
}

// "외출 금지 ~10/13" (+ " · 사유")
export function outingBanText(ban, { withReason = false } = {}) {
  const until = `${Number(ban.to.slice(5, 7))}/${Number(ban.to.slice(8, 10))}`;
  return `외출 금지 ~${until}${withReason && ban.reason ? ` · ${ban.reason}` : ""}`;
}

// 오늘의 방과후 요일 칸(월=0 … 금=4), 주말이면 null
export function todayWeekdayIndex() {
  const idx = new Date().getDay() - 1;
  return idx >= 0 && idx <= 4 ? idx : null;
}

// 붙여넣기 입력칸에서 Tab 키로 탭 문자를 넣는다(엑셀 형식 직접 입력용)
export function insertTabOnKeydown(event) {
  if (event.key !== "Tab" || event.shiftKey) return;
  event.preventDefault();
  const el = event.target;
  const start = el.selectionStart;
  const end = el.selectionEnd;
  el.value = el.value.slice(0, start) + "\t" + el.value.slice(end);
  el.selectionStart = el.selectionEnd = start + 1;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

// CSV 칸 하나(엑셀용): 수식으로 읽히지 않게 =·+·-·@로 시작하면 앞에 '를 붙이고, 쉼표·따옴표·줄바꿈이 있으면 따옴표로 감싼다
export function csvCell(value) {
  let text = String(value ?? "");
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

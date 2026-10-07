// 학교 기준(KST) 날짜 도우미
const kstDate = (offsetDays = 0) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date(Date.now() + offsetDays * 86400000));

export const todayKst = () => kstDate(0);
export const yesterdayKst = () => kstDate(-1);
export const kstDatePlus = (days) => kstDate(days);

// 월=0 ... 금=4, 주말이면 null (afterschool_days 순서)
export function kstWeekdayIndex() {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Seoul", weekday: "short" }).format(new Date());
  const idx = ["Mon", "Tue", "Wed", "Thu", "Fri"].indexOf(name);
  return idx >= 0 ? idx : null;
}

// window.confirm/prompt 응답을 차례대로 정해 둔다. answers: true/false(confirm) 또는 문자열·null(prompt)
export function answerDialogs(page, answers) {
  const queue = [...answers];
  const seen = [];
  page.on("dialog", async (dialog) => {
    seen.push({ type: dialog.type(), message: dialog.message() });
    const answer = queue.length > 0 ? queue.shift() : undefined;
    if (dialog.type() === "alert") return dialog.accept();
    if (answer === false || answer === null || answer === undefined) return dialog.dismiss();
    if (dialog.type() === "prompt") return dialog.accept(answer === true ? "" : String(answer));
    return dialog.accept();
  });
  return seen;
}

// 화면에 뜬 alert 문구를 모은다(answerDialogs와 함께 쓰지 말 것)
export function collectAlerts(page) {
  const alerts = [];
  page.on("dialog", async (dialog) => {
    alerts.push(dialog.message());
    await dialog.accept();
  });
  return alerts;
}

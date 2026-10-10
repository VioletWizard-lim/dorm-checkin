import { test, expect } from "./fixtures.mjs";

// 역할별: 직접 열었을 때 어디로 가는지, 헤더에 어떤 메뉴가 보이는지
const CASES = [
  { who: "admin01", pages: { "check.html": "check.html", "display.html": "display.html", "seat.html": "seat.html", "students.html": "students.html", "history.html": "history.html", "accounts.html": "accounts.html", "afterschool.html": "afterschool.html" }, manage: true, accounts: true, history: true },
  { who: "dorm01", pages: { "students.html": "students.html", "history.html": "check.html", "accounts.html": "check.html", "afterschool.html": "check.html", "seat.html": "seat.html" }, manage: true, accounts: false, history: false },
  { who: "gm01", pages: { "students.html": "students.html", "history.html": "history.html", "accounts.html": "check.html", "afterschool.html": "check.html", "display.html": "display.html" }, manage: true, accounts: false, history: true },
  { who: "teacher01", pages: { "students.html": "check.html", "history.html": "check.html", "accounts.html": "check.html", "display.html": "display.html" }, manage: false, accounts: false, history: false },
  { who: "homeroom01", pages: { "students.html": "students.html", "history.html": "history.html", "accounts.html": "check.html" }, manage: true, accounts: false, history: true },
  { who: "super01", pages: { "display.html": "display.html", "seat.html": "seat.html", "students.html": "check.html", "history.html": "check.html", "accounts.html": "check.html" }, manage: false, accounts: false, history: false },
];

for (const c of CASES) {
  test(`${c.who}: 화면 접근과 메뉴`, async ({ openAs, page }) => {
    await openAs(c.who, "/check.html");
    await expect(page.locator("#navLoadingHint")).toBeHidden();
    await expect(page.locator("#manageLink")).toBeVisible({ visible: c.manage });
    await expect(page.locator("#accountsLink")).toBeVisible({ visible: c.accounts });
    await expect(page.locator("#afterschoolLink")).toBeVisible({ visible: c.accounts }); // 방과후 일정도 관리자만
    await expect(page.locator("#historyLink")).toBeVisible({ visible: c.history });
    // 현황판·좌석 배치판은 모든 교직원(자습 감독 포함)이 볼 수 있다
    await expect(page.locator("#displayLink")).toBeVisible();
    await expect(page.locator("#seatLink")).toBeVisible();
    // 메뉴 순서는 고정: 외출 체크(또는 학생 상태) → 현황판 → 좌석 배치판 → 학생 명단 관리 → 외출 기록 → 방과후 일정 → 계정 관리
    // 체크 화면 이름: 외출 체크를 할 수 있는 관리자·학년부장·담임은 "외출 체크", 그 밖은 "학생 상태"(사용자 요청)
    const checkLabel = c.history ? "외출 체크" : "학생 상태";
    const menu = [
      checkLabel,
      "현황판",
      "좌석 배치판",
      ...(c.manage ? ["학생 명단 관리"] : []),
      ...(c.history ? ["외출 기록"] : []),
      ...(c.accounts ? ["방과후 일정", "계정 관리"] : []),
    ];
    await expect(page.locator("#appNav a")).toHaveText(menu);
    await expect(page.locator("#checkLink")).toHaveAttribute("aria-current", "page");
    await expect(page.locator("#pageTitle")).toHaveText(c.history ? "기숙사 외출 체크" : "학생 상태");

    for (const [target, landing] of Object.entries(c.pages)) {
      await page.goto(`/${target}`);
      await expect(page).toHaveURL(new RegExp(`/${landing.replace(".", "\\.")}$`));
      if (landing === target && target !== "check.html") {
        await expect(page.locator("#currentUserName")).not.toHaveText("");
        // 메뉴는 어느 화면에서나 같다(사용자 요청) — 지금 화면도 빠지지 않고 강조만 된다
        await expect(page.locator("#appNav a")).toHaveText(menu);
        await expect(page.locator("#appNav a.is-current")).toHaveAttribute("href", `./${target}`);
        await expect(page.locator("#appNav [aria-current=page]")).toHaveCount(1);
      }
    }
  });
}

import { test, expect } from "./fixtures.mjs";

// 역할별: 직접 열었을 때 어디로 가는지, 헤더에 어떤 메뉴가 보이는지
const CASES = [
  { who: "admin01", pages: { "check.html": "check.html", "display.html": "display.html", "seat.html": "seat.html", "students.html": "students.html", "history.html": "history.html", "accounts.html": "accounts.html" }, manage: true, accounts: true, history: true },
  { who: "dorm01", pages: { "students.html": "students.html", "history.html": "check.html", "accounts.html": "check.html", "seat.html": "seat.html" }, manage: true, accounts: false, history: false },
  { who: "gm01", pages: { "students.html": "students.html", "history.html": "history.html", "accounts.html": "check.html", "display.html": "display.html" }, manage: true, accounts: false, history: true },
  { who: "teacher01", pages: { "students.html": "check.html", "history.html": "check.html", "accounts.html": "check.html", "display.html": "display.html" }, manage: false, accounts: false, history: false },
  { who: "homeroom01", pages: { "students.html": "students.html", "history.html": "history.html", "accounts.html": "check.html" }, manage: true, accounts: false, history: true },
  { who: "super01", pages: { "display.html": "check.html", "seat.html": "check.html", "students.html": "check.html", "history.html": "check.html", "accounts.html": "check.html" }, manage: false, accounts: false, history: false },
];

for (const c of CASES) {
  test(`${c.who}: 화면 접근과 메뉴`, async ({ openAs, page }) => {
    await openAs(c.who, "/check.html");
    await expect(page.locator("#navLoadingHint")).toBeHidden();
    await expect(page.locator("#manageLink")).toBeVisible({ visible: c.manage });
    await expect(page.locator("#accountsLink")).toBeVisible({ visible: c.accounts });
    await expect(page.locator("#historyLink")).toBeVisible({ visible: c.history });
    const supervisor = c.who === "super01";
    await expect(page.locator("#displayLink")).toBeVisible({ visible: !supervisor });
    await expect(page.locator("#seatLink")).toBeVisible({ visible: !supervisor });

    for (const [target, landing] of Object.entries(c.pages)) {
      await page.goto(`/${target}`);
      await expect(page).toHaveURL(new RegExp(`/${landing.replace(".", "\\.")}$`));
      if (landing === target && target !== "check.html") {
        await expect(page.locator("#currentUserName")).not.toHaveText("");
        // 권한에 따라 숨기는 링크만 id가 있다(그 화면에 접근할 수 있으면 항상 보이는 링크는 id 없음).
        for (const [selector, expected] of [["#manageLink", c.manage], ["#accountsLink", c.accounts], ["#historyLink", c.history]]) {
          if ((await page.locator(selector).count()) > 0) {
            await expect(page.locator(selector)).toBeVisible({ visible: expected });
          }
        }
      }
    }
  });
}

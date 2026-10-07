import { test, expect } from "./fixtures.mjs";
import { PASSWORD } from "../harness/seed.mjs";
import { WRONG_LOGIN } from "./helpers.mjs";

test.describe("로그인", () => {
  test("아이디·비밀번호가 맞으면 체크 화면으로 이동하고, 대문자로 입력해도 된다", async ({ page }) => {
    await page.goto("/login.html");
    await page.fill("#userId", "Admin01");
    await page.fill("#password", PASSWORD);
    await page.check("#rememberMe");
    await page.click("#submitBtn");
    await expect(page).toHaveURL(/\/check\.html$/);
    await expect(page.locator("#currentUserName")).toHaveText("관리자");
    expect(await page.evaluate(() => localStorage.getItem("dormcheckin.savedUserId"))).toBe("Admin01");
  });

  test("틀린 비밀번호·형식 오류·빈 칸은 안내 문구를 보여준다", async ({ page }) => {
    await page.goto("/login.html");
    await page.click("#submitBtn");
    await expect(page.locator("#errorBox")).toHaveText("아이디와 비밀번호를 입력해 주세요.");

    await page.fill("#userId", "admin@01");
    await page.fill("#password", "x");
    await page.click("#submitBtn");
    await expect(page.locator("#errorBox")).toHaveText("아이디는 영문과 숫자만 사용할 수 있습니다.");

    await page.fill("#userId", "admin01");
    await page.fill("#password", "wrong-password");
    await page.click("#submitBtn");
    await expect(page.locator("#errorBox")).toHaveText(WRONG_LOGIN);
    await expect(page).toHaveURL(/\/login\.html$/);
  });

  test("삭제(로그인 차단)된 계정은 로그인할 수 없다", async ({ page }) => {
    await page.goto("/login.html");
    await page.fill("#userId", "gone01");
    await page.fill("#password", PASSWORD);
    await page.click("#submitBtn");
    await expect(page.locator("#errorBox")).toHaveText("삭제(비활성화)된 계정입니다. 관리자에게 문의해 주세요.");
  });

  test("이미 로그인돼 있으면 로그인 화면에서 바로 체크 화면으로 간다", async ({ openAs, page }) => {
    await openAs("teacher01", "/login.html");
    await expect(page).toHaveURL(/\/check\.html$/);
  });

  test("로그아웃하면 이 기기만 로그아웃되고 다시 들어가려면 로그인해야 한다", async ({ openAs, openOtherAs, page }) => {
    const otherDevice = await openOtherAs("admin01", "/check.html");
    await openAs("admin01", "/check.html");
    await expect(page.locator("#currentUserName")).toHaveText("관리자");
    await page.click("#logoutBtn");
    await expect(page).toHaveURL(/\/login\.html$/);
    await page.goto("/check.html");
    await expect(page).toHaveURL(/\/login\.html$/);
    // 다른 기기(전자칠판 등)의 로그인은 그대로
    await otherDevice.reload();
    await expect(otherDevice.locator("#currentUserName")).toHaveText("관리자");
  });

  test("앱에서 비활성화된 계정의 남은 세션은 화면을 열자마자 로그아웃된다", async ({ env, openAs, page }) => {
    await env.sql("update public.profiles set disabled = true where login_id = 'teacher01'");
    await openAs("teacher01", "/check.html");
    await expect(page).toHaveURL(/\/login\.html\?disabled=1$/);
    await expect(page.locator("#errorBox")).toHaveText("삭제(비활성화)된 계정입니다. 관리자에게 문의해 주세요.");
  });
});

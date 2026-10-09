import { test, expect } from "./fixtures.mjs";
import { PASSWORD, ROOM, staffId } from "../harness/seed.mjs";
import { answerDialogs, collectAlerts, tryLogin, WRONG_LOGIN } from "./helpers.mjs";

const row = (page, loginId) =>
  page.locator("#accountList .student-card").filter({ has: page.locator(".student-name", { hasText: new RegExp(`^${loginId}$`) }) });

async function profile(env, loginId) {
  return (await env.sql("select * from public.profiles where login_id = $1", [loginId]))[0] ?? null;
}

test.describe("계정 관리", () => {
  test("관리자만 들어올 수 있고 목록에 역할·담당 범위가 보인다", async ({ openAs, page }) => {
    await openAs("admin01", "/accounts.html");
    // 역할별로 묶어서 보여 준다(관리자 → 학년부장 → 담임 → 일반 교사 → 자습 감독 → 기숙사부 → 삭제됨)
    await expect(page.locator("#accountList .student-name")).toHaveText([
      "admin01", "gm01", "homeroom01", "teacher01", "super01", "dorm01", "gone01",
    ]);
    await expect(page.locator("#accountList .account-group__title")).toHaveText([
      "관리자 (1명)", "학년부장 (1명)", "담임 (1명)", "일반 교사 (담당 반 없음) (1명)", "자습 감독 (1명)", "기숙사부 (1명)", "삭제됨 (1명)",
    ]);
    await expect(row(page, "admin01")).toContainText("본인 계정");
    await expect(row(page, "admin01").locator("button")).toHaveCount(0);
    await expect(row(page, "gone01")).toContainText("삭제됨");
    await expect(row(page, "gm01")).toContainText("1학년 · 1학년실");
    await expect(row(page, "homeroom01")).toContainText("담당 반: 1학년 3반");
    await expect(page.locator("#bulkResetBtn")).toHaveText("비밀번호 일괄 재발급 (5명)");
  });

  test("분류 탭으로 역할별 계정만 볼 수 있고, 역할을 바꾸면 분류도 바뀐다", async ({ openAs, page }) => {
    await openAs("admin01", "/accounts.html");
    const chips = page.locator("#accountFilter [data-account-filter]");
    await expect(chips).toHaveText([
      "전체 7", "관리자 1", "학년부장 1", "담임 1", "일반 교사 (담당 반 없음) 1", "자습 감독 1", "기숙사부 1", "삭제됨 1",
    ]);
    await chips.filter({ hasText: "일반 교사" }).click();
    await expect(page.locator("#accountList .student-name")).toHaveText(["teacher01"]);

    // 일반 교사를 자습 감독으로 바꾸면 그 분류가 비어서 전체로 돌아간다
    await row(page, "teacher01").getByRole("button", { name: "정보 수정" }).click();
    await page.click("[data-edit-set-role='studyHallSupervisor']");
    await page.click("[data-save-role]");
    await expect(chips.filter({ hasText: "전체" })).toHaveClass(/is-active/);
    await expect(chips.filter({ hasText: "자습 감독" })).toHaveText("자습 감독 2");
    await expect(chips.filter({ hasText: "일반 교사" })).toHaveCount(0);
    await chips.filter({ hasText: "자습 감독" }).click();
    await expect(page.locator("#accountList .student-name")).toHaveText(["super01", "teacher01"]);
  });

  test("정보 수정: 이름·역할·담당 학년/실·담당 반", async ({ env, openAs, page }) => {
    await openAs("admin01", "/accounts.html");
    await row(page, "teacher01").getByRole("button", { name: "정보 수정" }).click();
    await page.fill("[data-edit-name]", "2학년부장");
    await page.click("[data-edit-set-role='gradeManager']");
    await page.click("[data-edit-grade='2']");
    await page.click(`[data-edit-room='${ROOM.second}']`);
    await page.click("[data-save-role]");
    await expect(row(page, "teacher01")).toContainText("2학년 · 2·3학년실");
    expect(await profile(env, "teacher01")).toMatchObject({
      name: "2학년부장",
      role: "gradeManager",
      managed_grades: [2],
      managed_rooms: [ROOM.second],
      managed_classes: [],
    });

    // 담임으로 바꾸면 학년/실 담당은 비워지고 담당 반이 저장된다
    await row(page, "teacher01").getByRole("button", { name: "정보 수정" }).click();
    await page.click("[data-edit-set-role='teacher']");
    await page.click("[data-edit-class='1'][data-edit-class-value='1학년 1반']");
    await page.click("[data-save-role]");
    await expect(row(page, "teacher01")).toContainText("담당 반: 1학년 1반");
    expect(await profile(env, "teacher01")).toMatchObject({
      role: "teacher",
      managed_grades: [],
      managed_rooms: [],
      managed_classes: [{ grade: 1, cls: "1학년 1반" }],
    });
  });

  test("저장이 거부되면 알림을 띄우고 편집 폼을 유지한다", async ({ env, openAs, page }) => {
    const alerts = collectAlerts(page);
    await openAs("admin01", "/accounts.html");
    await row(page, "teacher01").getByRole("button", { name: "정보 수정" }).click();
    await env.sql("update public.profiles set role = 'teacher' where login_id = 'admin01'"); // 그 사이 관리자 권한을 잃음
    await page.click("[data-edit-set-role='dormStaff']");
    await page.click("[data-save-role]");
    await expect.poll(() => alerts.at(-1)).toBe("저장에 실패했습니다: 권한이 없거나 계정을 찾을 수 없습니다.");
    await expect(page.locator("[data-save-role]")).toBeVisible();
    expect((await profile(env, "teacher01")).role).toBe("teacher");
  });

  test("삭제하면 로그인 자체가 막히고 목록에 삭제됨으로 남는다", async ({ env, openAs, openOtherAs, page }) => {
    answerDialogs(page, [true]);
    await openAs("admin01", "/accounts.html");
    await row(page, "homeroom01").getByRole("button", { name: "삭제" }).click();
    await expect(row(page, "homeroom01")).toContainText("삭제됨");
    expect(await profile(env, "homeroom01")).toMatchObject({ disabled: true, role: null, managed_classes: [] });
    expect(await tryLogin(openOtherAs, "homeroom01", PASSWORD)).toBe("삭제(비활성화)된 계정입니다. 관리자에게 문의해 주세요.");
    await expect(page.locator("#bulkResetBtn")).toHaveText("비밀번호 일괄 재발급 (4명)");
  });

  test("교사 계정 일괄 생성: 미리보기의 비밀번호로 바로 로그인된다", async ({ env, openAs, openOtherAs, page }) => {
    await openAs("admin01", "/accounts.html");
    await page.fill("#bulkAccountInput", "NewT1\t새교사\nnewt2\t둘째교사\tmypass99\nadmin01\t중복\nbad id\t오류");
    await expect(page.locator("#bulkAccountPreview .bulk-preview__row")).toHaveCount(3);
    await expect(page.locator("#bulkAccountPreview .bulk-preview__row").first()).toContainText("newt1 · 새교사 · 교사 · 비밀번호");
    await expect(page.locator("#bulkAccountPreview .bulk-preview__errors")).toContainText("4번째 줄");
    const autoPassword = /비밀번호 (\S+) \(자동 생성\)/.exec(
      await page.locator("#bulkAccountPreview .bulk-preview__row").first().textContent()
    )[1];

    await page.click("#bulkCreateBtn");
    await expect(page.locator("#resultWrap")).toBeVisible();
    const results = page.locator("#resultList .student-card");
    await expect(results).toHaveCount(3);
    await expect(results.nth(0)).toContainText(`생성됨비밀번호: ${autoPassword}`);
    await expect(results.nth(1)).toContainText("생성됨비밀번호: mypass99");
    await expect(results.nth(2)).toContainText("이미 사용 중인 아이디입니다.");
    await expect(page.locator("#resultCopy")).toHaveValue(`newt1\t새교사\t${autoPassword}\nnewt2\t둘째교사\tmypass99`);

    await expect(row(page, "newt1")).toContainText("teacher");
    expect(await profile(env, "newt2")).toMatchObject({ kind: "staff", role: "teacher", name: "둘째교사" });
    expect(await tryLogin(openOtherAs, "NEWT1", autoPassword)).toBe("ok");
  });

  test("교사 계정 일괄 생성: 역할 이름(한글)을 넣으면 그 역할로, 관리자는 막는다", async ({ env, openAs, page }) => {
    await openAs("admin01", "/accounts.html");
    await page.fill(
      "#bulkAccountInput",
      ["sup1\t감독1\t자습감독", "dorm2\t기숙2\t기숙사관리자\tdormpass1", "gm2\t학년2\t학년 관리자", "t3\t교사3\t교사", "t4\t교사4\tpw123456", "boss2\t관리2\t관리자", "after2\t방과후2\t방과후 선생님"].join("\n")
    );
    const preview = page.locator("#bulkAccountPreview .bulk-preview__row");
    await expect(preview).toHaveCount(6);
    await expect(preview.nth(0)).toContainText("sup1 · 감독1 · 자습감독 · 비밀번호");
    await expect(preview.nth(5)).toContainText("after2 · 방과후2 · 방과후선생님");
    await expect(preview.nth(1)).toContainText("dorm2 · 기숙2 · 기숙사관리자 · 비밀번호 dormpass1");
    await expect(preview.nth(2)).toContainText("gm2 · 학년2 · 학년관리자");
    await expect(preview.nth(4)).toContainText("t4 · 교사4 · 교사 · 비밀번호 pw123456"); // 역할 없이 비밀번호만(예전 형식)
    await expect(page.locator("#bulkAccountPreview .bulk-preview__errors")).toContainText("6번째 줄: 관리자는 일괄 생성으로 만들 수 없습니다");

    await page.click("#bulkCreateBtn");
    await expect(page.locator("#resultList .student-card")).toHaveCount(6);
    const roles = await env.sql("select login_id, role from public.profiles where login_id = any($1) order by login_id", [["after2", "dorm2", "gm2", "sup1", "t3", "t4", "boss2"]]);
    expect(roles).toEqual([
      { login_id: "after2", role: "afterschoolTeacher" },
      { login_id: "dorm2", role: "dormStaff" },
      { login_id: "gm2", role: "gradeManager" },
      { login_id: "sup1", role: "studyHallSupervisor" },
      { login_id: "t3", role: "teacher" },
      { login_id: "t4", role: "teacher" },
    ]);
    // 서버도 관리자 생성은 거부한다
    const message = await page.evaluate(async () => {
      const { callFunction } = await import("/js/supabase-client.js");
      const data = await callFunction("staff-accounts", { action: "create", accounts: [{ loginId: "boss3", name: "x", role: "admin" }] });
      return data.results[0].error;
    });
    expect(message).toBe("관리자는 일괄 생성으로 만들 수 없습니다.");
  });

  test("비밀번호 재발급: 새 비밀번호만 통한다(개별·일괄)", async ({ openAs, openOtherAs, page }) => {
    answerDialogs(page, [true, true]);
    await openAs("admin01", "/accounts.html");
    await row(page, "teacher01").getByRole("button", { name: "비밀번호 재발급" }).click();
    const first = page.locator("#resultList .student-card").first();
    await expect(first).toContainText("재발급됨");
    const newPassword = /비밀번호: (\S+)/.exec(await first.textContent())[1];
    expect(await tryLogin(openOtherAs, "teacher01", PASSWORD)).toBe(WRONG_LOGIN);
    expect(await tryLogin(openOtherAs, "teacher01", newPassword)).toBe("ok");

    await page.click("#bulkResetBtn");
    await expect(page.locator("#resultList .student-card")).toHaveCount(6);
    const lines = (await page.locator("#resultCopy").inputValue()).split("\n");
    expect(lines.map((l) => l.split("\t")[0])).toEqual(["dorm01", "gm01", "homeroom01", "super01", "teacher01", "teacher01"]);
    const dormPassword = lines[0].split("\t")[2];
    expect(await tryLogin(openOtherAs, "dorm01", dormPassword)).toBe("ok");
    expect(await tryLogin(openOtherAs, "gm01", PASSWORD)).toBe(WRONG_LOGIN);
  });

  test("비밀번호 재발급: 관리자가 정한 비밀번호로 바꿀 수 있고, 6자 미만은 막는다", async ({ openAs, openOtherAs, page }) => {
    const dialogs = answerDialogs(page, ["12345", null, "school2026"]); // null = 6자 미만 안내(alert)
    await openAs("admin01", "/accounts.html");
    const resetBtn = row(page, "teacher01").getByRole("button", { name: "비밀번호 재발급" });
    await resetBtn.click();
    await expect.poll(() => dialogs.map((d) => d.message)).toContain("비밀번호는 6자 이상이어야 합니다.");
    await expect(page.locator("#resultList .student-card")).toHaveCount(0);
    expect(await tryLogin(openOtherAs, "teacher01", PASSWORD)).toBe("ok");

    await resetBtn.click();
    await expect(page.locator("#resultList .student-card").first()).toContainText("비밀번호: school2026");
    expect(await tryLogin(openOtherAs, "teacher01", PASSWORD)).toBe(WRONG_LOGIN);
    expect(await tryLogin(openOtherAs, "teacher01", "school2026")).toBe("ok");
  });

  test("서버 함수 호출에 쓰는 헤더가 함수의 CORS 허용 목록에 모두 들어 있다", async ({ env, openAs, page }) => {
    // Playwright는 가로챈 요청의 사전 요청(OPTIONS)을 직접 처리하므로, 실제 함수의 허용 목록과 따로 대조한다.
    answerDialogs(page, [true]);
    await openAs("admin01", "/accounts.html");
    const requestPromise = page.waitForRequest((req) => req.url().includes("/functions/v1/staff-accounts"));
    await row(page, "teacher01").getByRole("button", { name: "비밀번호 재발급" }).click();
    const sent = Object.keys((await requestPromise).headers()).filter(
      (name) => !["accept", "accept-language", "content-language", "referer", "user-agent", "origin"].includes(name) && !name.startsWith("sec-")
    );
    const preflight = await fetch(env.functionUrls["staff-accounts"], { method: "OPTIONS" });
    const allowed = (preflight.headers.get("access-control-allow-headers") ?? "").split(",").map((h) => h.trim().toLowerCase());
    expect(sent.length).toBeGreaterThan(0);
    for (const name of sent) expect(allowed, `${name} 헤더가 CORS 허용 목록에 없음`).toContain(name);
    expect(preflight.headers.get("access-control-allow-methods")).toContain("POST");
  });

  test("기숙사부는 계정 관리에 들어올 수 없다", async ({ openAs, page }) => {
    await openAs("dorm01", "/accounts.html");
    await expect(page).toHaveURL(/check\.html$/);
  });
});

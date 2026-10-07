import { test, expect } from "./fixtures.mjs";
import { PASSWORD, STUDENT } from "../harness/seed.mjs";
import { answerDialogs, collectAlerts, tryLogin, WRONG_LOGIN } from "./helpers.mjs";

const rosterCard = (page, name) => page.locator("#rosterList .student-card", { hasText: name });

async function studentRow(env, id) {
  return (await env.sql("select * from public.students where id = $1", [id]))[0] ?? null;
}

async function studentAccount(env, studentId) {
  return (await env.sql("select * from public.profiles where student_id = $1", [studentId]))[0] ?? null;
}

test.describe("학생 계정 관리(학생 명단 화면)", () => {
  test("계정 발급 → 화면에 뜬 비밀번호로 학생이 로그인 → 비번 재발급 → 계정 삭제", async ({ env, openAs, openOtherAs, page }) => {
    answerDialogs(page, [true, true]);
    await openAs("homeroom01", "/students.html");
    await expect(rosterCard(page, "홍길동").locator(".account-chip")).toHaveText("계정 없음");
    // 목록에는 학번·이름·반·번호만(연락처·이메일·ID는 수정 폼에서만)
    await expect(rosterCard(page, "홍길동").locator(".student-meta")).toHaveText(["학번 10305 · 1학년 3반 5번"]);
    await expect(rosterCard(page, "홍길동")).not.toContainText("010-1111-2222");
    await expect(rosterCard(page, "최하늘").locator(".account-chip")).toHaveText("ID 미등록");
    await expect(rosterCard(page, "최하늘").getByRole("button", { name: "계정 발급" })).toHaveCount(0);

    await rosterCard(page, "홍길동").getByRole("button", { name: "계정 발급" }).click();
    const result = page.locator("#accountResultList .student-card").first();
    await expect(result).toContainText("발급됨");
    const pin = /비밀번호: (\d{6})/.exec(await result.textContent())[1];
    await expect(page.locator("#accountResultCopy")).toHaveValue(`홍길동\t10305\thong123\t${pin}`);
    await expect(rosterCard(page, "홍길동").locator(".account-chip")).toHaveText("계정 있음");
    expect(await studentAccount(env, STUDENT.hong)).toMatchObject({ kind: "student", role: "student", login_id: "hong123" });

    expect(await tryLogin(openOtherAs, "Hong123", pin, { student: true })).toBe("ok");

    await rosterCard(page, "홍길동").getByRole("button", { name: "비번 재발급" }).click();
    await expect(page.locator("#accountResultList .student-card").first()).toContainText("재발급됨");
    const newPin = /비밀번호: (\d{6})/.exec(await page.locator("#accountResultList .student-card").first().textContent())[1];
    expect(await tryLogin(openOtherAs, "hong123", pin, { student: true })).toBe(WRONG_LOGIN);
    expect(await tryLogin(openOtherAs, "hong123", newPin, { student: true })).toBe("ok");

    await rosterCard(page, "홍길동").getByRole("button", { name: "계정 삭제" }).click();
    await expect(rosterCard(page, "홍길동").locator(".account-chip")).toHaveText("계정 없음");
    expect(await studentAccount(env, STUDENT.hong)).toBeNull();
    expect(await studentRow(env, STUDENT.hong)).not.toBeNull();
    expect(await tryLogin(openOtherAs, "hong123", newPin, { student: true })).toBe(WRONG_LOGIN);
  });

  test("계정 일괄 발급은 지금 학년(담임은 담당 반)에서 ID가 있고 계정이 없는 학생만", async ({ env, openAs, page }) => {
    answerDialogs(page, [true]);
    await env.sql("update public.students set login_id = 'minjun.kim' where id = $1", [STUDENT.minjun]);
    await openAs("admin01", "/students.html");
    await expect(page.locator("#bulkIssueBtn")).toHaveText("계정 일괄 발급 (2명)"); // 1학년: 홍길동·김민준(최하늘은 ID 없음)
    await page.click("#bulkIssueBtn");
    await expect(page.locator("#accountResultList .student-card")).toHaveCount(2);
    const lines = (await page.locator("#accountResultCopy").inputValue()).split("\n");
    expect(lines.map((l) => l.split("\t").slice(0, 3))).toEqual([
      ["김민준", "10101", "minjun.kim"],
      ["홍길동", "10305", "hong123"],
    ]);
    await expect(page.locator("#bulkIssueBtn")).toHaveText("계정 일괄 발급 (0명)");
    await page.click("#gradeTabs >> text=2학년");
    await expect(page.locator("#bulkIssueBtn")).toHaveText("계정 일괄 발급 (1명)");
  });

  test("계정이 있으면 ID를 바꿀 수 없고, 형식·중복은 저장 전에 막는다", async ({ env, openAs, page }) => {
    const alerts = collectAlerts(page);
    await env.createStudentAccount(STUDENT.hong, "hong123");
    await openAs("dorm01", "/students.html");
    await rosterCard(page, "홍길동").getByRole("button", { name: "수정" }).click();
    await expect(page.locator("#inputLoginId")).toBeDisabled();
    await expect(page.locator("#loginIdHint")).toContainText("계정이 발급되어 있어 바꿀 수 없습니다");
    await page.click("#cancelFormBtn");

    await rosterCard(page, "최하늘").getByRole("button", { name: "수정" }).click();
    await expect(page.locator("#inputLoginId")).toBeEnabled();
    await page.fill("#inputLoginId", "최하늘");
    await page.click("#submitFormBtn");
    await expect.poll(() => alerts.at(-1)).toContain("ID는 영문·숫자와 . _ - 만");
    await page.fill("#inputLoginId", "Haneul.C");
    await page.fill("#inputPhone", "02-123-4567");
    await page.click("#submitFormBtn");
    await expect.poll(() => alerts.at(-1)).toContain("연락처는 010으로 시작하는 휴대폰 번호");
    await page.fill("#inputPhone", "010 5555 6666");
    await page.click("#submitFormBtn");
    await expect(page.locator("#formWrap")).toBeHidden();
    expect(await studentRow(env, STUDENT.haneul)).toMatchObject({ login_id: "haneul.c", phone: "01055556666" });

    // 다른 학생이 쓰는 ID
    await rosterCard(page, "김민준").getByRole("button", { name: "수정" }).click();
    await page.fill("#inputLoginId", "haneul.c");
    await page.click("#submitFormBtn");
    await expect.poll(() => alerts.at(-1)).toBe("저장하지 못했습니다: 이미 다른 학생이 쓰는 ID입니다.");
    expect((await studentRow(env, STUDENT.minjun)).login_id).toBeNull();
  });

  test("여러 명 붙여넣기: 있는 학번은 정보만 갱신하고 없는 학번은 새로 추가", async ({ env, openAs, page }) => {
    await openAs("homeroom01", "/students.html");
    await page.click("#bulkAddBtn");
    await page.fill(
      "#bulkInput",
      ["최하늘\t10302\thaneul\t010-7777-8888\t\t", "오세훈\t10399\tsehun.oh\t\t01099990000\tsehun@example.com", "홍길동\t10305\t\t\t010-1212-3434"].join("\n")
    );
    const rows = page.locator("#bulkPreview .bulk-preview__row");
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText("[정보 갱신] 최하늘 · 10302 · 1학년 3반 · ID haneul · 학생 010-7777-8888");
    await expect(rows.nth(1)).toContainText("[새로 추가] 오세훈 · 10399 · 1학년 3반 · ID sehun.oh · 학부모 010-9999-0000 · sehun@example.com");
    await page.click("#bulkSaveBtn");
    await expect(page.locator("#bulkFormWrap")).toBeHidden();

    expect(await studentRow(env, STUDENT.haneul)).toMatchObject({ login_id: "haneul", phone: "01077778888", parent_phone: null });
    // 빈 칸은 기존 값 그대로
    expect(await studentRow(env, STUDENT.hong)).toMatchObject({ login_id: "hong123", phone: "01011112222", parent_phone: "01012123434" });
    const [sehun] = await env.sql("select * from public.students where sid = '10399'");
    expect(sehun).toMatchObject({ grade: 1, cls: "1학년 3반", login_id: "sehun.oh", parent_phone: "01099990000", email: "sehun@example.com" });
  });

  test("계정이 있는 학생을 명단에서 지우면 로그인 정보도 함께 지워진다", async ({ env, openAs, page }) => {
    answerDialogs(page, [true]);
    await env.createStudentAccount(STUDENT.hong, "hong123");
    await openAs("admin01", "/students.html");
    await rosterCard(page, "홍길동").getByRole("button", { name: "삭제", exact: true }).click();
    await expect(rosterCard(page, "홍길동")).toHaveCount(0);
    expect(await studentRow(env, STUDENT.hong)).toBeNull();
    expect(env.auth.findByEmail("hong123@student.donghall.local")).toBeNull();
  });

  test("담임은 다른 반 학생 계정을 서버에서도 발급할 수 없다", async ({ openAs, page }) => {
    await openAs("homeroom01", "/students.html");
    await expect(rosterCard(page, "홍길동")).toBeVisible();
    const result = await page.evaluate(async (ids) => {
      const { callFunction } = await import("/js/supabase-client.js");
      return callFunction("student-accounts", { action: "issue", studentIds: ids });
    }, [STUDENT.seoyeon]);
    expect(result.results).toEqual([{ studentId: STUDENT.seoyeon, ok: false, error: "이 학생의 계정을 관리할 권한이 없습니다." }]);
  });
});

test("학생 탭: 마지막으로 고른 탭과 아이디를 기억하고, 교사 아이디로는 로그인되지 않는다", async ({ env, page }) => {
  await env.createStudentAccount(STUDENT.hong, "hong123");
  await page.goto("/login.html");
  await page.click("[data-login-mode='student']");
  await expect(page.locator("#loginSubtitle")).toHaveText("학생 계정으로 로그인해 주세요");
  await page.fill("#userId", "teacher01");
  await page.fill("#password", PASSWORD);
  await page.click("#submitBtn");
  await expect(page.locator("#errorBox")).toHaveText(WRONG_LOGIN);

  await page.fill("#userId", "hong123");
  await page.fill("#password", PASSWORD);
  await page.check("#rememberMe");
  await page.click("#submitBtn");
  await expect(page).toHaveURL(/student\.html$/);
  await page.click("#logoutBtn");
  await expect(page).toHaveURL(/login\.html$/);
  await expect(page.locator("[data-login-mode='student']")).toHaveClass(/is-active/);
  await expect(page.locator("#userId")).toHaveValue("hong123");
});

import { readFile } from "node:fs/promises";
import { test, expect } from "./fixtures.mjs";
import { PASSWORD, STUDENT } from "../harness/seed.mjs";
import { answerDialogs, collectAlerts, tryLogin, WRONG_LOGIN } from "./helpers.mjs";

const rosterCard = (page, name) => page.locator("#rosterList .student-card", { hasText: name });

async function studentRow(env, id) {
  return (await env.sql("select * from public.students where id = $1", [id]))[0] ?? null;
}

// [비밀번호 목록 파일로 받기]로 받은 CSV(BOM 제외)를 줄·칸으로
async function downloadPasswordCsv(page) {
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#accountResultDownloadBtn")]);
  expect(download.suggestedFilename()).toMatch(/^student-passwords_\d{4}-\d{2}-\d{2}_\d{4}\.csv$/);
  const text = await readFile(await download.path(), "utf8");
  expect(text.startsWith("\ufeff")).toBe(true);
  return text.slice(1).trim().split("\r\n").map((line) => line.split(","));
}

async function studentAccount(env, studentId) {
  return (await env.sql("select * from public.profiles where student_id = $1", [studentId]))[0] ?? null;
}

test.describe("학생 계정 관리(학생 명단 화면)", () => {
  test("관리자가 계정 발급(비밀번호는 학생에게 문자로) → 학생 로그인 → 비번 재발급(문자 실패면 화면에) → 계정 삭제", async ({ env, openAs, openOtherAs, page }) => {
    answerDialogs(page, [true, true]);
    await openAs("admin01", "/students.html");
    await expect(rosterCard(page, "홍길동").locator(".account-chip")).toHaveText("계정 없음");
    // 목록에는 학번·이름·반·번호만(연락처·이메일·ID는 수정 폼에서만)
    await expect(rosterCard(page, "홍길동").locator(".student-meta")).toHaveText(["학번 10305 · 1학년 3반 5번"]);
    await expect(rosterCard(page, "홍길동")).not.toContainText("010-1111-2222");
    await expect(rosterCard(page, "최하늘").locator(".account-chip")).toHaveText("ID 미등록");
    await expect(rosterCard(page, "최하늘").getByRole("button", { name: "계정 발급" })).toHaveCount(0);

    await rosterCard(page, "홍길동").getByRole("button", { name: "계정 발급" }).click();
    const result = page.locator("#accountResultList .student-card").first();
    await expect(result).toContainText("발급됨");
    // 학생 연락처가 있으므로 비밀번호는 문자로만 가고 화면에는 나오지 않는다
    await expect(result).toContainText("비밀번호를 학생에게 문자로 보냈습니다");
    await expect(page.locator("#accountResultCopy")).toHaveValue("");
    expect(env.sms.messages).toHaveLength(1);
    expect(env.sms.messages[0]).toMatchObject({ to: "01011112222", from: "0212345678" });
    expect(env.sms.messages[0].text).toContain("아이디: hong123");
    expect(env.sms.messages[0].text).toContain("접속: http://dorm.test/login.html");
    const pin = /비밀번호: (\d{6})/.exec(env.sms.messages[0].text)[1];
    await expect(rosterCard(page, "홍길동").locator(".account-chip")).toHaveText("계정 있음");
    expect(await studentAccount(env, STUDENT.hong)).toMatchObject({ kind: "student", role: "student", login_id: "hong123" });

    expect(await tryLogin(openOtherAs, "Hong123", pin, { student: true })).toBe("ok");

    // 문자가 실패하면 비밀번호를 화면에 보여 준다
    env.sms.failTo.add("01011112222");
    await rosterCard(page, "홍길동").getByRole("button", { name: "비번 재발급" }).click();
    const reset = page.locator("#accountResultList .student-card").first();
    await expect(reset).toContainText("재발급됨");
    await expect(reset).toContainText("문자 실패(수신번호 오류)");
    const newPin = /비밀번호: (\d{6})/.exec(await reset.textContent())[1];
    await expect(page.locator("#accountResultCopy")).toHaveValue(`홍길동\t10305\thong123\t${newPin}`);
    expect(await tryLogin(openOtherAs, "hong123", pin, { student: true })).toBe(WRONG_LOGIN);
    expect(await tryLogin(openOtherAs, "hong123", newPin, { student: true })).toBe("ok");

    // 비밀번호 목록 파일: 문자로 보낸 것까지 모두(서버에는 저장하지 않으므로 관리자가 따로 보관)
    const rows = await downloadPasswordCsv(page);
    expect(rows[0]).toEqual(["이름", "학번", "아이디", "비밀번호", "구분", "전달", "시각"]);
    expect(rows.slice(1).map((r) => r.slice(0, 6))).toEqual([
      ["홍길동", "10305", "hong123", newPin, "재발급", "직접 전달"],
      ["홍길동", "10305", "hong123", pin, "발급", "문자 보냄"],
    ]);

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
    // 연락처가 있는 홍길동은 문자로 받고, 연락처가 없는 김민준만 비밀번호가 화면(엑셀 붙여넣기용)에 나온다
    const lines = (await page.locator("#accountResultCopy").inputValue()).split("\n");
    expect(lines.map((l) => l.split("\t").slice(0, 3))).toEqual([["김민준", "10101", "minjun.kim"]]);
    await expect(page.locator("#accountResultList .student-card", { hasText: "김민준" })).toContainText("학생 연락처 없음 — 비밀번호:");
    await expect(page.locator("#accountResultList .student-card", { hasText: "홍길동" })).toContainText("문자로 보냈습니다");
    expect(env.sms.messages.map((m) => m.to)).toEqual(["01011112222"]);
    await expect(page.locator("#bulkIssueBtn")).toHaveText("계정 일괄 발급 (0명)");
    await page.click("#gradeTabs >> text=2학년");
    await expect(page.locator("#bulkIssueBtn")).toHaveText("계정 일괄 발급 (1명)");
  });

  test("계정이 있으면 ID를 바꿀 수 없고, 형식·중복은 저장 전에 막는다", async ({ env, openAs, page }) => {
    const alerts = collectAlerts(page);
    await env.createStudentAccount(STUDENT.hong, "hong123");
    await openAs("admin01", "/students.html");
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

  test("담임은 학생 계정을 발급·삭제할 수 없고, 계정 있는 학생은 명단에서도 못 지운다(서버도 막음)", async ({ env, openAs, page }) => {
    await env.createStudentAccount(STUDENT.hong, "hong123");
    await openAs("homeroom01", "/students.html");
    await expect(rosterCard(page, "홍길동")).toBeVisible();
    await expect(page.locator("#bulkIssueBtn")).toBeHidden();
    await page.click("#addStudentBtn");
    await expect(page.locator("#issueOnSaveLabel")).toBeHidden(); // 담임은 저장하면서 발급하는 체크도 없음
    await page.click("#cancelFormBtn");
    await expect(rosterCard(page, "최하늘").getByRole("button", { name: "계정 발급" })).toHaveCount(0);
    await expect(rosterCard(page, "홍길동").getByRole("button", { name: "삭제", exact: true })).toHaveCount(0);
    await expect(rosterCard(page, "최하늘").getByRole("button", { name: "삭제", exact: true })).toBeVisible(); // 계정 없는 학생은 삭제 가능
    const result = await page.evaluate(async (ids) => {
      const { callFunction, supabase } = await import("/js/supabase-client.js");
      const out = {};
      try {
        await callFunction("student-accounts", { action: "issue", studentIds: [ids.haneul] });
      } catch (err) {
        out.issue = err.message;
      }
      out.del = (await supabase.from("students").delete().eq("id", ids.hong)).error?.message;
      return out;
    }, { haneul: STUDENT.haneul, hong: STUDENT.hong });
    expect(result).toEqual({ issue: "학생 계정 발급은 관리자만 할 수 있습니다.", del: "계정이 있는 학생은 관리자만 삭제할 수 있습니다." });
    expect(await studentRow(env, STUDENT.hong)).not.toBeNull();
  });

  test("관리자는 학생을 추가하면서 계정도 함께 발급한다(체크를 끄면 명단만)", async ({ env, openAs, page }) => {
    await openAs("admin01", "/students.html");
    await expect(rosterCard(page, "홍길동")).toBeVisible();

    // 한 명 추가: ID와 학생 연락처가 있으면 계정을 만들고 비밀번호는 문자로
    await page.click("#addStudentBtn");
    await expect(page.locator("#issueOnSaveCheck")).toBeChecked();
    await page.fill("#inputName", "박새봄");
    await page.fill("#inputSid", "10320");
    await page.fill("#inputLoginId", "Spring.P");
    await page.fill("#inputPhone", "010-3333-4444");
    await page.click("#submitFormBtn");
    await expect(page.locator("#formWrap")).toBeHidden();
    await expect(rosterCard(page, "박새봄").locator(".account-chip")).toHaveText("계정 있음");
    await expect(page.locator("#accountResultList .student-card", { hasText: "박새봄" })).toContainText("문자로 보냈습니다");
    expect(env.sms.messages.map((m) => m.to)).toEqual(["01033334444"]);
    expect(env.sms.messages[0].text).toContain("아이디: spring.p");

    // 수정할 때는 체크가 안 보인다(정보만 고쳐도 계정이 생기지 않게)
    await rosterCard(page, "최하늘").getByRole("button", { name: "수정" }).click();
    await expect(page.locator("#issueOnSaveLabel")).toBeHidden();
    await page.click("#cancelFormBtn");

    // 여러 명 붙여넣기: 새 학생과 ID를 새로 넣은 기존 학생 모두 발급, ID 없는 학생은 명단만
    await page.click("#bulkAddBtn");
    await expect(page.locator("#issueOnBulkCheck")).toBeChecked();
    await page.fill("#bulkInput", ["김여름\t10321\tsummer", "이가을\t10322", "최하늘\t10302\thaneul"].join("\n"));
    await page.click("#bulkSaveBtn");
    await expect(page.locator("#bulkFormWrap")).toBeHidden();
    await expect(rosterCard(page, "김여름").locator(".account-chip")).toHaveText("계정 있음");
    await expect(rosterCard(page, "최하늘").locator(".account-chip")).toHaveText("계정 있음");
    await expect(rosterCard(page, "이가을").locator(".account-chip")).toHaveText("ID 미등록");
    // 연락처가 없으니 비밀번호는 화면(엑셀 붙여넣기용)에
    const lines = (await page.locator("#accountResultCopy").inputValue()).split("\n").map((l) => l.split("\t").slice(0, 3));
    expect(lines).toEqual(expect.arrayContaining([["김여름", "10321", "summer"], ["최하늘", "10302", "haneul"]]));
    expect(await studentAccount(env, STUDENT.haneul)).toMatchObject({ login_id: "haneul" });

    // 체크를 끄면 명단만 저장
    await page.click("#addStudentBtn");
    await page.uncheck("#issueOnSaveCheck");
    await page.fill("#inputName", "정겨울");
    await page.fill("#inputSid", "10323");
    await page.fill("#inputLoginId", "winter");
    await page.click("#submitFormBtn");
    await expect(rosterCard(page, "정겨울").locator(".account-chip")).toHaveText("계정 없음");
  });

  test("관리자는 반 단위로 학생을 한 번에 지운다(계정도 함께, \"삭제\" 입력 확인)", async ({ env, openAs, page }) => {
    const dialogs = answerDialogs(page, ["지워", true, "삭제"]);
    await env.createStudentAccount(STUDENT.hong, "hong123");
    await openAs("admin01", "/students.html");
    await expect(rosterCard(page, "홍길동")).toBeVisible();
    await page.click("#classDeleteBtn");
    const chips = page.locator("#classDeleteChips [data-delete-cls]");
    await expect(chips).toHaveText(["1학년 1반 (1명)", "1학년 3반 (2명)"]);
    await expect(page.locator("#classDeleteSaveBtn")).toBeDisabled();
    await chips.filter({ hasText: "1학년 3반" }).click();
    await expect(page.locator("#classDeleteSaveBtn")).toHaveText("삭제 (2명)");

    // "삭제"라고 입력하지 않으면 지우지 않는다
    await page.click("#classDeleteSaveBtn");
    await expect.poll(() => dialogs.length).toBe(2);
    expect(dialogs[0].message).toContain("1학년 3반 학생 2명");
    expect(dialogs[0].message).toContain("학생 계정 1개도 함께 지워집니다");
    expect(dialogs[1].message).toContain("지우지 않았습니다");
    expect(await studentRow(env, STUDENT.hong)).not.toBeNull();

    await page.click("#classDeleteSaveBtn");
    await expect(page.locator("#classDeleteWrap")).toBeHidden();
    await expect(rosterCard(page, "홍길동")).toHaveCount(0);
    await expect(rosterCard(page, "최하늘")).toHaveCount(0);
    await expect(rosterCard(page, "김민준")).toBeVisible();
    expect(await studentRow(env, STUDENT.hong)).toBeNull();
    expect(await studentRow(env, STUDENT.haneul)).toBeNull();
    expect(await studentRow(env, STUDENT.minjun)).not.toBeNull();
    expect(env.auth.findByEmail("hong123@student.donghall.local")).toBeNull();
  });

  test("반 단위 삭제는 관리자만(버튼이 없고 서버도 거부)", async ({ openAs, page }) => {
    await openAs("gm01", "/students.html");
    await expect(rosterCard(page, "홍길동")).toBeVisible();
    await expect(page.locator("#classDeleteBtn")).toBeHidden();
    const message = await page.evaluate(async (id) => {
      const { callFunction } = await import("/js/supabase-client.js");
      try {
        await callFunction("student-accounts", { action: "delete-students", studentIds: [id] });
        return "deleted";
      } catch (err) {
        return err.message;
      }
    }, STUDENT.minjun);
    expect(message).toBe("여러 학생을 한 번에 삭제하는 것은 관리자만 할 수 있습니다.");
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
  // 화면 스크립트가 다 뜬 뒤(이름이 그려진 뒤)에 로그아웃을 눌러야 버튼이 동작한다
  await expect(page.locator("#studentName")).toContainText("홍길동");
  await page.click("#logoutBtn");
  await expect(page).toHaveURL(/login\.html$/);
  await expect(page.locator("[data-login-mode='student']")).toHaveClass(/is-active/);
  await expect(page.locator("#userId")).toHaveValue("hong123");
});

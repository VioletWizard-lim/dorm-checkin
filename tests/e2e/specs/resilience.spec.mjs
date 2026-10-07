import { test, expect } from "./fixtures.mjs";
import { STUDENT } from "../harness/seed.mjs";
import { todayKst } from "./helpers.mjs";

test.describe("운영 환경에서 생길 수 있는 상황", () => {
  test("학생이 1000명을 넘어도 전부 불러온다(Supabase는 한 번에 1000행까지만 줌)", async ({ env, openAs, page }) => {
    await env.sql(`
      insert into public.students (grade, name, sid, cls)
      select 1 + (n % 3), '학생' || lpad(n::text, 4, '0'), (90000 + n)::text, '테스트반'
        from generate_series(1, 1100) as n
    `);
    await openAs("teacher01", "/check.html");
    await expect(page.locator(".student-card")).toHaveCount(1105, { timeout: 15000 });
  });

  test("access token이 만료된 채로 열어도(밤새 켜 둔 화면) 다시 받아서 동작한다", async ({ env, context, page }) => {
    await env.loginAs(context, "teacher01", { expired: true });
    await page.goto("/display.html");
    await expect(page.locator("#currentUserName")).toHaveText("이교사");
    await expect(page.locator("#awayPanelCount")).toHaveText("1명");
  });

  test("웹소켓이 막힌 네트워크에서도 처음 데이터는 보이고, 변경은 15초 안에 반영된다", async ({ env, context, page }) => {
    test.setTimeout(60000);
    // 실시간 연결을 거부하는 네트워크 흉내: 웹소켓을 바로 닫는다.
    await context.routeWebSocket(/\/realtime\/v1\/websocket/, (ws) => ws.close({ code: 1011, reason: "blocked" }));
    await env.loginAs(context, "teacher01");
    await page.goto("/display.html");
    await expect(page.locator("#awayPanelCount")).toHaveText("1명");
    await env.sql("insert into public.outings (date, student_id, status) values ($1, $2, 'out')", [todayKst(), STUDENT.seoyeon]);
    await expect(page.locator("#outPanelCount")).toHaveText("1명", { timeout: 20000 });
  });
});

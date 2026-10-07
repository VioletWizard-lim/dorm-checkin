import { test as base, expect } from "@playwright/test";
import { startEnv } from "../harness/env.mjs";

export { expect };

export const test = base.extend({
  // 워커당 한 번: DB·PostgREST·게이트웨이·Edge Function·Realtime 흉내
  env: [
    async ({}, use) => {
      const env = await startEnv();
      await use(env);
      await env.stop();
    },
    { scope: "worker", timeout: 180_000 },
  ],

  // 테스트마다 기본 데이터로 되돌리고, 기본 브라우저 컨텍스트에 가로채기를 건다.
  // 화면에서 잡히지 않은 JS 오류나 console.error가 나오면 실패로 본다.
  // 서버가 요청을 거부한 4xx 응답(틀린 비밀번호, 권한 없음 등)은 브라우저가 콘솔에 찍기만 하므로 제외한다.
  context: async ({ context, env }, use) => {
    await env.reset();
    await env.setupContext(context);
    const errors = [];
    context.on("weberror", (webError) => errors.push(`[pageerror] ${webError.error().message}`));
    context.on("console", (msg) => {
      if (msg.type() !== "error") return;
      if (/^Failed to load resource: the server responded with a status of 4\d\d/.test(msg.text())) return;
      errors.push(`[console.error] ${msg.text()}`);
    });
    await use(context);
    expect(errors, "브라우저 콘솔 오류").toEqual([]);
  },

  // 로그인한 상태로 화면 열기: await openAs("admin01", "/check.html")
  openAs: async ({ context, page, env }, use) => {
    await use(async (loginId, path) => {
      await env.loginAs(context, loginId);
      await page.goto(path);
      return page;
    });
  },

  // 같은 테스트 안에서 다른 사람의 창이 하나 더 필요할 때(실시간 반영 확인 등)
  openOtherAs: async ({ browser, env }, use) => {
    const contexts = [];
    await use(async (loginId, path) => {
      const context = await browser.newContext({ timezoneId: "Asia/Seoul", locale: "ko-KR", viewport: { width: 1280, height: 900 } });
      contexts.push(context);
      await env.setupContext(context);
      if (loginId) await env.loginAs(context, loginId);
      const page = await context.newPage();
      await page.goto(path);
      return page;
    });
    for (const context of contexts) await context.close();
  },
});

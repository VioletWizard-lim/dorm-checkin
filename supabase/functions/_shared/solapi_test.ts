import { assertEquals } from "jsr:@std/assert@1";
import { authorizationHeader, createSmsSender, normalizeSender, smsConfigFromEnv } from "./solapi.ts";

const env = (values: Record<string, string>) => ({ get: (key: string) => values[key] });

Deno.test("authorization header matches Solapi's HMAC-SHA256(secret, date + salt) format", async () => {
  // 기대값은 솔라피 공식 SDK와 같은 방식(Node crypto.createHmac)으로 계산한 값
  assertEquals(
    await authorizationHeader("test-key", "test-secret", "2026-10-08T00:00:00.000Z", "abc123"),
    "HMAC-SHA256 apiKey=test-key, date=2026-10-08T00:00:00.000Z, salt=abc123, " +
      "signature=01ed74b1a957a9670695979fd98b45116ee25697ed1ec792422ae5dc0dac1ac7",
  );
});

Deno.test("config needs key, secret and a valid sender number", () => {
  assertEquals(smsConfigFromEnv(env({})), null);
  assertEquals(smsConfigFromEnv(env({ SOLAPI_API_KEY: "k", SOLAPI_API_SECRET: "s", SMS_SENDER: "abc" })), null);
  assertEquals(smsConfigFromEnv(env({ SOLAPI_API_KEY: "k", SOLAPI_API_SECRET: "s", SMS_SENDER: "010-1234-5678" })), {
    apiKey: "k",
    apiSecret: "s",
    sender: "01012345678",
    baseUrl: "https://api.solapi.com",
  });
  assertEquals(normalizeSender("02-123-4567"), "021234567");
  assertEquals(normalizeSender("1588-1234"), "15881234");
});

type Call = { url: string; body: Record<string, unknown>; auth: string };

function fakeFetch(respond: (url: string, body: Record<string, unknown>) => { status?: number; body: unknown }) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ url, body, auth: new Headers(init?.headers).get("Authorization") ?? "" });
    const r = respond(url, body);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as typeof fetch;
  return { calls, impl };
}

const config = { apiKey: "k", apiSecret: "s", sender: "0212345678", baseUrl: "https://sms.test" };

Deno.test("send posts every message once and maps failures back by key", async () => {
  const { calls, impl } = fakeFetch(() => ({
    body: { groupInfo: {}, failedMessageList: [{ statusMessage: "수신번호 형식 오류", customFields: { key: "parent" } }] },
  }));
  const results = await createSmsSender(config, impl).send([
    { key: "student", to: "01011112222", text: "비밀번호" },
    { key: "parent", to: "0101", text: "안내", subject: "외출 안내" },
  ]);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].url, "https://sms.test/messages/v4/send-many/detail");
  assertEquals(calls[0].auth.startsWith("HMAC-SHA256 apiKey=k, date="), true);
  assertEquals(calls[0].body.allowDuplicates, true); // 학생·학부모 번호가 같아도 둘 다 보냄
  assertEquals(calls[0].body.messages, [
    { to: "01011112222", from: "0212345678", text: "비밀번호", customFields: { key: "student" } },
    { to: "0101", from: "0212345678", text: "안내", subject: "외출 안내", customFields: { key: "parent" } },
  ]);
  assertEquals(results.get("student"), { ok: true });
  assertEquals(results.get("parent"), { ok: false, error: "수신번호 형식 오류" });
});

Deno.test("a rejected request marks every message as failed with the API's reason", async () => {
  const { impl } = fakeFetch(() => ({ status: 403, body: { errorCode: "Forbidden", errorMessage: "잔액이 부족합니다." } }));
  const results = await createSmsSender(config, impl).send([{ key: "a", to: "01011112222", text: "x" }]);
  assertEquals(results.get("a"), { ok: false, error: "잔액이 부족합니다." });
});

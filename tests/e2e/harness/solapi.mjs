// 솔라피(문자) API 흉내: Edge Function이 보내는 요청을 받아 쌓아 두고 성공으로 답한다(실제 문자는 나가지 않음).
// 인증 헤더(HMAC-SHA256)도 실제 서버처럼 확인한다.
import { createHmac } from "node:crypto";
import { createServer } from "node:http";

export const SOLAPI_TEST_ENV = {
  SOLAPI_API_KEY: "test-key",
  SOLAPI_API_SECRET: "test-secret",
  SMS_SENDER: "0212345678",
};

function verifyAuth(header) {
  const m = /^HMAC-SHA256 apiKey=([^,]+), date=([^,]+), salt=([^,]+), signature=([0-9a-f]+)$/.exec(header || "");
  if (!m || m[1] !== SOLAPI_TEST_ENV.SOLAPI_API_KEY) return false;
  const expected = createHmac("sha256", SOLAPI_TEST_ENV.SOLAPI_API_SECRET).update(m[2] + m[3]).digest("hex");
  return expected === m[4];
}

export class FakeSolapi {
  constructor() {
    this.reset();
    this.server = createServer((req, res) => this.handle(req, res));
  }

  // messages: 보낸 문자(to, from, text, subject, customFields)
  // failTo: 이 번호로 가는 문자는 실패로 답한다
  reset() {
    this.messages = [];
    this.failTo = new Set();
  }

  listen(port) {
    return new Promise((resolve) => this.server.listen(port, "127.0.0.1", () => resolve(`http://127.0.0.1:${port}`)));
  }

  close() {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  handle(req, res) {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const reply = (status, body) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (!verifyAuth(req.headers.authorization)) return reply(401, { errorCode: "Unauthorized", errorMessage: "인증 실패" });
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      if (req.url === "/messages/v4/send-many/detail") {
        const failed = [];
        for (const m of body.messages || []) {
          this.messages.push(m);
          if (this.failTo.has(m.to)) {
            failed.push({ to: m.to, statusCode: "1062", statusMessage: "수신번호 오류", customFields: m.customFields });
          }
        }
        return reply(200, { groupInfo: { count: { total: (body.messages || []).length } }, failedMessageList: failed });
      }
      return reply(404, { errorCode: "NotFound", errorMessage: req.url });
    });
  }
}

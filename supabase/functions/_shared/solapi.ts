// 솔라피(문자) REST API: HMAC 인증, 여러 건 한 번에 발송.
// 키는 Supabase Edge Function 시크릿(SOLAPI_API_KEY·SOLAPI_API_SECRET·SMS_SENDER)에만 둔다.
// 키가 없으면 smsConfigFromEnv가 null을 돌려주고, 부르는 쪽은 문자만 건너뛴다(외출 처리·계정 발급은 그대로).

type Env = { get(key: string): string | undefined };

export type SmsConfig = { apiKey: string; apiSecret: string; sender: string; baseUrl: string };

export type SmsMessage = {
  key: string; // 결과를 찾을 때 쓰는 이름(예: "student", "parent", 학생 id)
  to: string;
  text: string;
  subject?: string; // 장문(LMS)일 때만 쓰임
};

export type SmsResult = { ok: true } | { ok: false; error: string };

export interface SmsSender {
  send(messages: SmsMessage[]): Promise<Map<string, SmsResult>>;
}

const DEFAULT_BASE_URL = "https://api.solapi.com";

// 발신번호: 숫자만 8~12자리(유선·대표번호·휴대폰 모두)
export function normalizeSender(raw: string | undefined): string | null {
  const digits = String(raw ?? "").replace(/[^0-9]/g, "");
  return /^[0-9]{8,12}$/.test(digits) ? digits : null;
}

export function smsConfigFromEnv(env: Env = Deno.env): SmsConfig | null {
  const apiKey = env.get("SOLAPI_API_KEY")?.trim();
  const apiSecret = env.get("SOLAPI_API_SECRET")?.trim();
  const sender = normalizeSender(env.get("SMS_SENDER"));
  if (!apiKey || !apiSecret || !sender) return null;
  // SOLAPI_BASE_URL은 테스트에서 가짜 서버로 바꿀 때만 쓴다.
  const baseUrl = (env.get("SOLAPI_BASE_URL")?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");
  return { apiKey, apiSecret, sender, baseUrl };
}

function randomSalt(length = 32): string {
  const chars = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  return Array.from(crypto.getRandomValues(new Uint32Array(length)), (n) => chars[n % chars.length]).join("");
}

// 솔라피 API 키 인증: signature = HMAC-SHA256(secret, date + salt)를 16진수로.
export async function authorizationHeader(
  apiKey: string,
  apiSecret: string,
  date: string = new Date().toISOString(),
  salt: string = randomSalt(),
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(apiSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(date + salt)));
  const signature = Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
  return `HMAC-SHA256 apiKey=${apiKey}, date=${date}, salt=${salt}, signature=${signature}`;
}

function describeFailure(body: unknown, status: number): string {
  const b = body as { errorMessage?: string; errorCode?: string } | null;
  const text = b?.errorMessage || b?.errorCode || `HTTP ${status}`;
  return String(text).slice(0, 200);
}

export function createSmsSender(config: SmsConfig, fetchImpl: typeof fetch = fetch): SmsSender {
  async function request(path: string, body: unknown): Promise<unknown> {
    const res = await fetchImpl(`${config.baseUrl}/${path}`, {
      method: "POST",
      headers: {
        Authorization: await authorizationHeader(config.apiKey, config.apiSecret),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(describeFailure(data, res.status));
    return data;
  }

  return {
    async send(messages) {
      const results = new Map<string, SmsResult>();
      if (messages.length === 0) return results;
      let data: { failedMessageList?: Array<{ statusMessage?: string; customFields?: Record<string, string> }> };
      try {
        data = (await request("messages/v4/send-many/detail", {
          // 학생·학부모 번호가 같아도(시험할 때, 연락처를 하나만 아는 경우) 둘 다 보낸다.
          // 솔라피는 기본으로 한 번에 보내는 묶음 안의 같은 번호를 중복으로 막는다.
          allowDuplicates: true,
          messages: messages.map((m) => ({
            to: m.to,
            from: config.sender,
            text: m.text,
            ...(m.subject ? { subject: m.subject } : {}),
            // 단문/장문은 솔라피가 길이를 보고 고른다.
            customFields: { key: m.key },
          })),
        })) as typeof data;
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        for (const m of messages) results.set(m.key, { ok: false, error });
        return results;
      }
      for (const m of messages) results.set(m.key, { ok: true });
      for (const failed of data?.failedMessageList ?? []) {
        const key = failed.customFields?.key;
        if (key) results.set(key, { ok: false, error: String(failed.statusMessage || "발송 실패").slice(0, 200) });
      }
      return results;
    },
  };
}

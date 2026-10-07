// Edge Function 공통 HTTP 처리: CORS, JSON 응답, 에러 → 상태코드 변환.

export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const value = await req.json();
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // 아래에서 400으로 처리
  }
  throw new HttpError(400, "요청 형식이 올바르지 않습니다.");
}

export function serve(handler: (req: Request) => Promise<Response>): void {
  Deno.serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    if (req.method !== "POST") return jsonResponse(405, { error: "허용되지 않는 요청입니다." });
    try {
      return await handler(req);
    } catch (err) {
      if (err instanceof HttpError) return jsonResponse(err.status, { error: err.message });
      console.error(err);
      return jsonResponse(500, { error: "서버에서 오류가 발생했습니다. 잠시 후 다시 시도해 주세요." });
    }
  });
}

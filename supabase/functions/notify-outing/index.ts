import { jsonResponse, readJson, serve } from "../_shared/http.ts";
import { createAdminClient, getCaller } from "../_shared/supabase.ts";
import { createSmsSender, smsConfigFromEnv } from "../_shared/solapi.ts";
import { handleNotifyOuting, type NoticeStudent, type OutingRow } from "./handler.ts";

const OUTING_COLUMNS = "date, student_id, status, since, reason, start_time, expected_return, checked_by_name";

function todayKst(): string {
  // en-CA는 YYYY-MM-DD 형식
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());
}

serve(async (req) => {
  const admin = createAdminClient();
  const caller = await getCaller(req, admin);
  const body = await readJson(req);
  const smsConfig = smsConfigFromEnv();

  // service_role로 쓰므로 outings 트리거는 notice를 건드리지 않는다(교사가 상태를 바꿀 때만 비움).
  const result = await handleNotifyOuting(body, {
    caller,
    todayKst,
    now: () => new Date(),
    outings: {
      async claim(date, studentId, notice) {
        const { data, error } = await admin
          .from("outings")
          .update({ notice })
          .eq("date", date)
          .eq("student_id", studentId)
          .eq("status", "out")
          .is("notice", null)
          .select(OUTING_COLUMNS)
          .maybeSingle();
        if (error) throw error;
        return (data as OutingRow | null) ?? null;
      },
      async finish(date, studentId, notice) {
        const { error } = await admin
          .from("outings")
          .update({ notice })
          .eq("date", date)
          .eq("student_id", studentId)
          .eq("status", "out");
        if (error) throw error;
      },
    },
    students: {
      async get(id) {
        const { data, error } = await admin
          .from("students")
          .select("id, name, sid, cls, phone, parent_phone")
          .eq("id", id)
          .maybeSingle();
        if (error) throw error;
        return (data as NoticeStudent | null) ?? null;
      },
    },
    sms: smsConfig ? createSmsSender(smsConfig) : null,
  });
  return jsonResponse(200, result);
});

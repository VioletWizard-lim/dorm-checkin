-- 자동 복귀 예약을 외출이 있는 시간대에만(사용자 요청 — 1분마다 하루 종일 돌아 로그가 많았음).
-- 한국 시간 07:00~23:59에만 1분마다 private.auto_return_outings()를 부른다. pg_cron은 UTC 기준이라
-- KST 07~23시 = UTC 22~23시, 0~14시. 새벽(00:00~06:59)에 복귀 예정 시각이 지난 외출은 07:00 첫 실행 때 처리된다
-- (함수가 "예정 시각 <= 지금"인 오늘 외출을 모두 바꾸므로 밀린 것도 한 번에 처리됨).
-- 로컬 테스트 DB(supabase_admin 역할이 없음)에서는 건너뛴다. Supabase에서는 예외를 잡지 않는다(20261008040000_auto_return과 같음).
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'supabase_admin') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'auto-return-outings';
    perform cron.schedule('auto-return-outings', '* 0-14,22-23 * * *', 'select private.auto_return_outings()');
  else
    raise notice 'pg_cron 없음(테스트 DB) — 자동 복귀 예약은 건너뜀';
  end if;
end
$$;

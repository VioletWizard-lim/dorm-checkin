-- 자동 복귀(사용자 요청): 오늘 외출 중인 학생의 복귀 예정 시각(expected_return, "HH:MM")이 지나면 자동으로 재실로 바꾼다.
-- 1분마다 pg_cron이 private.auto_return_outings()를 부른다. 화면이 하나도 열려 있지 않아도 동작한다.
-- 복귀 예정 시각이 없거나("미정") HH:MM 형식이 아니면 그대로 둔다(교사가 복귀 체크).
-- 외출 기록(outing_log)에는 복귀 처리 교사 대신 "자동 복귀"로 남는다.

create function private.auto_return_outings() returns integer
  language plpgsql security definer set search_path = ''
  as $$
  declare
    v_now text := to_char(now() at time zone 'Asia/Seoul', 'HH24:MI');
    v_count integer;
  begin
    -- 서버가 직접 바꾸므로(auth.uid() 없음) 트리거가 시각·처리자를 채우지 않는다 → 여기서 넣는다
    update public.outings
       set status = 'in',
           since = now(),
           checked_by = null,
           checked_by_name = '자동 복귀',
           notice = null
     where date = public.today_kst()
       and status = 'out'
       and expected_return ~ '^[0-9]{1,2}:[0-5][0-9]$'
       and lpad(expected_return, 5, '0') <= v_now;
    get diagnostics v_count = row_count;
    return v_count;
  end;
  $$;
revoke execute on function private.auto_return_outings() from public, anon, authenticated;
grant execute on function private.auto_return_outings() to service_role;

-- pg_cron(Supabase 확장)으로 1분마다 실행. Supabase가 아닌 로컬 테스트 DB(supabase_admin 역할이 없음)에서는 건너뛴다.
-- Supabase에서는 일부러 예외를 잡지 않는다 — 켜지지 않으면 배포가 실패해서 바로 알 수 있게.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'supabase_admin') then
    create extension if not exists pg_cron;
    perform cron.unschedule(jobid) from cron.job where jobname = 'auto-return-outings';
    perform cron.schedule('auto-return-outings', '* * * * *', 'select private.auto_return_outings()');
  else
    raise notice 'pg_cron 없음(테스트 DB) — 자동 복귀 예약은 건너뜀';
  end if;
end
$$;

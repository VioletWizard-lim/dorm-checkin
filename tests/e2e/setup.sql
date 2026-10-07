-- E2E 테스트 전용 준비(실제 Supabase에는 적용하지 않음).

-- PostgREST가 접속하는 역할. 요청의 JWT role에 따라 anon/authenticated/service_role로 바꿔 실행한다.
create role authenticator login noinherit;
grant anon, authenticated, service_role to authenticator;

-- Realtime 흉내: 행이 바뀌면 NOTIFY로 알리고, 테스트 하네스(harness/realtime.mjs)가 받아서 브라우저에 보낸다.
create schema e2e;

create function e2e.notify_change() returns trigger
  language plpgsql
  as $$
  begin
    perform pg_notify('e2e_changes', json_build_object(
      'table', tg_table_name,
      'type', tg_op,
      'record', case when tg_op = 'DELETE' then null else to_jsonb(new) end,
      'old_record', case when tg_op = 'INSERT' then null else to_jsonb(old) end,
      'commit_timestamp', now()
    )::text);
    return null;
  end;
  $$;

create trigger e2e_notify after insert or update or delete on public.students
  for each row execute function e2e.notify_change();
create trigger e2e_notify after insert or update or delete on public.rooms
  for each row execute function e2e.notify_change();
create trigger e2e_notify after insert or update or delete on public.profiles
  for each row execute function e2e.notify_change();
create trigger e2e_notify after insert or update or delete on public.outing_requests
  for each row execute function e2e.notify_change();
create trigger e2e_notify after insert or update or delete on public.outings
  for each row execute function e2e.notify_change();

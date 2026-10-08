-- 사용자 요청 세 가지
--   1) 지난 날짜의 외출 기록은 고칠 수 없다(보기만) — outings 쓰기는 오늘(KST) 기록만
--   2) 외출 기록 화면(history.html)용 outing_log: 외출할 때마다 한 줄(외출 시각·복귀 시각·사유·확인 교사)
--      outings는 날짜·학생당 한 행이라 복귀하면 외출 정보가 지워지므로, 트리거가 따로 쌓아 둔다
--   3) 명령퇴사 기간은 관리자·기숙사부만(담임·학년부장은 못 바꿈)

-- ─────────────────────── 1) 지난 날짜는 보기만 ───────────────────────
drop policy outings_insert on public.outings;
drop policy outings_update on public.outings;
create policy outings_insert on public.outings for insert to authenticated
  with check ((select private.can_write_outings()) and date = (select public.today_kst()));
create policy outings_update on public.outings for update to authenticated
  using ((select private.can_write_outings()) and date = (select public.today_kst()))
  with check ((select private.can_write_outings()) and date = (select public.today_kst()));

-- ─────────────────────── 2) 외출 기록(outing_log) ───────────────────────
create table public.outing_log (
  id uuid primary key default gen_random_uuid(),
  date date not null,
  student_id uuid not null references public.students (id) on delete cascade,
  out_at timestamptz not null,       -- 외출 처리한 시각(외출 체크·신청 승인)
  start_time text,                   -- 학생이 신청한 외출 시각("19:00"), 교사가 직접 체크했으면 없음
  expected_return text,
  reason text,
  out_by_name text,                  -- 외출 확인 교사
  request_id uuid references public.outing_requests (id) on delete set null,
  ended_at timestamptz,              -- 복귀(또는 외출 취소) 처리한 시각, 아직 외출 중이면 없음
  ended_by_name text
);
create index outing_log_date_idx on public.outing_log (date);
create index outing_log_student_idx on public.outing_log (student_id, date);

alter table public.outing_log enable row level security;
revoke all on public.outing_log from anon, authenticated;
grant all on public.outing_log to service_role;
grant select on public.outing_log to authenticated;

-- 볼 수 있는 범위: 담임은 담당 반, 학년부장은 담당 학년, 관리자는 전체(= can_manage_student). 기숙사부·일반 교사·자습 감독은 못 봄
create policy outing_log_select on public.outing_log for select to authenticated
  using (exists (
    select 1 from public.students s
    where s.id = outing_log.student_id and private.can_manage_student(s.grade, s.cls)
  ));

-- outings가 바뀔 때 기록을 쌓는다: 외출이 시작되면 한 줄 추가, 끝나면(복귀·취소) 그 줄에 끝난 시각을 적음
create function private.outings_log_after() returns trigger
  language plpgsql security definer set search_path = ''
  as $$
  declare
    v_open uuid;
  begin
    if new.status = 'out' and (tg_op = 'INSERT' or old.status is distinct from 'out') then
      insert into public.outing_log (date, student_id, out_at, start_time, expected_return, reason, out_by_name, request_id)
      values (new.date, new.student_id, new.since, new.start_time, new.expected_return, new.reason, new.checked_by_name, new.request_id);
      return null;
    end if;
    if tg_op <> 'UPDATE' or old.status is distinct from 'out' then
      return null;
    end if;
    select id into v_open from public.outing_log
     where date = new.date and student_id = new.student_id and ended_at is null
     order by out_at desc limit 1;
    if v_open is null then
      return null;
    end if;
    if new.status <> 'out' then
      update public.outing_log set ended_at = new.since, ended_by_name = new.checked_by_name where id = v_open;
    elsif (new.reason, new.expected_return, new.start_time) is distinct from (old.reason, old.expected_return, old.start_time) then
      update public.outing_log
         set reason = new.reason, expected_return = new.expected_return, start_time = new.start_time
       where id = v_open;
    end if;
    return null;
  end;
  $$;
revoke execute on function private.outings_log_after() from public, anon, authenticated;

create trigger outings_log_after after insert or update on public.outings
  for each row execute function private.outings_log_after();

-- 지금까지의 기록으로 채워 둔다(교사가 직접 체크하고 이미 복귀한 외출은 남은 정보가 없어서 빠짐)
--   승인된 신청: 그 날 outings 행이 이미 외출이 아니면 그 시각을 복귀 시각으로
insert into public.outing_log (date, student_id, out_at, start_time, expected_return, reason, out_by_name, request_id, ended_at, ended_by_name)
select r.date, r.student_id, coalesce(r.decided_at, r.created_at), r.start_time, r.expected_return, r.reason, r.decided_by_name, r.id,
       case when o.status <> 'out' and o.since >= coalesce(r.decided_at, r.created_at) then o.since end,
       case when o.status <> 'out' and o.since >= coalesce(r.decided_at, r.created_at) then o.checked_by_name end
  from public.outing_requests r
  left join public.outings o on o.date = r.date and o.student_id = r.student_id
 where r.status = 'approved';
--   지금 외출 중인데 신청으로 나간 게 아닌 것(교사가 직접 체크)
insert into public.outing_log (date, student_id, out_at, start_time, expected_return, reason, out_by_name, request_id)
select o.date, o.student_id, o.since, o.start_time, o.expected_return, o.reason, o.checked_by_name, null
  from public.outings o
 where o.status = 'out'
   and not exists (select 1 from public.outing_log l where l.request_id = o.request_id and o.request_id is not null);

-- ─────────────────────── 3) 명령퇴사 기간은 관리자·기숙사부만 ───────────────────────
create function private.students_leave_editors() returns trigger
  language plpgsql security definer set search_path = ''
  as $$
  begin
    -- 서버 함수(service_role)는 그대로
    if (select auth.uid()) is null or private.has_staff_role('admin', 'dormStaff') then
      return new;
    end if;
    if (tg_op = 'INSERT' and (new.leave_from is not null or new.leave_to is not null or new.leave_reason is not null))
       or (tg_op = 'UPDATE' and (new.leave_from, new.leave_to, new.leave_reason)
                               is distinct from (old.leave_from, old.leave_to, old.leave_reason)) then
      raise exception '명령퇴사 기간은 관리자·기숙사부만 바꿀 수 있습니다.' using errcode = '42501';
    end if;
    return new;
  end;
  $$;
revoke execute on function private.students_leave_editors() from public, anon, authenticated;

create trigger students_leave_editors before insert or update on public.students
  for each row execute function private.students_leave_editors();

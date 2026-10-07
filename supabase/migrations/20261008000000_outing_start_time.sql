-- 외출 신청에 "외출 시각"(학생이 나가려는 시각, HH:MM)을 추가한다.
-- 승인하면 외출 기록(outings.start_time)으로 옮겨 화면·외출증에 쓴다. 교사가 직접 "외출 체크"한 기록은 비어 있고 since를 쓴다.

alter table public.outing_requests
  add column start_time text check (start_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');
alter table public.outings
  add column start_time text check (char_length(start_time) <= 20);

-- 외출이 아니게 되면 외출 시각도 비운다(사유·예상 복귀와 같이).
create or replace function public.outings_before_write() returns trigger
  language plpgsql security definer set search_path = ''
  as $$
  declare
    v_uid uuid := (select auth.uid());
  begin
    if v_uid is not null and (tg_op = 'INSERT' or new.status is distinct from old.status) then
      new.since := now();
      new.checked_by := v_uid;
      select coalesce(nullif(p.name, ''), p.login_id) into new.checked_by_name
        from public.profiles p where p.id = v_uid;
      new.notice := null;
    end if;
    if new.status <> 'out' then
      new.reason := null;
      new.expected_return := null;
      new.start_time := null;
      new.request_id := null;
    end if;
    return new;
  end;
  $$;

-- 매개변수가 늘어나므로 새로 만든다(예전 화면이 p_reason·p_expected_return만 보내도 그대로 동작).
drop function public.create_outing_request(text, text);

create function public.create_outing_request(
  p_reason text,
  p_expected_return text default null,
  p_start_time text default null
)
  returns public.outing_requests
  language plpgsql security definer set search_path = ''
  as $$
  declare
    v_profile public.profiles;
    v_student public.students;
    v_today date := public.today_kst();
    v_reason text := btrim(coalesce(p_reason, ''));
    v_return text := nullif(btrim(coalesce(p_expected_return, '')), '');
    v_start text := nullif(btrim(coalesce(p_start_time, '')), '');
    v_request public.outing_requests;
  begin
    select * into v_profile from public.profiles where id = (select auth.uid());
    if v_profile.id is null or v_profile.kind <> 'student' or v_profile.disabled then
      raise exception '학생 계정만 외출을 신청할 수 있습니다.' using errcode = '42501';
    end if;
    select * into v_student from public.students where id = v_profile.student_id;
    if v_reason = '' then
      raise exception '외출 사유를 입력해 주세요.';
    end if;
    if char_length(v_reason) > 200 then
      raise exception '외출 사유는 200자 이내로 입력해 주세요.';
    end if;
    if v_start is not null and v_start !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
      raise exception '외출 시각은 00:00 ~ 23:59 형식으로 입력해 주세요.';
    end if;
    if char_length(v_return) > 20 then
      raise exception '예상 복귀 시각은 20자 이내로 입력해 주세요.';
    end if;
    if v_student.leave_from is not null and v_today between v_student.leave_from and v_student.leave_to then
      raise exception '명령퇴사 기간에는 외출을 신청할 수 없습니다.';
    end if;
    if exists (select 1 from public.outings o where o.date = v_today and o.student_id = v_student.id and o.status = 'out') then
      raise exception '이미 외출 중입니다.';
    end if;
    if exists (select 1 from public.outing_requests r
               where r.student_id = v_student.id and r.date = v_today and r.status = 'pending') then
      raise exception '이미 승인을 기다리는 신청이 있습니다.';
    end if;
    insert into public.outing_requests (date, student_id, requested_by, reason, start_time, expected_return)
    values (v_today, v_student.id, v_profile.id, v_reason, v_start, v_return)
    returning * into v_request;
    return v_request;
  end;
  $$;

create or replace function public.approve_outing_request(p_request_id uuid) returns public.outings
  language plpgsql security definer set search_path = ''
  as $$
  declare
    v_request public.outing_requests;
    v_student public.students;
    v_name text;
    v_outing public.outings;
  begin
    select * into v_request from public.outing_requests where id = p_request_id for update;
    if v_request.id is null then
      raise exception '신청을 찾을 수 없습니다.';
    end if;
    select * into v_student from public.students where id = v_request.student_id;
    if not public.can_manage_student(v_student.grade, v_student.cls) then
      raise exception '이 학생의 신청을 처리할 권한이 없습니다.' using errcode = '42501';
    end if;
    if v_request.status <> 'pending' then
      raise exception '이미 처리된 신청입니다.';
    end if;
    if v_request.date <> public.today_kst() then
      raise exception '지난 날짜의 신청은 승인할 수 없습니다.';
    end if;
    select coalesce(nullif(p.name, ''), p.login_id) into v_name from public.profiles p where p.id = (select auth.uid());

    update public.outing_requests
       set status = 'approved', decided_by = (select auth.uid()), decided_by_name = v_name, decided_at = now()
     where id = v_request.id;

    insert into public.outings (date, student_id, status, reason, start_time, expected_return, request_id)
    values (v_request.date, v_request.student_id, 'out', v_request.reason, v_request.start_time,
            v_request.expected_return, v_request.id)
    on conflict (date, student_id) do update
      set status = 'out',
          reason = excluded.reason,
          start_time = excluded.start_time,
          expected_return = excluded.expected_return,
          request_id = excluded.request_id
    returning * into v_outing;
    return v_outing;
  end;
  $$;

revoke execute on function public.create_outing_request(text, text, text) from public, anon;
grant execute on function public.create_outing_request(text, text, text) to authenticated, service_role;

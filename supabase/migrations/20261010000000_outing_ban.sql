-- 외출 금지(사용자 요청): 학년부장(담당 학년)·관리자가 학생별로 기간(시작일~종료일)과 사유를 정한다.
--   - 금지 기간에는 학생 화면의 외출 신청을 거부한다(outing_requests 트리거)
--   - 외출 처리(외출 체크·신청 승인 → 'out')는 학년부장(그 학생의 학년)·관리자만. 담임·자습 감독 등은 거부(outings 트리거)
--   - 금지 칸(ban_*)은 학년부장(담당 학년)·관리자만 바꿀 수 있다(students 트리거). 서버 함수(service_role)는 그대로

alter table public.students
  add column ban_from date,
  add column ban_to date,
  add column ban_reason text check (char_length(ban_reason) <= 200),
  add constraint students_ban_pair check ((ban_from is null) = (ban_to is null)),
  add constraint students_ban_order check (ban_from is null or ban_to >= ban_from);

-- 그 학년의 학년부장 또는 관리자인지
create function private.is_grade_head_of(p_grade smallint) returns boolean
  language sql stable security definer set search_path = ''
  as $$
    select exists (
      select 1 from public.profiles p
      where p.id = (select auth.uid()) and p.kind = 'staff' and not p.disabled and (
        p.role = 'admin'
        or (p.role = 'gradeManager' and p_grade = any (p.managed_grades))
      )
    )
  $$;
revoke execute on function private.is_grade_head_of(smallint) from public, anon;
grant execute on function private.is_grade_head_of(smallint) to authenticated, service_role;

-- 그 날짜에 외출 금지 기간인지(금지 종료일을 돌려줌, 아니면 null)
create function private.outing_ban_until(p_student_id uuid, p_date date) returns date
  language sql stable security definer set search_path = ''
  as $$
    select s.ban_to from public.students s
     where s.id = p_student_id and s.ban_from <= p_date and s.ban_to >= p_date
  $$;
revoke execute on function private.outing_ban_until(uuid, date) from public, anon;
grant execute on function private.outing_ban_until(uuid, date) to authenticated, service_role;

create function private.students_ban_editors() returns trigger
  language plpgsql security definer set search_path = ''
  as $$
  begin
    if (select auth.uid()) is null then
      return new;
    end if;
    if (tg_op = 'INSERT' and (new.ban_from is not null or new.ban_to is not null or new.ban_reason is not null))
       or (tg_op = 'UPDATE' and (new.ban_from, new.ban_to, new.ban_reason) is distinct from (old.ban_from, old.ban_to, old.ban_reason)) then
      if not private.is_grade_head_of(new.grade) or (tg_op = 'UPDATE' and not private.is_grade_head_of(old.grade)) then
        raise exception '외출 금지는 학년부장·관리자만 정할 수 있습니다.' using errcode = '42501';
      end if;
    end if;
    return new;
  end;
  $$;
revoke execute on function private.students_ban_editors() from public, anon, authenticated;

create trigger students_ban_editors before insert or update on public.students
  for each row execute function private.students_ban_editors();

-- 학생 외출 신청: 금지 기간이면 거부
create function private.outing_requests_ban_check() returns trigger
  language plpgsql security definer set search_path = ''
  as $$
  declare
    v_until date := private.outing_ban_until(new.student_id, new.date);
  begin
    if v_until is not null then
      raise exception '외출 금지 기간입니다(~%). 외출이 꼭 필요하면 학년부장 선생님께 말씀드리세요.', to_char(v_until, 'MM/DD');
    end if;
    return new;
  end;
  $$;
revoke execute on function private.outing_requests_ban_check() from public, anon, authenticated;

create trigger outing_requests_ban_check before insert on public.outing_requests
  for each row execute function private.outing_requests_ban_check();

-- 외출 처리(→ 'out'): 금지 기간이면 그 학생의 학년부장·관리자만
create function private.outings_check_ban() returns trigger
  language plpgsql security definer set search_path = ''
  as $$
  declare
    v_old text := case when tg_op = 'UPDATE' then old.status else 'in' end;
    v_grade smallint;
  begin
    if (select auth.uid()) is null or new.status <> 'out' or v_old = 'out'
       or private.outing_ban_until(new.student_id, new.date) is null then
      return new;
    end if;
    select s.grade into v_grade from public.students s where s.id = new.student_id;
    if not private.is_grade_head_of(v_grade) then
      raise exception '외출 금지 학생입니다. 학년부장·관리자만 외출 처리할 수 있습니다.' using errcode = '42501';
    end if;
    return new;
  end;
  $$;
revoke execute on function private.outings_check_ban() from public, anon, authenticated;

-- 이름 순서: outings_before_write → outings_check_ban → outings_check_scope → outings_require_return
create trigger outings_check_ban before insert or update on public.outings
  for each row execute function private.outings_check_ban();

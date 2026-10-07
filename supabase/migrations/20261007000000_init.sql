-- 기숙사 외출체크 시스템 — Supabase 초기 스키마.
-- 여러 행·테이블을 함께 바꾸는 작업(신청 승인, 좌석 배정 등)은 RPC(security definer)로만 열어서,
-- 서버가 권한을 확인한 뒤 한 트랜잭션으로 처리한다.

-- ───────────────────────────── 테이블 ─────────────────────────────

create table public.students (
  id uuid primary key default gen_random_uuid(),
  grade smallint not null check (grade between 1 and 3),
  name text not null check (char_length(name) between 1 and 100),
  sid text not null default '',
  cls text not null default '',
  -- 학생 로그인 아이디(리로스쿨 ID). 소문자로 저장한다.
  login_id text unique check (login_id ~ '^[a-z0-9._-]{1,64}$'),
  phone text check (phone ~ '^01[0-9]{8,9}$'),
  parent_phone text check (parent_phone ~ '^01[0-9]{8,9}$'),
  email text,
  afterschool_days boolean[] not null default '{f,f,f,f,f}' check (array_length(afterschool_days, 1) = 5),
  leave_from date,
  leave_to date,
  leave_reason text,
  legacy_key text unique,
  created_at timestamptz not null default now(),
  constraint students_leave_pair check ((leave_from is null) = (leave_to is null)),
  constraint students_leave_order check (leave_from is null or leave_to >= leave_from)
);
create index students_grade_idx on public.students (grade);

create table public.rooms (
  id uuid primary key default gen_random_uuid(),
  name text not null default '새 실',
  grades smallint[] not null default '{}',
  rows smallint not null default 3 check (rows between 1 and 50),
  cols smallint not null default 4 check (cols between 1 and 50),
  -- {"r0c0": "<students.id>"}
  seat_map jsonb not null default '{}'::jsonb check (jsonb_typeof(seat_map) = 'object'),
  legacy_key text unique,
  created_at timestamptz not null default now()
);

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  login_id text not null,
  kind text not null check (kind in ('staff', 'student')),
  role text check (role in ('teacher', 'gradeManager', 'admin', 'studyHallSupervisor', 'dormStaff', 'student')),
  name text,
  disabled boolean not null default false,
  managed_grades smallint[] not null default '{}',
  managed_rooms uuid[] not null default '{}',
  -- 담임 반: [{"grade": 1, "cls": "1학년 3반"}] — grade는 반드시 숫자(can_manage_student의 포함 비교가 타입까지 본다)
  managed_classes jsonb not null default '[]'::jsonb check (jsonb_typeof(managed_classes) = 'array'),
  student_id uuid unique references public.students (id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint profiles_login_unique unique (kind, login_id),
  constraint profiles_kind_role check (
    (kind = 'student' and role = 'student' and student_id is not null)
    or (kind = 'staff' and (role is null or role <> 'student') and student_id is null)
  )
);

create table public.outing_requests (
  id uuid primary key default gen_random_uuid(),
  date date not null,
  student_id uuid not null references public.students (id) on delete cascade,
  requested_by uuid not null references public.profiles (id) on delete cascade,
  reason text not null check (char_length(reason) between 1 and 200),
  expected_return text check (char_length(expected_return) <= 20),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  decided_by uuid references public.profiles (id) on delete set null,
  decided_by_name text,
  decided_at timestamptz,
  reject_reason text check (char_length(reject_reason) <= 200),
  created_at timestamptz not null default now()
);
create index outing_requests_date_idx on public.outing_requests (date, status);
create unique index outing_requests_one_pending_per_day on public.outing_requests (student_id, date) where status = 'pending';

create table public.outings (
  date date not null,
  student_id uuid not null references public.students (id) on delete cascade,
  status text not null check (status in ('in', 'out', 'away')),
  since timestamptz not null default now(),
  reason text,
  expected_return text,
  checked_by uuid references public.profiles (id) on delete set null,
  checked_by_name text,
  request_id uuid references public.outing_requests (id) on delete set null,
  -- 문자 발송 결과(notify-outing Edge Function이 기록)
  notice jsonb,
  primary key (date, student_id)
);
create index outings_student_idx on public.outings (student_id);

-- ─────────────────────────── 권한 판정 함수 ───────────────────────────
-- RLS 정책과 RPC가 같이 쓴다. security definer라서 정책 안에서 profiles를 읽어도 재귀하지 않는다.

create function public.today_kst() returns date
  language sql stable set search_path = ''
  as $$ select (now() at time zone 'Asia/Seoul')::date $$;

create function public.is_staff() returns boolean
  language sql stable security definer set search_path = ''
  as $$
    select exists (
      select 1 from public.profiles p
      where p.id = (select auth.uid()) and p.kind = 'staff' and p.role is not null and not p.disabled
    )
  $$;

create function public.has_staff_role(variadic p_roles text[]) returns boolean
  language sql stable security definer set search_path = ''
  as $$
    select exists (
      select 1 from public.profiles p
      where p.id = (select auth.uid()) and p.kind = 'staff' and not p.disabled and p.role = any (p_roles)
    )
  $$;

create function public.is_admin() returns boolean
  language sql stable security definer set search_path = ''
  as $$ select public.has_staff_role('admin') $$;

-- 기숙사부는 계정 관리만 빼고 관리자와 같은 권한을 가진다.
create function public.is_admin_like() returns boolean
  language sql stable security definer set search_path = ''
  as $$ select public.has_staff_role('admin', 'dormStaff') $$;

-- 학생 명단 관리·외출 신청 승인 범위: 관리자·기숙사부는 전체, 학년부장은 담당 학년, 담임은 담당 반.
create function public.can_manage_student(p_grade smallint, p_cls text) returns boolean
  language sql stable security definer set search_path = ''
  as $$
    select exists (
      select 1 from public.profiles p
      where p.id = (select auth.uid()) and p.kind = 'staff' and not p.disabled and (
        p.role in ('admin', 'dormStaff')
        or (p.role = 'gradeManager' and p_grade = any (p.managed_grades))
        or (p.role = 'teacher'
            and p.managed_classes @> jsonb_build_array(jsonb_build_object('grade', p_grade, 'cls', p_cls)))
      )
    )
  $$;

create function public.can_edit_room(p_room_id uuid) returns boolean
  language sql stable security definer set search_path = ''
  as $$
    select exists (
      select 1 from public.profiles p
      where p.id = (select auth.uid()) and p.kind = 'staff' and not p.disabled and (
        p.role in ('admin', 'dormStaff')
        or (p.role = 'gradeManager' and p_room_id = any (p.managed_rooms))
      )
    )
  $$;

create function public.my_student_id() returns uuid
  language sql stable security definer set search_path = ''
  as $$
    select p.student_id from public.profiles p
    where p.id = (select auth.uid()) and p.kind = 'student' and not p.disabled
  $$;

-- ───────────────────────────── 트리거 ─────────────────────────────

-- 외출 상태가 바뀌면 시각·담당 교사를 서버에서 채운다(클라이언트가 보낸 값은 쓰지 않음).
-- service_role(이전 스크립트·Edge Function)은 auth.uid()가 없으므로 보낸 값을 그대로 둔다.
create function public.outings_before_write() returns trigger
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
      new.request_id := null;
    end if;
    return new;
  end;
  $$;
create trigger outings_before_write before insert or update on public.outings
  for each row execute function public.outings_before_write();

create function public.students_before_update() returns trigger
  language plpgsql security definer set search_path = ''
  as $$
  begin
    if new.login_id is distinct from old.login_id
       and exists (select 1 from public.profiles p where p.student_id = old.id) then
      raise exception '계정이 발급된 학생의 아이디는 바꿀 수 없습니다. 계정을 삭제한 뒤 다시 발급해 주세요.';
    end if;
    return new;
  end;
  $$;
create trigger students_before_update before update on public.students
  for each row execute function public.students_before_update();

-- 학생을 지우면 좌석표에 남은 자리도 비운다.
create function public.students_after_delete() returns trigger
  language plpgsql security definer set search_path = ''
  as $$
  begin
    update public.rooms r
       set seat_map = (
         select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
           from jsonb_each(r.seat_map) e
          where e.value <> to_jsonb(old.id::text)
       )
     where exists (select 1 from jsonb_each(r.seat_map) e where e.value = to_jsonb(old.id::text));
    return old;
  end;
  $$;
create trigger students_after_delete after delete on public.students
  for each row execute function public.students_after_delete();

-- ────────────────────────────── RLS ──────────────────────────────

alter table public.students enable row level security;
alter table public.rooms enable row level security;
alter table public.profiles enable row level security;
alter table public.outing_requests enable row level security;
alter table public.outings enable row level security;

-- 테이블 권한은 프로젝트의 기본 권한 설정(새 테이블 자동 노출 여부)과 상관없이 같은 결과가 나오도록 명시적으로 준다.
-- 행 단위 허용 여부는 아래 RLS 정책이 정한다. service_role은 RLS를 우회하지만 테이블 권한은 따로 필요하다.
revoke all on public.students, public.rooms, public.profiles, public.outing_requests, public.outings from anon, authenticated;
grant all on public.students, public.rooms, public.profiles, public.outing_requests, public.outings to service_role;
grant select, insert, update, delete on public.students, public.rooms to authenticated;
grant select, insert, update on public.outings to authenticated;
grant select on public.profiles, public.outing_requests to authenticated;
grant update (role, name, managed_grades, managed_rooms, managed_classes) on public.profiles to authenticated;

-- profiles: 교직원은 전체, 그 외는 자기 것만 읽음. 관리자만 다른 교직원의 역할·이름·담당 범위를 수정(자기 자신 제외).
-- 계정 생성·삭제·비활성화는 Edge Function(service_role)만 한다.
create policy profiles_select on public.profiles for select to authenticated
  using (id = (select auth.uid()) or (select public.is_staff()));
create policy profiles_update on public.profiles for update to authenticated
  using ((select public.is_admin()) and kind = 'staff' and id <> (select auth.uid()))
  with check ((select public.is_admin()) and kind = 'staff' and id <> (select auth.uid()));

-- students: 교직원 전체 + 학생 본인 읽기. 쓰기는 담당 범위(반 단위까지 서버에서 강제).
create policy students_select on public.students for select to authenticated
  using ((select public.is_staff()) or id = (select public.my_student_id()));
create policy students_insert on public.students for insert to authenticated
  with check (public.can_manage_student(grade, cls));
create policy students_update on public.students for update to authenticated
  using (public.can_manage_student(grade, cls))
  with check (public.can_manage_student(grade, cls));
create policy students_delete on public.students for delete to authenticated
  using (public.can_manage_student(grade, cls));

-- rooms: 교직원 읽기. 실 추가·삭제·이름·학년·크기는 관리자·기숙사부. 학년부장의 좌석 배정은 assign_seat/unassign_seat RPC로.
create policy rooms_select on public.rooms for select to authenticated
  using ((select public.is_staff()));
create policy rooms_insert on public.rooms for insert to authenticated
  with check ((select public.is_admin_like()));
create policy rooms_update on public.rooms for update to authenticated
  using ((select public.is_admin_like()))
  with check ((select public.is_admin_like()));
create policy rooms_delete on public.rooms for delete to authenticated
  using ((select public.is_admin_like()));

-- outings: 교직원 읽기·쓰기, 학생은 자기 기록만 읽기. 삭제는 없음(재실로 되돌리는 방식).
create policy outings_select on public.outings for select to authenticated
  using ((select public.is_staff()) or student_id = (select public.my_student_id()));
create policy outings_insert on public.outings for insert to authenticated
  with check ((select public.is_staff()));
create policy outings_update on public.outings for update to authenticated
  using ((select public.is_staff()))
  with check ((select public.is_staff()));

-- outing_requests: 교직원 + 신청한 학생 본인 읽기. 쓰기는 아래 RPC로만.
create policy outing_requests_select on public.outing_requests for select to authenticated
  using ((select public.is_staff()) or requested_by = (select auth.uid()));

-- ────────────────────────────── RPC ──────────────────────────────

-- 좌석 배정: 그 학생이 다른 자리(다른 실 포함)에 있던 기록은 지우고 새 자리에 앉힌다.
create function public.assign_seat(p_room_id uuid, p_cell_key text, p_student_id uuid) returns void
  language plpgsql security definer set search_path = ''
  as $$
  declare
    v_room public.rooms;
    v_grade smallint;
  begin
    if not public.can_edit_room(p_room_id) then
      raise exception '이 실의 좌석을 편집할 권한이 없습니다.' using errcode = '42501';
    end if;
    select * into v_room from public.rooms where id = p_room_id for update;
    if v_room.id is null then
      raise exception '실을 찾을 수 없습니다.';
    end if;
    if p_cell_key !~ '^r[0-9]+c[0-9]+$'
       or substring(p_cell_key from '^r([0-9]+)c')::int >= v_room.rows
       or substring(p_cell_key from 'c([0-9]+)$')::int >= v_room.cols then
      raise exception '좌석 위치가 올바르지 않습니다.';
    end if;
    select s.grade into v_grade from public.students s where s.id = p_student_id;
    if v_grade is null then
      raise exception '학생을 찾을 수 없습니다.';
    end if;
    if not (v_grade = any (v_room.grades)) then
      raise exception '이 실의 대상 학년이 아닌 학생입니다.';
    end if;

    update public.rooms r
       set seat_map = (
         select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
           from jsonb_each(r.seat_map) e
          where e.value <> to_jsonb(p_student_id::text)
       )
     where exists (select 1 from jsonb_each(r.seat_map) e where e.value = to_jsonb(p_student_id::text));

    update public.rooms
       set seat_map = seat_map || jsonb_build_object(p_cell_key, p_student_id::text)
     where id = p_room_id;
  end;
  $$;

create function public.unassign_seat(p_room_id uuid, p_cell_key text) returns void
  language plpgsql security definer set search_path = ''
  as $$
  begin
    if not public.can_edit_room(p_room_id) then
      raise exception '이 실의 좌석을 편집할 권한이 없습니다.' using errcode = '42501';
    end if;
    update public.rooms set seat_map = seat_map - p_cell_key where id = p_room_id;
  end;
  $$;

-- 행/열 크기 변경: 줄어든 범위 밖의 좌석 배정은 함께 지운다.
create function public.resize_room(p_room_id uuid, p_rows integer, p_cols integer) returns void
  language plpgsql security definer set search_path = ''
  as $$
  begin
    if not public.is_admin_like() then
      raise exception '실 크기를 바꿀 권한이 없습니다.' using errcode = '42501';
    end if;
    if p_rows not between 1 and 50 or p_cols not between 1 and 50 then
      raise exception '행/열은 1~50 사이여야 합니다.';
    end if;
    update public.rooms r
       set rows = p_rows,
           cols = p_cols,
           seat_map = (
             select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
               from jsonb_each(r.seat_map) e
              where e.key ~ '^r[0-9]+c[0-9]+$'
                and substring(e.key from '^r([0-9]+)c')::int < p_rows
                and substring(e.key from 'c([0-9]+)$')::int < p_cols
           )
     where r.id = p_room_id;
    if not found then
      raise exception '실을 찾을 수 없습니다.';
    end if;
  end;
  $$;

-- 학생 외출 신청. 학생 정보는 로그인한 계정에서 서버가 찾으므로 다른 학생 이름으로 신청할 수 없다.
create function public.create_outing_request(p_reason text, p_expected_return text default null)
  returns public.outing_requests
  language plpgsql security definer set search_path = ''
  as $$
  declare
    v_profile public.profiles;
    v_student public.students;
    v_today date := public.today_kst();
    v_reason text := btrim(coalesce(p_reason, ''));
    v_return text := nullif(btrim(coalesce(p_expected_return, '')), '');
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
    insert into public.outing_requests (date, student_id, requested_by, reason, expected_return)
    values (v_today, v_student.id, v_profile.id, v_reason, v_return)
    returning * into v_request;
    return v_request;
  end;
  $$;

create function public.cancel_outing_request(p_request_id uuid) returns public.outing_requests
  language plpgsql security definer set search_path = ''
  as $$
  declare
    v_request public.outing_requests;
  begin
    update public.outing_requests
       set status = 'cancelled'
     where id = p_request_id and requested_by = (select auth.uid()) and status = 'pending'
    returning * into v_request;
    if v_request.id is null then
      raise exception '취소할 수 있는 신청이 없습니다.';
    end if;
    return v_request;
  end;
  $$;

-- 승인: 신청 상태 변경 + 외출 기록을 한 트랜잭션으로. 승인 범위는 can_manage_student와 같다.
create function public.approve_outing_request(p_request_id uuid) returns public.outings
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

    insert into public.outings (date, student_id, status, reason, expected_return, request_id)
    values (v_request.date, v_request.student_id, 'out', v_request.reason, v_request.expected_return, v_request.id)
    on conflict (date, student_id) do update
      set status = 'out',
          reason = excluded.reason,
          expected_return = excluded.expected_return,
          request_id = excluded.request_id
    returning * into v_outing;
    return v_outing;
  end;
  $$;

create function public.reject_outing_request(p_request_id uuid, p_reason text default null)
  returns public.outing_requests
  language plpgsql security definer set search_path = ''
  as $$
  declare
    v_request public.outing_requests;
    v_student public.students;
    v_name text;
    v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
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
    if char_length(v_reason) > 200 then
      raise exception '반려 사유는 200자 이내로 입력해 주세요.';
    end if;
    select coalesce(nullif(p.name, ''), p.login_id) into v_name from public.profiles p where p.id = (select auth.uid());

    update public.outing_requests
       set status = 'rejected', reject_reason = v_reason,
           decided_by = (select auth.uid()), decided_by_name = v_name, decided_at = now()
     where id = v_request.id
    returning * into v_request;
    return v_request;
  end;
  $$;

-- ──────────────────────────── 함수 실행 권한 ────────────────────────────
-- Supabase는 새 함수에 anon 실행 권한을 기본으로 주므로 명시적으로 걷어낸다.

revoke execute on function
  public.today_kst(),
  public.is_staff(),
  public.has_staff_role(text[]),
  public.is_admin(),
  public.is_admin_like(),
  public.can_manage_student(smallint, text),
  public.can_edit_room(uuid),
  public.my_student_id(),
  public.assign_seat(uuid, text, uuid),
  public.unassign_seat(uuid, text),
  public.resize_room(uuid, integer, integer),
  public.create_outing_request(text, text),
  public.cancel_outing_request(uuid),
  public.approve_outing_request(uuid),
  public.reject_outing_request(uuid, text),
  public.outings_before_write(),
  public.students_before_update(),
  public.students_after_delete()
from public, anon;

grant execute on function
  public.today_kst(),
  public.is_staff(),
  public.has_staff_role(text[]),
  public.is_admin(),
  public.is_admin_like(),
  public.can_manage_student(smallint, text),
  public.can_edit_room(uuid),
  public.my_student_id(),
  public.assign_seat(uuid, text, uuid),
  public.unassign_seat(uuid, text),
  public.resize_room(uuid, integer, integer),
  public.create_outing_request(text, text),
  public.cancel_outing_request(uuid),
  public.approve_outing_request(uuid),
  public.reject_outing_request(uuid, text)
to authenticated, service_role;

-- ──────────────────────────── Realtime ────────────────────────────

alter publication supabase_realtime add table
  public.students, public.rooms, public.profiles, public.outing_requests, public.outings;

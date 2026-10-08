-- Supabase 보안 점검(Security Advisor)의 "SECURITY DEFINER 함수를 API로 부를 수 있음" 경고 정리.
--
-- public 스키마는 API(/rest/v1/rpc)로 그대로 열려 있어서, 그 안의 security definer 함수는 로그인한 누구나
-- 직접 부를 수 있다. 그래서
--   1) RLS 정책·RPC가 안에서 쓰는 권한 판정 함수(is_staff 등)는 API로 열리지 않는 private 스키마로 옮기고
--   2) 화면이 부르는 RPC(좌석 배정·외출 신청 등)는 본체를 private로 옮긴 뒤, public에는 같은 이름·인자의
--      security invoker 껍데기만 둔다(본체가 권한을 직접 확인하는 건 그대로).
-- RLS 정책은 함수를 이름이 아니라 oid로 기억하므로 스키마를 옮겨도 그대로 동작한다.

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;

-- 1) 권한 판정 함수
alter function public.is_staff() set schema private;
alter function public.has_staff_role(text[]) set schema private;
alter function public.is_admin() set schema private;
alter function public.is_admin_like() set schema private;
alter function public.can_manage_student(smallint, text) set schema private;
alter function public.can_edit_room(uuid) set schema private;
alter function public.my_student_id() set schema private;

-- 2) RPC 본체
alter function public.assign_seat(uuid, text, uuid) set schema private;
alter function public.unassign_seat(uuid, text) set schema private;
alter function public.resize_room(uuid, integer, integer) set schema private;
alter function public.create_outing_request(text, text, text) set schema private;
alter function public.cancel_outing_request(uuid) set schema private;
alter function public.approve_outing_request(uuid) set schema private;
alter function public.reject_outing_request(uuid, text) set schema private;

-- 함수 본문은 글자로 저장돼 있어서(search_path = '') 안에 적힌 "public.is_admin_like(" 같은 이름은
-- 직접 바꿔 줘야 한다. 옮긴 함수의 정의를 꺼내 이름만 바꿔 다시 만든다.
do $$
declare
  v_fn record;
  v_def text;
begin
  for v_fn in
    select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('public', 'private') and p.prokind = 'f'
  loop
    v_def := pg_get_functiondef(v_fn.oid);
    if v_def ~ 'public\.(is_staff|has_staff_role|is_admin_like|is_admin|can_manage_student|can_edit_room|my_student_id)\(' then
      v_def := regexp_replace(
        v_def,
        'public\.(is_staff|has_staff_role|is_admin_like|is_admin|can_manage_student|can_edit_room|my_student_id)\(',
        'private.\1(',
        'g'
      );
      execute v_def;
    end if;
  end loop;
end
$$;

-- public 껍데기(화면이 부르는 이름·인자 그대로). security invoker라 경고 대상이 아니고,
-- 실제 권한 확인과 쓰기는 private 본체(security definer)가 한다.
create function public.assign_seat(p_room_id uuid, p_cell_key text, p_student_id uuid) returns void
  language sql security invoker set search_path = ''
  as $$ select private.assign_seat(p_room_id, p_cell_key, p_student_id) $$;

create function public.unassign_seat(p_room_id uuid, p_cell_key text) returns void
  language sql security invoker set search_path = ''
  as $$ select private.unassign_seat(p_room_id, p_cell_key) $$;

create function public.resize_room(p_room_id uuid, p_rows integer, p_cols integer) returns void
  language sql security invoker set search_path = ''
  as $$ select private.resize_room(p_room_id, p_rows, p_cols) $$;

create function public.create_outing_request(
  p_reason text,
  p_expected_return text default null,
  p_start_time text default null
)
  returns public.outing_requests
  language sql security invoker set search_path = ''
  as $$ select * from private.create_outing_request(p_reason, p_expected_return, p_start_time) $$;

create function public.cancel_outing_request(p_request_id uuid) returns public.outing_requests
  language sql security invoker set search_path = ''
  as $$ select * from private.cancel_outing_request(p_request_id) $$;

create function public.approve_outing_request(p_request_id uuid) returns public.outings
  language sql security invoker set search_path = ''
  as $$ select * from private.approve_outing_request(p_request_id) $$;

create function public.reject_outing_request(p_request_id uuid, p_reason text default null)
  returns public.outing_requests
  language sql security invoker set search_path = ''
  as $$ select * from private.reject_outing_request(p_request_id, p_reason) $$;

-- Supabase는 새 함수에 anon 실행 권한을 기본으로 주므로 걷어낸다(옮긴 함수는 원래 권한을 그대로 가짐).
revoke execute on function
  public.assign_seat(uuid, text, uuid),
  public.unassign_seat(uuid, text),
  public.resize_room(uuid, integer, integer),
  public.create_outing_request(text, text, text),
  public.cancel_outing_request(uuid),
  public.approve_outing_request(uuid),
  public.reject_outing_request(uuid, text)
from public, anon;

grant execute on function
  public.assign_seat(uuid, text, uuid),
  public.unassign_seat(uuid, text),
  public.resize_room(uuid, integer, integer),
  public.create_outing_request(text, text, text),
  public.cancel_outing_request(uuid),
  public.approve_outing_request(uuid),
  public.reject_outing_request(uuid, text)
to authenticated, service_role;

-- rls_auto_enable()은 Supabase가 프로젝트를 만들 때 넣은 함수(새 테이블에 RLS를 자동으로 켜는 이벤트 트리거용)다.
-- 이벤트 트리거는 실행 권한과 상관없이 돌기 때문에 API로 부르는 권한만 걷어낸다. 로컬 테스트 DB에는 없다.
do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
  end if;
exception
  when insufficient_privilege then
    raise notice 'rls_auto_enable() 권한을 바꿀 수 없어 건너뜁니다.';
end
$$;

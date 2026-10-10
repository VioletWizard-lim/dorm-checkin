-- 학생 "개인정보 수정"(사용자 요청): 학생이 자기 정보를 보고, 학생 연락처·이메일만 직접 고친다.
--   - 학부모 연락처는 학생이 못 바꿈(외출 안내 문자가 가는 번호라서 — 바꾸려면 담임 선생님께)
--   - 이름·학번·반·아이디도 못 바꿈
-- 학생은 students를 직접 고칠 수 없으므로(RLS) RPC update_my_contact로만 한다.

-- 학생은 자기 연락처를 읽는다(교직원은 지금처럼 담당 범위)
create or replace function private.student_contacts()
  returns table (id uuid, login_id text, phone text, parent_phone text, email text)
  language sql stable security definer set search_path = ''
  as $$
    select s.id, s.login_id, s.phone, s.parent_phone, s.email
    from public.students s
    where private.can_manage_student(s.grade, s.cls) or s.id = private.my_student_id()
  $$;

-- 자기 학생 연락처·이메일 바꾸기. 빈 값이면 지운다. 형식은 테이블 제약이 확인(연락처는 숫자만, 010…)
create function private.update_my_contact(p_phone text, p_email text) returns void
  language plpgsql security definer set search_path = ''
  as $$
  declare
    v_student_id uuid := private.my_student_id();
    v_phone text := nullif(regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g'), '');
    v_email text := nullif(btrim(coalesce(p_email, '')), '');
  begin
    if v_student_id is null then
      raise exception '학생 계정만 쓸 수 있습니다.' using errcode = '42501';
    end if;
    if v_phone is not null and v_phone !~ '^01[0-9]{8,9}$' then
      raise exception '연락처는 010으로 시작하는 휴대폰 번호로 입력해 주세요.' using errcode = '22023';
    end if;
    if v_email is not null and (char_length(v_email) > 200 or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$') then
      raise exception '이메일 형식이 올바르지 않습니다.' using errcode = '22023';
    end if;
    update public.students set phone = v_phone, email = v_email where id = v_student_id;
  end;
  $$;
revoke execute on function private.update_my_contact(text, text) from public, anon;
grant execute on function private.update_my_contact(text, text) to authenticated;

create function public.update_my_contact(p_phone text, p_email text) returns void
  language sql security invoker set search_path = ''
  as $$ select private.update_my_contact(p_phone, p_email) $$;
revoke execute on function public.update_my_contact(text, text) from public, anon;
grant execute on function public.update_my_contact(text, text) to authenticated;

-- 명단 칸 제한 트리거: 학생 본인은 연락처·이메일만(위 RPC가 고칠 때)
create or replace function private.students_leave_only() returns trigger
  language plpgsql security definer set search_path = ''
  as $$
  declare
    v_allowed text[];
  begin
    -- 서버 함수(service_role)·명단 관리 권한이 있는 사람은 그대로
    if (select auth.uid()) is null or private.can_manage_student(old.grade, old.cls) then
      return new;
    end if;
    if private.has_staff_role('dormStaff') then
      v_allowed := array['leave_from', 'leave_to', 'leave_reason'];
    elsif private.has_staff_role('afterschoolTeacher') then
      v_allowed := array['afterschool_days'];
    elsif old.id = private.my_student_id() then
      v_allowed := array['phone', 'email'];
    else
      v_allowed := array[]::text[];
    end if;
    if (to_jsonb(new) - v_allowed) is distinct from (to_jsonb(old) - v_allowed) then
      if private.has_staff_role('afterschoolTeacher') then
        raise exception '방과후 선생님은 방과후 요일만 바꿀 수 있습니다.' using errcode = '42501';
      end if;
      if old.id = private.my_student_id() then
        raise exception '학생은 자기 연락처·이메일만 바꿀 수 있습니다.' using errcode = '42501';
      end if;
      raise exception '기숙사부는 명령퇴사 기간만 바꿀 수 있습니다.' using errcode = '42501';
    end if;
    return new;
  end;
  $$;

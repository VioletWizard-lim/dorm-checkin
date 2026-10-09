-- 학생 학년 바로잡기(사용자 요청). 예전 화면은 붙여넣기·추가 때 학번과 상관없이 고른 학년 탭으로 저장해서,
-- 1학년 탭에서 넣은 2·3학년 학생이 "학년 1, 반 2학년 1반"처럼 들어갔다(화면은 #56에서 고침).
-- 반 이름이 "N학년 …"으로 시작하는데 학년이 N이 아닌 학생만 학년을 N으로 바꾼다. 계정·외출 기록·좌석은 그대로.
-- 담임 담당 반(profiles.managed_classes)에 같은 반이 잘못된 학년으로 들어 있으면 그것도 맞춘다.

create function private.fix_student_grades() returns integer
  language plpgsql security definer set search_path = ''
  as $$
  declare
    v_count integer;
  begin
    update public.students s
       set grade = substr(s.cls, 1, 1)::smallint
     where s.cls ~ '^[1-3]학년'
       and s.grade <> substr(s.cls, 1, 1)::smallint;
    get diagnostics v_count = row_count;

    update public.profiles p
       set managed_classes = (
         select jsonb_agg(
                  case when e->>'cls' ~ '^[1-3]학년'
                       then jsonb_set(e, '{grade}', to_jsonb(substr(e->>'cls', 1, 1)::int))
                       else e end
                  order by ord)
           from jsonb_array_elements(p.managed_classes) with ordinality as t(e, ord)
       )
     where jsonb_typeof(p.managed_classes) = 'array'
       and exists (
         select 1 from jsonb_array_elements(p.managed_classes) e
          where e->>'cls' ~ '^[1-3]학년' and (e->>'grade') is distinct from substr(e->>'cls', 1, 1)
       );
    return v_count;
  end;
  $$;
revoke execute on function private.fix_student_grades() from public, anon, authenticated;

do $$
declare
  v_fixed integer := private.fix_student_grades();
begin
  raise notice '학년을 바로잡은 학생: %명', v_fixed;
end
$$;

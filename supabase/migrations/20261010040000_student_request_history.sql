-- 학생 "신청 현황" 기간 조회(사용자 요청): 학생이 기간을 골라 자기 외출 신청 기록을 본다(지울 수 없음 — 보기만).
-- 신청 사유는 열 권한에서 빠져 있어서(20261010020000_reason_scope) 사유까지 RPC로 준다. 본인 신청만, 최대 1년·500건.

create function private.my_outing_requests(p_from date, p_to date)
  returns table (
    id uuid, date date, reason text, start_time text, expected_return text, status text,
    decided_by_name text, decided_at timestamptz, reject_reason text, created_at timestamptz
  )
  language plpgsql stable security definer set search_path = ''
  as $$
  begin
    if p_from is null or p_to is null or p_to < p_from then
      raise exception '조회 기간을 확인해 주세요.' using errcode = '22023';
    end if;
    if p_to - p_from > 366 then
      raise exception '한 번에 1년까지만 볼 수 있습니다.' using errcode = '22023';
    end if;
    return query
      select r.id, r.date, r.reason, r.start_time, r.expected_return, r.status,
             r.decided_by_name, r.decided_at, r.reject_reason, r.created_at
      from public.outing_requests r
      where r.requested_by = (select auth.uid()) and r.date between p_from and p_to
      order by r.date desc, r.created_at desc
      limit 500;
  end;
  $$;
revoke execute on function private.my_outing_requests(date, date) from public, anon;
grant execute on function private.my_outing_requests(date, date) to authenticated;

create function public.my_outing_requests(p_from date, p_to date)
  returns table (
    id uuid, date date, reason text, start_time text, expected_return text, status text,
    decided_by_name text, decided_at timestamptz, reject_reason text, created_at timestamptz
  )
  language sql stable security invoker set search_path = ''
  as $$ select * from private.my_outing_requests(p_from, p_to) $$;
revoke execute on function public.my_outing_requests(date, date) from public, anon;
grant execute on function public.my_outing_requests(date, date) to authenticated;

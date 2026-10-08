-- 예상 복귀 시각 필수(사용자 요청 — "미정" 없앰). 자동 복귀(20261008040000)가 이 시각을 기준으로 동작한다.
--   - 학생 외출 신청: 예상 복귀 시각("HH:MM")이 있어야 하고 외출 시각보다 늦어야 한다
--   - 외출 기록: 화면(로그인한 사용자)이 외출로 바꿀 때 예상 복귀 시각이 있어야 한다("9:30"은 "09:30"으로 맞춤)
--     서버 작업(auth.uid() 없음 — 자동 복귀, 테스트 데이터)은 그대로 둔다

create function private.outing_requests_require_return() returns trigger
  language plpgsql security definer set search_path = ''
  as $$
  begin
    new.expected_return := nullif(btrim(coalesce(new.expected_return, '')), '');
    if new.expected_return is null or new.expected_return !~ '^([01]?[0-9]|2[0-3]):[0-5][0-9]$' then
      raise exception '예상 복귀 시각을 골라 주세요.';
    end if;
    new.expected_return := lpad(new.expected_return, 5, '0');
    if new.start_time is not null and new.expected_return <= new.start_time then
      raise exception '예상 복귀 시각은 외출 시각보다 늦어야 합니다.';
    end if;
    return new;
  end;
  $$;
revoke execute on function private.outing_requests_require_return() from public, anon, authenticated;

create trigger outing_requests_require_return before insert on public.outing_requests
  for each row execute function private.outing_requests_require_return();

-- outings_before_write(이름 순으로 먼저 실행)가 외출이 아니면 예상 복귀를 비운 뒤에 확인한다
create function private.outings_require_return() returns trigger
  language plpgsql security definer set search_path = ''
  as $$
  begin
    -- 쓸 권한이 없거나 지난 날짜면 RLS가 거부하도록 여기서는 넘긴다(BEFORE 트리거가 RLS보다 먼저 돌아서)
    if (select auth.uid()) is null or new.status <> 'out'
       or not private.can_write_outings() or new.date <> public.today_kst() then
      return new;
    end if;
    new.expected_return := nullif(btrim(coalesce(new.expected_return, '')), '');
    if tg_op = 'INSERT' or old.status is distinct from 'out' or new.expected_return is distinct from old.expected_return then
      if new.expected_return is null or new.expected_return !~ '^([01]?[0-9]|2[0-3]):[0-5][0-9]$' then
        raise exception '예상 복귀 시각(예: 17:00)을 입력해야 외출로 기록할 수 있습니다.';
      end if;
      new.expected_return := lpad(new.expected_return, 5, '0');
    end if;
    return new;
  end;
  $$;
revoke execute on function private.outings_require_return() from public, anon, authenticated;

create trigger outings_require_return before insert or update on public.outings
  for each row execute function private.outings_require_return();

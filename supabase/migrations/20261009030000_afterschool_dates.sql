-- 방과후학교가 있는 날(사용자 요청). 관리자가 방과후 일정 화면(afterschool.html)의 달력에서 고른다.
-- 화면의 "오늘 방과후"(현황판 패널·좌석 색)는 오늘이 여기 있는 날이고, 학생의 방과후 요일(students.afterschool_days)에
-- 오늘 요일이 켜져 있을 때만 표시한다. 행이 없으면 그날은 방과후가 없는 날.

create table public.afterschool_dates (
  date date primary key,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);

alter table public.afterschool_dates enable row level security;

create policy afterschool_dates_select on public.afterschool_dates for select to authenticated
  using ((select private.is_staff()));
create policy afterschool_dates_insert on public.afterschool_dates for insert to authenticated
  with check ((select private.has_staff_role('admin')));
create policy afterschool_dates_delete on public.afterschool_dates for delete to authenticated
  using ((select private.has_staff_role('admin')));

grant select, insert, delete on public.afterschool_dates to authenticated;
grant all on public.afterschool_dates to service_role;

alter publication supabase_realtime add table public.afterschool_dates;

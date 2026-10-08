-- 예전 Firebase RTDB 키(legacy_key)는 데이터 이전 스크립트만 썼다. 이전 스크립트를 지웠으므로(5단계) 칸도 지운다(사용자 요청).
-- unique 제약(인덱스)도 함께 지워진다.
alter table public.students drop column if exists legacy_key;
alter table public.rooms drop column if exists legacy_key;

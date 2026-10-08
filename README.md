# 기숙사 면학 시스템

자세한 기능 스펙과 데이터 모델은 [`CLAUDE.md`](./CLAUDE.md)를 확인하세요.
Claude Code로 이 폴더를 열면 `CLAUDE.md`를 자동으로 읽어 프로젝트 맥락을 파악합니다.

## 구성
- 화면(`public/`): 순수 HTML/CSS/JS. GitHub Pages(https://violetwizard-lim.github.io/dorm-checkin/)에서 서비스하고, `main`에 push하면 GitHub Actions(`pages-deploy.yml`)가 자동 배포합니다. 처음 한 번 저장소 Settings → Pages → Source를 "GitHub Actions"로 골라야 합니다.
- 백엔드: Supabase(Postgres·Auth·Realtime·Edge Functions). `supabase/`가 바뀐 채로 `main`에 들어오면 GitHub Actions(`supabase-deploy.yml`)가 DB 마이그레이션과 Edge Function을 배포합니다.

## 처음 설정할 때
1. Supabase에 프로젝트를 만들고(서울 리전) Authentication 설정에서 새 사용자 가입(Sign up)을 끕니다.
2. 프로젝트 URL과 publishable 키를 `public/js/supabase-config.js`에 넣습니다(공개돼도 안전한 값).
3. GitHub 저장소 Settings → Secrets and variables → Actions에 등록합니다.
   - `SUPABASE_ACCESS_TOKEN`: Supabase 계정의 Access Token(이 프로젝트 하나로 범위를 좁혀서 발급)
   - `SUPABASE_PROJECT_REF`: 프로젝트 ref(URL의 `https://<ref>.supabase.co` 부분)
   - `SUPABASE_DB_PASSWORD`: 프로젝트를 만들 때 정한 DB 비밀번호
4. `main`에 push하면 테이블·권한 규칙·Edge Function이 자동으로 만들어집니다. SQL 편집기에서 마이그레이션을 직접 실행하지 마세요.
5. 첫 관리자 계정: Supabase 대시보드 Authentication → Users → Add user에서 `관리자아이디@donghall.local`과 비밀번호로 만들고(Auto Confirm 체크), SQL 편집기에서 프로필을 넣습니다.
   ```sql
   insert into public.profiles (id, login_id, kind, role, name)
   select id, '관리자아이디', 'staff', 'admin', '관리자 이름' from auth.users where email = '관리자아이디@donghall.local';
   ```
   이후 교사 계정은 화면의 "계정 관리"에서 만듭니다.

## 테스트
- DB(RLS·RPC): `bash tests/db/run.sh` (Postgres 16 서버 바이너리 필요)
- Edge Functions: `deno test --node-modules-dir=none --no-lock --allow-env supabase/functions/`
- 화면 E2E: `cd tests/e2e && npm ci && bash fetch-postgrest.sh && npx playwright test` (Postgres 16, Deno, Chromium 필요)

PR을 올리면 GitHub Actions가 위 테스트를 자동으로 돌립니다.

## 와이어프레임
화면 디자인 참고용 목업: https://claude.ai/artifact/G7UJ6u23e1Cqgepecepbsy
(① 외출 체크 입력 / ② 현황판 / ③ 좌석 배치판 / ④ 로그인)

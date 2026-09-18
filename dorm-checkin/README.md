# 기숙사 외출체크 시스템

자세한 기능 스펙과 데이터 모델은 [`CLAUDE.md`](./CLAUDE.md)를 확인하세요.
Claude Code로 이 폴더를 열면 `CLAUDE.md`를 자동으로 읽어 프로젝트 맥락을 파악합니다.

## 시작하는 방법

### 1. 이 폴더를 GitHub 저장소로 만들기
```bash
cd dorm-checkin
git init
git add .
git commit -m "init: 프로젝트 스캐폴드"
gh repo create dorm-checkin --private --source=. --push
# (gh CLI가 없으면 GitHub 웹에서 저장소 생성 후 git remote add origin ... 으로 연결)
```

### 2. Firebase 프로젝트 준비
1. https://console.firebase.google.com 에서 새 프로젝트 생성
2. Authentication → 로그인 방법 → 이메일/비밀번호 활성화
3. Realtime Database → 데이터베이스 만들기 (프로덕션 모드)
4. 프로젝트 설정 → 일반 탭에서 설정값 복사
5. `public/js/firebase-config.example.js`를 `public/js/firebase-config.js`로 복사한 뒤 값 채우기

### 3. Firebase CLI 연결
```bash
npm install
npx firebase login
npx firebase use --add   # 방금 만든 Firebase 프로젝트 선택
npx firebase deploy --only database   # 보안 규칙 배포
```

### 4. GitHub Actions 자동 배포 연결
```bash
npx firebase init hosting:github
```
CLI 질문에 따라 진행하면 `.github/workflows/`에 배포용 워크플로가 자동 생성되고,
이후 `main` 브랜치에 push할 때마다 자동으로 Firebase Hosting에 배포됩니다.

### 5. 로컬 테스트
```bash
npm run dev   # Firebase 에뮬레이터로 로컬 실행
```

### 6. 첫 관리자 계정 만들기
Firebase 콘솔 → Authentication에서 이메일/비밀번호로 계정 하나를 만들고,
Realtime Database의 `users/{그_계정의_uid}`에 아래 값을 직접 입력하면 관리자 계정이 됩니다.
```json
{ "role": "admin" }
```

## 와이어프레임
화면 디자인 참고용 목업: https://claude.ai/artifact/G7UJ6u23e1Cqgepecepbsy
(① 외출 체크 입력 / ② 현황판 / ③ 좌석 배치판 / ④ 로그인)

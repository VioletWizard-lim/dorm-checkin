# 기숙사 외출체크 시스템 (dorm-checkin)

이 문서는 Claude Code가 프로젝트를 이어서 개발할 때 참고하는 스펙입니다.
와이어프레임(디자인 목업)은 여기에서 확인할 수 있습니다: https://claude.ai/artifact/G7UJ6u23e1Cqgepecepbsy

## 한 줄 요약
고등학교 기숙사에서 학생의 외출 여부와 오늘의 방과후 일정을 실시간으로 확인하고,
좌석(실) 배치를 관리 교사가 직접 구성할 수 있는 웹 앱.

## 기술 스택
- **Frontend**: 순수 HTML/CSS/JS (프레임워크 없음), PWA(홈 화면 추가 지원)
- **Backend**: Firebase Authentication + Realtime Database
- **Hosting**: Firebase Hosting, GitHub Actions로 main 브랜치 push 시 자동 배포
- **폰트**: Noto Sans KR (Google Fonts)
- **대상 기기**: 교무실/사감실 PC(입력·현황판 화면), Android 기반 전자칠판(전체화면 PWA)

## 화면 구성 (5개)

### 1. 로그인 (`login.html`)
- 이메일이 아닌 **아이디**로 로그인 (화면에는 아이디만 노출)
- 내부적으로 `${아이디}@donghall.local` 형태로 변환해 Firebase Auth에 전달
- 회원가입 화면 없음 — 계정은 관리자가 미리 생성
- 아이디는 영문+숫자만 허용 (이메일 변환 시 깨짐 방지)

### 2. 외출 체크 입력 화면 (`check.html`)
- 상단: 오늘 날짜, 전체 외출중 인원 카운트
- 실 필터: "전체" / 실 이름별 탭(실 목록은 `rooms`에서 동적으로 읽어옴)
- 검색창(이름 검색)
- 학생 카드 리스트: 아바타, 이름, "학번 · 반", 상태 배지(재실/외출중), 토글 버튼(외출 체크 ↔ 복귀 체크)
- 로그인한 사용자 누구나(teacher 이상) 사용 가능
- "외출 체크"를 누르면(재실→외출중) 사유·예상 복귀 시각을 입력받는 프롬프트가 순서대로 뜨고(둘 다 선택 입력, 취소해도 체크 자체는 진행), 그 학생에게 `email`이 등록되어 있을 경우 실제 종이 외출증 서식(학년/반/번, 사유, 외출~복귀 시간대, 담당 교사)을 본뜬 이메일을 EmailJS로 자동 발송(`public/js/emailjs-config.js` 설정 필요, 아래 "외부 서비스 연동" 참고). 담당 교사란은 로그인한 계정의 `users/{uid}.name`이 있으면 그 이름을, 없으면 로그인 아이디를 표시. "복귀 체크" 시에는 발송하지 않음

### 3. 기숙사 현황판 (`display.html`)
- 읽기 전용 모니터링 화면 (사감/당직 교사 PC에 띄워둠)
- 실 탭으로 필터링
- 좌우 2분할: 왼쪽 "외출중"(빨강 계열), 오른쪽 "오늘 방과후"(파랑 계열)
- 각 항목: 아바타, 이름, "학번 · 반", 외출 시각 또는 방과후 활동명
- Realtime Database 구독으로 실시간 갱신

### 4. 좌석 배치 현황판 (`seat.html`)
- 실(rooms)마다 **완전히 독립적인 좌석 그리드**를 가짐 (행/열 크기, 좌석 배정 모두 실별로 분리)
- 보기 모드 / 편집 모드 토글
- 편집 모드에서 관리자·학년관리자가 할 수 있는 것:
  - 실 추가("+ 실 추가") / 실 이름 변경 / 실 삭제(최소 1개는 유지)
  - 실의 **대상 학년** 지정 (1/2/3학년 토글) — 지정된 학년 학생만 그 실의 배정 후보로 노출
  - 그리드 행/열 크기 조정(+/−)
  - 빈 좌석 클릭 → 드롭다운으로 학생 배정 / 배정된 좌석 × 클릭 → 해제
- 좌석 카드 색상 우선순위: **외출중(빨강) > 오늘 방과후(파랑) > 재실(회색) > 빈자리(점선)**
- 학년관리자는 자기 `managedRooms`에 속한 실만 편집 가능(권한 규칙 참고)

### 5. 학생 명단 관리 (`students.html`)
- teacher는 접근 시 `check.html`로 리다이렉트(권한 없음). gradeManager·admin만 사용 가능
- 학년 탭: admin은 1/2/3학년 전체, gradeManager는 자기 `managedGrades`에 속한 학년만 노출
- "+ 학생 추가" → 이름/학번/반/방과후 요일(월~금 토글) 입력 폼 → `students/{grade}/{push로 생성된 id}`에 저장
  - 학번(5자리: 학년1+반2+번호2)을 입력하면 반이 자동 계산되어 채워짐(직접 수정하면 그 값을 우선)
- "여러 명 한번에 추가" → 엑셀에서 복사한 "이름[탭]학번" 줄들을 붙여넣으면 실시간 미리보기 후 일괄 저장
- 명단 카드의 "수정"/"삭제"로 기존 학생 정보 수정·삭제 (`students/{grade}/{studentId}` set/remove)
- `check.html` 상단에 이 화면으로 가는 "학생 명단 관리" 링크가 admin·gradeManager에게만 노출됨

## 사용자 역할 (3단계)

| 기능 | teacher | gradeManager | admin |
|---|---|---|---|
| 외출 체크 입력/조회 | ✅ | ✅ | ✅ |
| 현황판·좌석배치판 열람 | ✅ | ✅ | ✅ |
| 담당 실의 좌석 배치 편집 | ❌ | ✅ (담당 실만) | ✅ (전체) |
| 담당 학년의 학생 명단·방과후 요일 등록/수정 | ❌ | ✅ (담당 학년만) | ✅ (전체) |
| 실 추가/삭제·이름 변경·대상 학년 지정 | ❌ | ❌ | ✅ |
| 교사 계정 추가/역할 지정 | ❌ | ❌ | ✅ |

## 데이터 모델 (Realtime Database)

```
users/
  {uid}: {
    role: "teacher" | "gradeManager" | "admin",
    name?: string,                       // 선택. 있으면 외출증 이메일의 담당 교사란에 아이디 대신 표시
    managedRooms?: { [roomId]: true },   // gradeManager만 사용
    managedGrades?: { [grade]: true }    // gradeManager만 사용
  }

students/
  {grade}/                                // "1" | "2" | "3"
    {studentId}: {
      name: string,
      sid: string,                        // 학번 (예: "10305" = 1학년 03반 05번 형식 예시)
      cls: string,                        // 반 (예: "1학년 3반")
      email?: string,                     // 선택. 있으면 외출 체크 시 외출증 이메일 발송(EmailJS)
      afterschoolDays: [bool,bool,bool,bool,bool]  // 월~금
    }

rooms/
  {roomId}: {
    name: string,                         // 관리자가 자유롭게 설정 (예: "1·2학년실")
    grades: string[],                     // 이 실에 배정 가능한 학년 (예: ["1","2"])
    rows: number,
    cols: number,
    seatMap: { "r0c0": studentId, ... }
  }

outings/
  {studentId}: {
    status: "out" | "in",
    since: timestamp,
    reason?: string,            // 외출 사유. "외출 체크" 시 프롬프트로 입력(선택, 빈 값 가능)
    expectedReturn?: string     // 예상 복귀 시각(문자열, 예: "17:00"). 마찬가지로 선택 입력
  }
```

## 보안 규칙 (`database.rules.json`에 이미 반영됨)
- `students/{grade}`: admin 또는 `managedGrades`에 해당 학년이 있는 gradeManager만 쓰기 가능
- `rooms/{roomId}`: admin 또는 `managedRooms`에 해당 실이 있는 gradeManager만 쓰기 가능
- `outings`: 로그인한 사용자(teacher 이상) 누구나 읽기/쓰기 가능
- `users`: 클라이언트에서 직접 쓰기 불가 (계정 생성/역할 부여는 관리자가 콘솔 또는 별도 관리 화면에서 처리)

## 디자인 톤 (와이어프레임 기준)
- 배경 `#F3F4F7`, 카드 배경 `#FFFFFF`, 텍스트 `#1C2230`
- 외출중 강조색: `#C0392B` (배경 `#FDECEA`)
- 방과후 강조색: `#2B6CB0` (배경 `#EAF1FB`)
- 선택/활성 상태: `#1C2230` (다크 네이비)
- 카드 radius 12~18px, 폰트 Noto Sans KR
- 데스크톱 전용 레이아웃 (1280px 기준)

## 외부 서비스 연동

### EmailJS (외출증 이메일 발송)
- 이 시스템엔 학생 계정이 없어서(로그인은 teacher/gradeManager/admin만), 외출 체크 시 학생에게 직접 알릴 방법이 없었음
- 서버(Cloud Functions)나 유료 SMS 계정 없이, 클라이언트에서 바로 이메일을 보낼 수 있는 [EmailJS](https://www.emailjs.com)(무료 월 200통)를 사용
- 설정 방법:
  1. emailjs.com 가입 → **Email Services**에서 발송용 메일 계정(Gmail 등) 연결 → Service ID 확인
  2. **Email Templates**에서 외출증 템플릿 작성(변수: `to_email`, `student_name`, `sid`, `cls`, `seat_no`, `reason`, `out_date`, `out_time`, `return_time`, `teacher_id`) → Template ID 확인
  3. **Account** 페이지에서 Public Key 확인
  4. **Account → Security**의 Allowed Origins에 실제 배포 도메인 등록(오남용 방지)
  5. `public/js/emailjs-config.js`의 세 값(`EMAILJS_PUBLIC_KEY`, `EMAILJS_SERVICE_ID`, `EMAILJS_OUTING_TEMPLATE_ID`)을 채워서 커밋
- 학생에게 `email`이 없거나 EmailJS가 아직 설정 전이면(플레이스홀더 값) 조용히 발송을 건너뜀 — 외출 기록 자체(`outings` 갱신)는 이메일 발송 성공 여부와 무관하게 항상 처리됨

## 남은 작업 체크리스트
- [ ] Firebase 프로젝트 생성, Authentication(이메일/비밀번호) + Realtime Database 활성화
- [x] `database.rules.json` 배포 (`firebase deploy --only database`) — GitHub Actions 자동 배포로 전환됨(아래 항목 참고)
- [x] `public/js/firebase-config.js` 실제 값 채우기 (비밀키가 아니라 공개돼도 안전한 값이라 그대로 커밋함, `.gitignore` 대상 아님)
- [x] 로그인 화면: 아이디→이메일 변환 로직 구현
- [x] 외출 체크 입력 화면: Realtime DB 연동, 토글 시 `outings/{studentId}` 갱신
- [x] 학생 명단 관리 화면(`students.html`): 학년별 학생 등록/수정/삭제, gradeManager·admin만 접근 가능
- [x] 현황판: `outings`, `students`, `rooms` 구독해서 실시간 렌더링
- [ ] 좌석 배치판: `rooms` CRUD, 좌석 배정 로직, 권한별 편집 가능 여부 분기
- [ ] 관리자용 계정 생성 화면 또는 Firebase 콘솔에서 수동 생성 결정
- [x] EmailJS 가입 및 `public/js/emailjs-config.js` 실제 값 채우기(외출증 이메일 발송에 필요, 위 "외부 서비스 연동" 참고)
- [x] `firebase init hosting:github` 실행해 GitHub Actions 자동 배포 연결
- [x] `database.rules.json` 변경 시 GitHub Actions로 자동 배포(`firebase-database-rules-deploy.yml`, 기존 Hosting용 서비스 계정에 Realtime Database 관리자 역할 추가 필요)

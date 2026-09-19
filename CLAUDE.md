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

## 화면 구성 (6개)
로그인 화면을 제외한 모든 화면의 헤더에는 로그아웃 버튼이 있음(`signOut` 후 `login.html`로 이동).

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
- 학년 탭(전체/1/2/3학년)과 실 탭(전체/실 목록, 실 목록은 `rooms`에서 동적으로 읽어옴)으로 각각 필터링 — 두 필터는 동시에(AND로) 적용됨
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
- gradeManager가 특정 학년 안에서 `managedClasses`로 반까지 좁혀져 있으면(예: 1학년 중 "1학년 3반"만), 그 학년 탭 안에서도 담당 반 학생만 보이고 추가/수정도 담당 반으로 제한됨 — 담당 반이 정확히 하나면 "+ 학생 추가" 폼의 반 입력란이 자동으로 채워짐. `managedClasses`가 없으면(기존 계정 포함) 예전처럼 학년 전체 담당
- "+ 학생 추가" → 이름/학번/반/방과후 요일(월~금 토글) 입력 폼 → `students/{grade}/{push로 생성된 id}`에 저장
  - 학번(5자리: 학년1+반2+번호2)을 입력하면 반이 자동 계산되어 채워짐(직접 수정하면 그 값을 우선)
  - 담당 반이 지정된 gradeManager가 담당 반이 아닌 값으로 저장하려 하면 alert로 막음(클라이언트 단 검증 — 아래 "권한 검증 수준" 참고)
- "여러 명 한번에 추가" → 엑셀에서 복사한 "이름[탭]학번" 줄들을 붙여넣으면 실시간 미리보기 후 일괄 저장. 담당 반이 지정돼 있으면 학번으로 계산된 반이 담당 반이 아닌 줄은 미리보기에서 오류로 표시되고 저장 대상에서 제외됨
- 명단 카드의 "수정"/"삭제"로 기존 학생 정보 수정·삭제 (`students/{grade}/{studentId}` set/remove)
- `check.html` 상단에 이 화면으로 가는 "학생 명단 관리" 링크가 admin·gradeManager에게만 노출됨

### 6. 계정 관리 (`accounts.html`)
- admin 전용(admin이 아니면 `check.html`로 리다이렉트). `check.html` 상단에 이 화면으로 가는 "계정 관리" 링크가 admin에게만 노출됨
- 상단: 등록된 계정 목록 — 아이디·이름·역할 배지(teacher/gradeManager/admin), gradeManager는 담당 학년·담당 실도 함께 표시
  - 본인 계정 행에는 "정보 수정" 버튼이 없음(관리자가 실수로 자기 자신을 강등해 잠기는 것을 방지)
  - "정보 수정" 클릭 시 그 계정 행이 인라인 편집 폼으로 바뀜: 이름 입력란, 역할 토글(teacher/gradeManager/admin), gradeManager 선택 시 담당 학년(1/2/3학년 토글)·담당 실(rooms 목록에서 토글) 추가 노출 → 저장 시 `users/{uid}` set. 이름은 매년 같은 아이디를 다른 담당자가 이어받는 경우(예: "1학년부장" 계정)를 대비해 언제든 바꿀 수 있게 함
  - 담당 학년을 토글하면 그 학년 밑에 "담당 반" 토글 줄이 추가로 나타남(선택한 학년에 실제 등록된 학생들의 `cls` 값을 모아 자동으로 보여줌, 학생이 없으면 "등록된 학생이 없어 반 목록을 표시할 수 없습니다" 안내). 반을 하나도 안 고르면 그 학년 전체 담당, 하나 이상 고르면 그 학년 안에서도 고른 반만 담당(예: "1학년부장"은 학년 전체, "1학년 3반 담임"은 반 하나만). 학년 토글을 껐다 켜면 그 학년의 반 선택은 초기화됨 → 저장 시 `users/{uid}.managedClasses`에 반영
  - 저장 실패 시(권한 문제 등) alert로 실패 사유를 보여주고 편집 폼을 그대로 유지 — 조용히 실패해서 관리자가 바뀐 줄 착각하는 일이 없도록 함
- 하단: 교사 계정 일괄 생성 — "아이디[탭]이름" 또는 "아이디[탭]이름[탭]비밀번호" 형식으로 여러 줄 붙여넣기(비밀번호 생략 시 자동 생성, 직접 입력 시 6자 이상 검증) → 미리보기 후 "계정 생성" 클릭 시 한 줄씩 순차 생성. 항상 `role: "teacher"`로 생성되며 승급은 위 계정 목록에서 별도로 처리
  - 생성 결과(성공/실패, 실패 사유, 자동 생성된 비밀번호)를 화면에 표시 — 비밀번호는 다시 조회할 수 없으므로 그 자리에서 복사해 교사에게 전달해야 함
  - **기술적으로 중요한 점**: 이미 로그인된 관리자 세션에서 `createUserWithEmailAndPassword`를 그냥 호출하면 Firebase Auth가 자동으로 새로 만든 계정으로 로그인을 전환시켜 관리자가 로그아웃되어 버림. 이를 피하기 위해 계정을 만들 때마다 이름을 가진 임시 보조 Firebase 앱 인스턴스(`initializeApp(firebaseConfig, "secondary-...")`)를 만들어 그 인스턴스의 Auth로만 계정을 생성하고, 끝나면 `deleteApp`으로 즉시 정리함(`public/js/accounts.js`의 `createTeacherAccount` 참고). 백엔드(Cloud Functions/Admin SDK) 없이 순수 클라이언트에서 계정을 일괄 생성하기 위한 표준적인 우회 방법
  - **한계**: 클라이언트 SDK로는 다른 사람의 Auth 계정을 삭제할 수 없음(로그인 중인 계정 본인만 자기 자신을 삭제 가능) — 그래서 이 화면엔 계정 삭제 기능이 없음. 계정을 완전히 없애려면 Firebase 콘솔에서 수동으로 삭제해야 함

## 사용자 역할 (3단계)

| 기능 | teacher | gradeManager | admin |
|---|---|---|---|
| 외출 체크 입력/조회 | ✅ | ✅ | ✅ |
| 현황판·좌석배치판 열람 | ✅ | ✅ | ✅ |
| 담당 실의 좌석 배치 편집 | ❌ | ✅ (담당 실만) | ✅ (전체) |
| 담당 학년의 학생 명단·방과후 요일 등록/수정 | ❌ | ✅ (담당 학년, 필요시 담당 반만) | ✅ (전체) |
| 실 추가/삭제·이름 변경·대상 학년 지정 | ❌ | ❌ | ✅ |
| 교사 계정 추가/역할 지정 | ❌ | ❌ | ✅ |

## 데이터 모델 (Realtime Database)

```
users/
  {uid}: {
    id?: string,                         // 로그인 아이디. accounts.html에서 생성한 계정만 채워짐(표시·검색용, Auth 로그인 자체는 uid 기준이라 이 값이 없어도 로그인엔 지장 없음)
    role: "teacher" | "gradeManager" | "admin",
    name?: string,                       // 선택. 있으면 외출증 이메일의 담당 교사란에 아이디 대신 표시
    managedRooms?: { [roomId]: true },   // gradeManager만 사용
    managedGrades?: { [grade]: true },   // gradeManager만 사용
    managedClasses?: { [grade]: { [cls]: true } }  // gradeManager만, 선택. managedGrades의 특정 학년 안에서 반까지 좁힐 때만 채움(없으면 그 학년 전체 담당)
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
- `users/{uid}`: admin만 쓰기 가능(`accounts.html`에서 계정 생성·역할 변경 시 사용). 그 외 계정은 자기 자신의 role/name을 스스로 바꿀 수 없음(`.write` 규칙이 "쓰려는 사람이 admin인가"만 확인하고 대상이 본인인지는 구분하지 않으므로, admin이 아니면 자기 자신을 포함해 어떤 `users/{uid}`도 쓸 수 없음)
- `managedClasses`(반 단위 제한)는 `database.rules.json`에는 반영되어 있지 않고 `students.js` 클라이언트 코드에서만 검증함(학년 단위인 `managedGrades`/`managedRooms`만 서버 규칙으로 강제됨) — seat.html의 "실의 대상 학년" 필터링과 같은 수준. 내부 교직원만 쓰는 도구라는 전제하의 선택이며, 더 엄격하게 서버에서도 막고 싶다면 `students/{grade}/{studentId}`의 `.write`에 `cls` 값을 검사하는 규칙을 추가해야 함

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
- [x] 좌석 배치판: `rooms` CRUD, 좌석 배정 로직, 권한별 편집 가능 여부 분기
- [x] 관리자용 계정 생성 화면(`accounts.html`): 교사 계정 일괄 생성 + 역할(role)·담당 학년/실 지정
- [x] EmailJS 가입 및 `public/js/emailjs-config.js` 실제 값 채우기(외출증 이메일 발송에 필요, 위 "외부 서비스 연동" 참고)
- [x] `firebase init hosting:github` 실행해 GitHub Actions 자동 배포 연결
- [x] `database.rules.json` 변경 시 GitHub Actions로 자동 배포(`firebase-database-rules-deploy.yml`, 기존 Hosting용 서비스 계정에 Realtime Database 관리자 역할 추가 필요)

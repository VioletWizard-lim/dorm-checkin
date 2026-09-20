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
로그인 화면을 제외한 모든 화면의 헤더에는 그 계정이 접근 가능한 **다른 화면으로 가는 링크가 전부** 노출됨(자기 자신 화면으로의 링크는 제외, 대신 check.html이 아닌 화면에는 "← 체크 화면으로" 링크가 있음) — 권한이 없는 화면의 링크는 숨겨짐(판단 로직은 화면마다 독립적으로 구현되어 있지만 기준은 모두 동일). 예: teacher가 담당 반이 없으면 어느 화면에서도 "학생 명단 관리" 링크가 안 보이고, admin이 아니면 어느 화면에서도 "계정 관리" 링크가 안 보임.

### 1. 로그인 (`login.html`)
- 이메일이 아닌 **아이디**로 로그인 (화면에는 아이디만 노출)
- 내부적으로 `${아이디}@donghall.local` 형태로 변환해 Firebase Auth에 전달
- 회원가입 화면 없음 — 계정은 관리자가 미리 생성
- 아이디는 영문+숫자만 허용 (이메일 변환 시 깨짐 방지)
- accounts.html에서 "삭제"된(`disabled: true`) 계정은 아이디/비밀번호 자체는 맞아서 로그인엔 성공하지만, 이동한 화면에서 즉시 로그아웃되어 `login.html?disabled=1`로 돌아오며 "삭제(비활성화)된 계정입니다" 안내가 표시됨

### 2. 외출 체크 입력 화면 (`check.html`)
- 상단: 오늘 날짜, 전체 외출중 인원 카운트
- 실 필터: "전체" / 실 이름별 탭(실 목록은 `rooms`에서 동적으로 읽어옴)
- 검색창(이름 검색)
- **조회 날짜 선택**(`<input type="date">`, 기본값 오늘, 미래 날짜는 선택 불가): 오늘이 아닌 날짜를 고르면 그 날짜의 `outings/{날짜}` 기록을 보고 그 자리에서 고칠 수 있음("출석체크 변경") — 화면에 "지난 기록을 보는 중입니다" 안내가 뜨고, 이 상태에서 체크를 바꿔도 이메일은 발송되지 않음(실시간 외출이 아니라 사후 정정이므로)
- 학생 카드 리스트: 아바타, 이름, "학번 · 반", 상태 배지(재실/외출중/자리 없음/명령퇴사), 상태별 조작:
  - **재실** → "외출 체크" 버튼(아래 설명)만 노출 — "자리 없음" 표시는 여기서 하지 않고 seat.html(좌석 배치 현황판)에서만 함(순회하며 좌석에서 바로 표시하는 동작이라 좌석 배치판 전용으로 둠)
  - **외출중** → "복귀 체크" 버튼(재실로)
  - **자리 없음** → "재실로 되돌리기" 버튼만 노출(자동 판단 없이 전부 수동 — seat.html에서 순회하는 교사가 직접 표시하고, 여기서는 해제만 가능. 예전엔 "무단외출"/"자리비움" 두 상태로 나눠뒀다가 하나로 합침)
  - **명령퇴사**(기간제 상태, `students/{grade}/{studentId}.leaveOfAbsence`가 조회 중인 날짜를 포함할 때) → 조작 버튼 없이 "학생 명단 관리에서 설정"만 표시(설정은 students.html에서 함). 이 기간 동안은 "자리 없음" 판정에서 제외되고 다른 어떤 상태보다 우선 표시됨
- 로그인한 사용자 누구나(teacher 이상) 사용 가능. **studyHallSupervisor**(자습 감독용) 계정은 이 화면만 접근 가능 — 헤더의 "현황판 보기"/"좌석 배치판 보기"/"학생 명단 관리"/"계정 관리" 링크가 모두 숨겨지고, 다른 화면 URL로 직접 접속해도 이 화면으로 리다이렉트됨
- "외출 체크"를 누르면(재실→외출중) 사유·예상 복귀 시각을 입력받는 프롬프트가 순서대로 뜨고(둘 다 선택 입력, 취소해도 체크 자체는 진행), 그 학생에게 `email`이 등록되어 있을 경우 실제 종이 외출증 서식(학년/반/번, 사유, 외출~복귀 시간대, 담당 교사)을 본뜬 이메일을 EmailJS로 자동 발송(`public/js/emailjs-config.js` 설정 필요, 아래 "외부 서비스 연동" 참고). 담당 교사란은 로그인한 계정의 `users/{uid}.name`이 있으면 그 이름을, 없으면 로그인 아이디를 표시. "복귀 체크" 시에는 발송하지 않음(조회 날짜가 오늘일 때만 발송 — 위 참고)

### 3. 기숙사 현황판 (`display.html`)
- 읽기 전용 모니터링 화면 (사감/당직 교사 PC에 띄워둠)
- 학년 탭(전체/1/2/3학년)과 실 탭(전체/실 목록, 실 목록은 `rooms`에서 동적으로 읽어옴)으로 각각 필터링 — 두 필터는 동시에(AND로) 적용됨
- 패널 4개(가로 배치, 화면이 좁으면 줄바꿈): **자리 없음** > **외출중**(빨강 계열) > **명령퇴사** > **오늘 방과후**(파랑 계열) — 명령퇴사 중인 학생은 그 기간 동안 이 패널에만 나타나고 자리 없음·외출중·방과후 패널에서는 제외됨(check.html/students.html 참고)
- 각 항목: 아바타, 이름, "학번 · 반", 외출/자리 없음 시각 또는 방과후 활동명 또는 명령퇴사 종료일
- 항상 **오늘**(`outings/{오늘 날짜}`) 기준만 표시함 — 지난 날짜 조회는 check.html에서만 가능
- Realtime Database 구독으로 실시간 갱신

### 4. 좌석 배치 현황판 (`seat.html`)
- 실(rooms)마다 **완전히 독립적인 좌석 그리드**를 가짐 (행/열 크기, 좌석 배정 모두 실별로 분리)
- 보기 모드 / 편집 모드 토글
- **보기 모드**에서 학생이 배정된 좌석을 클릭하면(명령퇴사 중인 학생은 클릭 불가) 그 자리에서 출석 상태를 바로 바꿀 수 있음 — check.html까지 갈 필요 없이 순회하며 바로 처리할 수 있는 것만:
  - 재실 → "자리없음" 버튼만 노출(순회 중 자리에 없는 걸 발견하면 표시)
  - 외출중 → "복귀" 버튼
  - 자리 없음 → "재실로" 버튼
  - 모든 상태에 "취소" 버튼(적용 안 하고 닫기)
  - **"외출"(재실 → 외출중, 사유·예상 복귀 시각 입력 + 외출증 이메일 발송)은 여기서 할 수 없음** — 일부러 뺀 것. 새로 외출을 시작하는 건 공식적인 절차라 check.html에서만 하도록 하고, 좌석 배치판에서는 이미 나가 있는 학생의 복귀 체크·자리없음 표시/해제처럼 가벼운 것만 가능함
- 편집 모드에서 관리자·기숙사부·학년관리자가 할 수 있는 것(위 출석 상태 변경과는 별개 — 편집 모드에서는 좌석을 눌러도 출석 상태 조작 패널이 뜨지 않음):
  - 실 추가("+ 실 추가") / 실 이름 변경 / 실 삭제(최소 1개는 유지)
  - 실의 **대상 학년** 지정 (1/2/3학년 토글) — 지정된 학년 학생만 그 실의 배정 후보로 노출
  - 그리드 행/열 크기 조정(+/−)
  - 빈 좌석 클릭 → 드롭다운으로 학생 배정 / 배정된 좌석 × 클릭 → 해제
- 좌석 카드 색상 우선순위: **명령퇴사(보라) > 자리 없음(황금) > 외출중(빨강) > 오늘 방과후(파랑) > 재실(회색) > 빈자리(점선)** — 자리 없음/명령퇴사의 의미는 check.html/students.html 참고. 좌석 배치판은 항상 오늘 기준만 표시함
- 학년관리자는 자기 `managedRooms`에 속한 실만 편집 가능 — admin·기숙사부는 전체 실 편집 가능(권한 규칙 참고)

### 5. 학생 명단 관리 (`students.html`)
- admin·gradeManager·dormStaff는 항상 접근 가능. teacher는 담임(담당 반, `managedClasses`)이 배정되어 있을 때만 접근 가능 — 아무 반도 배정 안 된 일반 teacher는 접근 시 `check.html`로 리다이렉트
- 학년 탭: admin·dormStaff는 1/2/3학년 전체, gradeManager는 자기 `managedGrades`에 속한 학년 전체(반 구분 없음), teacher는 자기 `managedClasses`에 반이 있는 학년만(그 학년 탭 안에서도 담당 반 학생만 보임)
- teacher가 담당 반이 정확히 하나면 "+ 학생 추가" 폼의 반 입력란이 자동으로 채워짐. 담당 반이 아닌 값으로 저장하려 하면 alert로 막음(클라이언트 단 검증 — 아래 "권한 검증 수준" 참고). gradeManager·admin은 이 제한이 없음(학년 전체 대상)
- "+ 학생 추가" → 이름/학번/반/방과후 요일(월~금 토글) 입력 폼 → `students/{grade}/{push로 생성된 id}`에 저장
  - 학번(5자리: 학년1+반2+번호2)을 입력하면 반이 자동 계산되어 채워짐(직접 수정하면 그 값을 우선)
- "여러 명 한번에 추가" → 엑셀에서 복사한 "이름[탭]학번" 줄들을 붙여넣으면 실시간 미리보기 후 일괄 저장. teacher가 담당 반으로 제한된 경우, 학번으로 계산된 반이 담당 반이 아닌 줄은 미리보기에서 오류로 표시되고 저장 대상에서 제외됨
- 명단 카드의 "수정"/"삭제"로 기존 학생 정보 수정·삭제 (`students/{grade}/{studentId}` set/remove)
- 학생별 **명령퇴사 기간**(선택) 설정: "+ 학생 추가"/"수정" 폼에 시작일·종료일·사유 입력란이 있음. 시작일·종료일은 하나만 입력하면 alert로 막고(둘 다 입력하거나 둘 다 비워야 함), 종료일이 시작일보다 빠르면 저장을 막음. 저장하면 `students/{grade}/{studentId}.leaveOfAbsence`에 반영되고, 그 기간 동안 check.html·display.html·seat.html에서 "명령퇴사"로 표시되며 "자리 없음" 판정에서 제외됨(둘 다 비우고 저장하면 해제)
- 다른 화면들(자기 자신인 students.html 제외) 상단에 이 화면으로 가는 "학생 명단 관리" 링크가 admin·gradeManager·dormStaff·(담당 반이 있는)teacher에게만 노출됨

### 6. 계정 관리 (`accounts.html`)
- admin 전용(admin이 아니면 `check.html`로 리다이렉트 — dormStaff도 예외 없이 포함). 다른 화면들(자기 자신인 accounts.html 제외) 상단에 이 화면으로 가는 "계정 관리" 링크가 admin에게만 노출됨
- 상단: 등록된 계정 목록 — 아이디·이름·역할 배지(teacher/gradeManager/admin/studyHallSupervisor/dormStaff), gradeManager는 담당 학년·담당 실을, teacher는 담당 반(있는 경우만)을 함께 표시
  - 본인 계정 행에는 "정보 수정" 버튼이 없음(관리자가 실수로 자기 자신을 강등해 잠기는 것을 방지)
  - "정보 수정" 클릭 시 그 계정 행이 인라인 편집 폼으로 바뀜: 이름 입력란, 역할 토글(teacher/gradeManager/admin/studyHallSupervisor/dormStaff) → 저장 시 `users/{uid}` set. 이름은 매년 같은 아이디를 다른 담당자가 이어받는 경우(예: "1학년부장" 계정)를 대비해 언제든 바꿀 수 있게 함
  - **역할 = gradeManager**(예: "1학년부장", 한 학년 전체 담당): 담당 학년(1/2/3학년 토글)·담당 실(rooms 목록에서 토글) 노출 → `managedGrades`/`managedRooms`에 반영. 반 단위로 더 좁힐 수 없음(학년 전체가 기본 단위)
  - **역할 = teacher**(예: 담임교사, 반 하나만 담당): "담당 반" 섹션이 학년 구분 없이 바로 노출됨 — 1/2/3학년별로 그 학년에 실제 등록된 학생들의 `cls` 값을 모아 토글로 보여줌(학생이 없으면 "등록된 학생이 없습니다"). 하나 이상 고르면 `managedClasses`에 반영되고, 그 teacher는 `students.html`에서 고른 반만 명단 관리를 할 수 있게 됨. 아무 반도 안 고르면(기본값) 그냥 일반 teacher — 외출 체크·현황판만 쓸 수 있고 명단 관리 권한은 없음
  - **역할 = studyHallSupervisor**(자습 감독, 예: 그날 야간자습 감독 교사): 추가 필드 없음 — 이 역할이면 `check.html`(외출/출석 체크 화면)만 접근 가능하고 다른 화면 링크는 모두 숨겨짐(check.html 참고)
  - **역할 = dormStaff**(기숙사부, 예: 명령퇴사 등 기숙사 업무 전담 교사): 추가 필드 없음 — `accounts.html`(계정 관리)을 제외한 모든 화면·전체 학년/실에서 admin과 동일하게 동작(현황판·좌석배치판 열람, 전체 실 편집, 전체 학년 명단 관리 포함). `accounts.html`은 접근 시 `check.html`로 리다이렉트되고 상단 "계정 관리" 링크도 숨겨짐 — admin과의 유일한 차이
  - 저장 실패 시(권한 문제 등) alert로 실패 사유를 보여주고 편집 폼을 그대로 유지 — 조용히 실패해서 관리자가 바뀐 줄 착각하는 일이 없도록 함
  - "삭제" 버튼(본인 계정 행에는 없음)을 누르면 확인창 후 그 계정을 삭제 처리(`users/{uid}`를 `{id, name, disabled: true}`로 덮어써서 역할·담당 배정을 모두 비움) → 목록에는 "삭제됨" 배지로 계속 표시되어 관리자가 나중에도 처리 이력을 알아볼 수 있음. 삭제된 계정은 모든 화면의 인증 단계에서 즉시 로그아웃되어 로그인해도 바로 튕겨나감(아래 "한계" 참고 — 이건 앱 안에서의 비활성화이지 Firebase 로그인 자체를 지우는 게 아님)
- 하단: 교사 계정 일괄 생성 — "아이디[탭]이름" 또는 "아이디[탭]이름[탭]비밀번호" 형식으로 여러 줄 붙여넣기(비밀번호 생략 시 자동 생성, 직접 입력 시 6자 이상 검증) → 미리보기 후 "계정 생성" 클릭 시 한 줄씩 순차 생성. 항상 `role: "teacher"`로 생성되며 승급은 위 계정 목록에서 별도로 처리
  - 생성 결과(성공/실패, 실패 사유, 자동 생성된 비밀번호)를 화면에 표시 — 비밀번호는 다시 조회할 수 없으므로 그 자리에서 복사해 교사에게 전달해야 함
  - **기술적으로 중요한 점**: 이미 로그인된 관리자 세션에서 `createUserWithEmailAndPassword`를 그냥 호출하면 Firebase Auth가 자동으로 새로 만든 계정으로 로그인을 전환시켜 관리자가 로그아웃되어 버림. 이를 피하기 위해 계정을 만들 때마다 이름을 가진 임시 보조 Firebase 앱 인스턴스(`initializeApp(firebaseConfig, "secondary-...")`)를 만들어 그 인스턴스의 Auth로만 계정을 생성하고, 끝나면 `deleteApp`으로 즉시 정리함(`public/js/accounts.js`의 `createTeacherAccount` 참고). 백엔드(Cloud Functions/Admin SDK) 없이 순수 클라이언트에서 계정을 일괄 생성하기 위한 표준적인 우회 방법
  - **한계**: 클라이언트 SDK로는 다른 사람의 Auth 계정을 삭제할 수 없음(로그인 중인 계정 본인만 자기 자신을 삭제 가능). 그래서 위 "삭제" 버튼은 Firebase 로그인(아이디/비밀번호) 자체를 지우는 게 아니라 `users/{uid}`에 `disabled: true`를 표시해 앱 안에서만 비활성화하는 방식임 — 그 아이디/비밀번호로 로그인 자체는 여전히 성공하지만, 모든 화면이 프로필을 확인하는 즉시 로그아웃시켜 사실상 시스템을 쓸 수 없게 됨(`login.html?disabled=1`로 돌아가 안내 문구 표시). Firebase 로그인 자체까지 완전히 없애려면 Firebase 콘솔에서 수동으로 삭제(또는 사용 중지)해야 함

## 사용자 역할 (5단계)

| 기능 | teacher | gradeManager | admin | studyHallSupervisor | dormStaff |
|---|---|---|---|---|---|
| 외출 체크 입력/조회(지난 기록 수정 포함, check.html) · "자리 없음" 표시/해제(seat.html) | ✅ | ✅ | ✅ | ✅ (check.html만 가능) | ✅ |
| 현황판·좌석배치판 열람 | ✅ | ✅ | ✅ | ❌ | ✅ |
| 담당 실의 좌석 배치 편집 | ❌ | ✅ (담당 실만) | ✅ (전체) | ❌ | ✅ (전체) |
| 학생 명단·방과후 요일·명령퇴사 기간 등록/수정 | ✅ (담당 반만, `managedClasses` 배정된 경우) | ✅ (담당 학년 전체) | ✅ (전체) | ❌ | ✅ (전체) |
| 실 추가/삭제·이름 변경·대상 학년 지정 | ❌ | ❌ | ✅ | ❌ | ✅ |
| 교사 계정 추가/역할 지정 | ❌ | ❌ | ✅ | ❌ | ❌ |

studyHallSupervisor는 외출 체크 화면(`check.html`) 외에는 아무 화면도 접근할 수 없음(다른 화면 URL로 직접 이동해도 check.html로 리다이렉트). dormStaff는 반대로 계정 관리(`accounts.html`) 한 곳만 접근할 수 없고 나머지는 admin과 동일함(accounts.html 접근 시 check.html로 리다이렉트).

## 데이터 모델 (Realtime Database)

```
users/
  {uid}: {
    id?: string,                         // 로그인 아이디. accounts.html에서 생성한 계정만 채워짐(표시·검색용, Auth 로그인 자체는 uid 기준이라 이 값이 없어도 로그인엔 지장 없음)
    role: "teacher" | "gradeManager" | "admin" | "studyHallSupervisor" | "dormStaff",
    name?: string,                       // 선택. 있으면 외출증 이메일의 담당 교사란에 아이디 대신 표시
    managedRooms?: { [roomId]: true },   // gradeManager만 사용 (담당 실)
    managedGrades?: { [grade]: true },   // gradeManager만 사용 (담당 학년, 학년 전체 단위)
    managedClasses?: { [grade]: { [cls]: true } }, // teacher만 사용(담임 배정, 선택). 값이 있으면 그 teacher는 students.html에서 이 반들만 명단 관리 가능 — 없으면 명단 관리 권한 자체가 없는 일반 teacher
    disabled?: true                      // accounts.html에서 "삭제"한 계정. true면 모든 화면에서 로그인 즉시 로그아웃 처리(앱 안에서의 비활성화 — Firebase 로그인 자체는 남아있음, 위 accounts.html "한계" 참고)
  }

students/
  {grade}/                                // "1" | "2" | "3"
    {studentId}: {
      name: string,
      sid: string,                        // 학번 (예: "10305" = 1학년 03반 05번 형식 예시)
      cls: string,                        // 반 (예: "1학년 3반")
      email?: string,                     // 선택. 있으면 외출 체크 시 외출증 이메일 발송(EmailJS)
      afterschoolDays: [bool,bool,bool,bool,bool],  // 월~금
      leaveOfAbsence?: { from: string, to: string, reason?: string }  // "명령퇴사" 기간(YYYY-MM-DD, 둘 다 있어야 유효). students.html에서 설정. 오늘이 이 구간에 포함되면 check.html/display.html/seat.html에서 다른 어떤 상태보다 우선해서 "명령퇴사"로 표시되고 "자리 없음" 판정에서 제외됨
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
  {date}/                       // "YYYY-MM-DD"(로컬 날짜). 하루가 지나도 기록이 남도록 날짜별로 분리(check.html의 "조회 날짜"가 이 키를 고름)
    {studentId}: {
      status: "in" | "out" | "away",
      // "out"=정상 외출 체크, "away"="자리 없음" — 자동 판단 없이 check.html/seat.html에서 교사가 직접 표시하는 수동 상태(재실에서만 진입, 재실로만 복귀).
      // "unauthorized"는 예전 값 이름(자리비움과 합쳐 "자리 없음" 하나로 정리하기 전 상태)인데, 남아있을 수 있는 옛 데이터 호환을 위해 클라이언트 코드가 이 값도 away와 동일하게 읽음(새로 쓸 때는 항상 away로 씀)
      since: timestamp,
      reason?: string,            // 외출 사유. "외출 체크" 시 프롬프트로 입력(선택, 빈 값 가능). away에는 없음
      expectedReturn?: string     // 예상 복귀 시각(문자열, 예: "17:00"). 마찬가지로 선택 입력, out에만 있음
    }
```
레코드가 없는 학생은 그 날짜에 "재실"로 취급함(명령퇴사 기간이면 그보다 우선해서 "명령퇴사"로 표시 — 위 `students` 참고). 스키마가 `outings/{studentId}`에서 `outings/{date}/{studentId}`로 바뀐 시점(이 문서 갱신 시점) 이전에 실제 Firebase 프로젝트에 쌓여 있던 이전 형태의 데이터는 새 경로에서 자동으로 보이지 않음 — 원래 "지금 외출 중인지"만 담던 값이라 보존할 필요가 없다고 보고 별도 마이그레이션은 만들지 않았음.

## 보안 규칙 (`database.rules.json`에 이미 반영됨)
- `students/{grade}`: admin·dormStaff는 전체 학년에 쓰기 가능, gradeManager는 `managedGrades`에 해당 학년이 있을 때만, teacher는 `managedClasses`에 해당 학년이 있을 때만(반이 하나라도 배정된 경우) — gradeManager·teacher는 **학년 단위**까지만 서버에서 강제함
- `rooms/{roomId}`: admin·dormStaff 또는 `managedRooms`에 해당 실이 있는 gradeManager만 쓰기 가능
- `outings`: 로그인한 사용자(teacher 이상, studyHallSupervisor 포함) 누구나 읽기/쓰기 가능 — 경로가 `outings/{date}/{studentId}`로 한 단계 깊어졌지만 `outings` 노드에 건 규칙이 하위 전체에 적용되므로 `database.rules.json` 자체는 바뀌지 않음
- `users/{uid}`: admin만 쓰기 가능(`accounts.html`에서 계정 생성·역할 변경 시 사용) — dormStaff도 예외 없이 여기서 제외되며, 이것이 "계정 관리만 admin과 다르다"는 dormStaff 경계의 서버 측 근거임. 그 외 계정은 자기 자신의 role/name을 스스로 바꿀 수 없음(`.write` 규칙이 "쓰려는 사람이 admin인가"만 확인하고 대상이 본인인지는 구분하지 않으므로, admin이 아니면 자기 자신을 포함해 어떤 `users/{uid}`도 쓸 수 없음)
- teacher의 `managedClasses`가 가리키는 **반 단위** 제한은 `database.rules.json`에는 반영되어 있지 않고 `students.js` 클라이언트 코드에서만 검증함(서버 규칙은 위처럼 학년 단위까지만 확인) — seat.html의 "실의 대상 학년" 필터링과 같은 수준. 내부 교직원만 쓰는 도구라는 전제하의 선택이며, 더 엄격하게 서버에서도 반 단위까지 막고 싶다면 `students/{grade}/{studentId}`의 `.write`에 `cls` 값을 검사하는 규칙을 추가해야 함

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
- [x] 외출 체크 입력 화면: Realtime DB 연동, 토글 시 `outings/{날짜}/{studentId}` 갱신, "자리 없음" 수동 표시, 지난 날짜 조회·수정
- [x] 학생 명단 관리 화면(`students.html`): 학년별 학생 등록/수정/삭제, gradeManager·admin만 접근 가능
- [x] 현황판: `outings`, `students`, `rooms` 구독해서 실시간 렌더링
- [x] 좌석 배치판: `rooms` CRUD, 좌석 배정 로직, 권한별 편집 가능 여부 분기
- [x] 관리자용 계정 생성 화면(`accounts.html`): 교사 계정 일괄 생성 + 역할(role)·담당 학년/실 지정
- [x] EmailJS 가입 및 `public/js/emailjs-config.js` 실제 값 채우기(외출증 이메일 발송에 필요, 위 "외부 서비스 연동" 참고)
- [x] `firebase init hosting:github` 실행해 GitHub Actions 자동 배포 연결
- [x] `database.rules.json` 변경 시 GitHub Actions로 자동 배포(`firebase-database-rules-deploy.yml`, 기존 Hosting용 서비스 계정에 Realtime Database 관리자 역할 추가 필요)
- [x] 계정 관리에 계정 삭제(앱 내 비활성화, `disabled: true`) 기능 추가
- [x] "자리 없음" 수동 상태 + 명령퇴사(기간제 상태) 추가, 현황판·좌석 배치판 표시 반영
- [x] 자습 감독용 역할(studyHallSupervisor) 추가 — 외출 체크 화면 전용
- [x] 좌석 배치판에서도 좌석을 클릭해 출석 상태(복귀/자리 없음)를 바로 바꿀 수 있게 추가 — "외출"(새로 나가는 것)은 제외, check.html 전용으로 유지
- [x] check.html에서 "자리 없음으로 표시" 버튼 제거 — 자리 없음 표시/해제는 seat.html 전용으로 통합(check.html은 해제만 가능)
- [x] "기숙사부"(dormStaff) 역할 추가 — 계정 관리(accounts.html)를 제외한 모든 화면에서 admin과 동일한 권한
- [x] 모든 화면 헤더에 권한별 전체 메뉴 링크 통일(기존엔 check.html에만 있었음) — display.html·seat.html·students.html·accounts.html에도 접근 가능한 다른 화면 링크를 전부 노출(자기 자신 제외)

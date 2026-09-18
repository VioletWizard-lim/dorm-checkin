// Firebase 콘솔 > 프로젝트 설정 > 일반 탭에서 확인한 이 프로젝트의 클라이언트 config.
// 이 값들(apiKey 포함)은 비밀키가 아니라 공개되어도 안전한 식별자라 그대로 커밋합니다.
// 실제 접근 제어는 Firebase Authentication + database.rules.json 보안 규칙이 담당합니다.

export const firebaseConfig = {
  apiKey: "AIzaSyBpSSUW7hytuAJaLgawAc6xf3ETx6l1kas",
  authDomain: "dorm-checkin-647d6.firebaseapp.com",
  databaseURL: "https://dorm-checkin-647d6-default-rtdb.firebaseio.com",
  projectId: "dorm-checkin-647d6",
  storageBucket: "dorm-checkin-647d6.firebasestorage.app",
  messagingSenderId: "611271341030",
  appId: "1:611271341030:web:b163d6a71924d718e69c27",
  measurementId: "G-K39E6MNEE4"
};

// 아이디 로그인을 이메일 형식으로 변환할 때 쓰는 가짜 도메인
export const FAKE_EMAIL_DOMAIN = "donghall.local";

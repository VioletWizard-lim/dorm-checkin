// 실제 값은 Firebase 콘솔 > 프로젝트 설정 > 일반 탭에서 복사하세요.
// 이 파일을 복사해서 firebase-config.js로 저장한 뒤 값을 채우면 됩니다.
// firebase-config.js는 .gitignore에 등록되어 있어 커밋되지 않습니다.

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

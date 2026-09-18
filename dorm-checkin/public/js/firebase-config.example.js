// 실제 값은 Firebase 콘솔 > 프로젝트 설정 > 일반 탭에서 복사하세요.
// 이 파일을 복사해서 firebase-config.js로 저장한 뒤 값을 채우면 됩니다.
// firebase-config.js는 .gitignore에 등록되어 있어 커밋되지 않습니다.

export const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  databaseURL: "https://YOUR_PROJECT-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "YOUR_PROJECT",
  storageBucket: "YOUR_PROJECT.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID"
};

// 아이디 로그인을 이메일 형식으로 변환할 때 쓰는 가짜 도메인
export const FAKE_EMAIL_DOMAIN = "donghall.local";

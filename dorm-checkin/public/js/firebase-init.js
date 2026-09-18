// 모든 화면이 공유하는 Firebase 초기화 모듈.
// public/js/firebase-config.js가 없으면 이 모듈을 불러오는 시점에 에러가 발생합니다.
// README.md 안내대로 firebase-config.example.js를 복사해 값을 채워주세요.
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import { getDatabase } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getDatabase(app);

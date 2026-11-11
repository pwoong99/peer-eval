// ============================================================
//  Firebase 설정 파일 — 이 파일만 내 프로젝트 값으로 바꾸면 됩니다.
//  Firebase 콘솔 > 프로젝트 설정 > 내 앱(웹) > "SDK 설정 및 구성"의
//  firebaseConfig 값을 그대로 복사해 아래에 붙여 넣으세요.
// ============================================================

export const firebaseConfig = {
  apiKey: "",
  authDomain: "",
  projectId: "",
  storageBucket: "",
  messagingSenderId: "",
  appId: ""
};

// 교사 계정 이메일 (Firebase 콘솔 > Authentication 에서 만든 교사 계정)
// ※ firestore.rules, storage.rules 의 이메일과 반드시 똑같아야 합니다.
export const TEACHER_EMAIL = "pwoong99@naver.com";

// 학생 비밀번호 규칙: 이 숫자 + 번호 두 자리  (6학년 3반 → "63" → 1번 6301)
export const PIN_PREFIX = "63";

// ============================================================
//  시작 파일: Firebase 연결 → 기능(API) 준비 → 화면에 알려주기
// ============================================================
import { firebaseConfig, TEACHER_EMAIL, PIN_PREFIX } from "./firebase-config.js";
import { createStore } from "./store.js";
import { createApi } from "./api.js";

(async () => {
  try {
    if (!firebaseConfig.apiKey) throw new Error('js/firebase-config.js 에 Firebase 설정값이 아직 없어요.');
    const store = createStore(firebaseConfig, TEACHER_EMAIL);
    await store.ready;
    const api = createApi(store, { pinPrefix: PIN_PREFIX });
    api.__store = store;
    window.__resolveApi(api);
  } catch (e) {
    console.error(e);
    window.__rejectApi(e);
  }
})();

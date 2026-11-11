// ============================================================
//  Firestore / Storage / Authentication 을 감싼 얇은 도우미
//  api.js 는 이 파일의 함수만 쓴다. (시험할 때는 메모리 버전으로 바꿔 끼운다)
// ============================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInAnonymously, signInWithEmailAndPassword, signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc,
  onSnapshot, query, where, writeBatch, getCountFromServer
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  getStorage, ref, uploadString, getDownloadURL, deleteObject
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";

export function createStore(firebaseConfig, teacherEmail) {
  const app = initializeApp(firebaseConfig);
  const auth = getAuth(app);
  const db = getFirestore(app);
  const storage = getStorage(app);
  const TEACHER = String(teacherEmail || '').trim().toLowerCase();

  const q = (path, filters) => {
    const col = collection(db, path);
    return filters && filters.length ? query(col, ...filters.map(f => where(f[0], f[1], f[2]))) : col;
  };
  const withId = s => Object.assign({ id: s.id }, s.data());

  // 처음 로그인 상태 정해질 때까지 기다리기 (없으면 익명 로그인)
  const ready = new Promise((resolve, reject) => {
    let done = false;
    onAuthStateChanged(auth, async user => {
      if (done) return;
      try {
        if (!user) await signInAnonymously(auth);
        done = true; resolve();
      } catch (e) { reject(e); }
    });
  });

  const store = {
    ready,
    isTeacher: () => !!(auth.currentUser && String(auth.currentUser.email || '').toLowerCase() === TEACHER),
    uid: () => (auth.currentUser ? auth.currentUser.uid : null),

    listen(path, filters, cb, onErr) {
      return onSnapshot(q(path, filters), snap => cb(snap.docs.map(withId)), onErr);
    },
    async get(path, id) { const s = await getDoc(doc(db, path, id)); return s.exists() ? withId(s) : null; },
    async getAll(path) { return (await getDocs(collection(db, path))).docs.map(withId); },
    async query(path, filters) { return (await getDocs(q(path, filters))).docs.map(withId); },
    async count(path, filters) { return (await getCountFromServer(q(path, filters))).data().count; },
    set: (path, id, data) => setDoc(doc(db, path, id), data),
    update: (path, id, data) => updateDoc(doc(db, path, id), data),
    del: (path, id) => deleteDoc(doc(db, path, id)),
    // 여러 건을 한꺼번에 (한 번에 최대 450건씩 나눠서)
    async batch(ops, onProgress) {
      for (let i = 0; i < ops.length; i += 450) {
        const b = writeBatch(db);
        ops.slice(i, i + 450).forEach(o => {
          const r = doc(db, o.path, o.id);
          if (o.op === 'set') b.set(r, o.data);
          else if (o.op === 'update') b.update(r, o.data);
          else if (o.op === 'delete') b.delete(r);
        });
        await b.commit();
        if (onProgress) onProgress(Math.min(i + 450, ops.length));
      }
    },

    // 학생 로그인: 비밀번호가 맞을 때만 보안 규칙이 세션 문서를 허락한다
    async createSession(sid, pin) {
      await ready;
      if (store.isTeacher()) { await signOut(auth); await signInAnonymously(auth); }
      await setDoc(doc(db, 'sessions', auth.currentUser.uid), { sid, pin, at: Date.now() });
    },
    async deleteSession() { if (auth.currentUser) await deleteDoc(doc(db, 'sessions', auth.currentUser.uid)); },

    async teacherSignIn(email, password) {
      const cred = await signInWithEmailAndPassword(auth, String(email).trim(), password);
      if (String(cred.user.email || '').toLowerCase() !== TEACHER) {
        await signOut(auth); await signInAnonymously(auth);
        throw Object.assign(new Error('not teacher'), { code: 'not-teacher' });
      }
    },
    async teacherSignOut() { if (store.isTeacher()) { await signOut(auth); await signInAnonymously(auth); } },

    async uploadImage(path, base64, mime) {
      const r = ref(storage, path);
      await uploadString(r, base64, 'base64', { contentType: mime || 'image/jpeg' });
      return getDownloadURL(r);
    },
    deleteImage: path => deleteObject(ref(storage, path))
  };
  return store;
}

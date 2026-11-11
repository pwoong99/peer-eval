// ============================================================
//  산출물 동료평가 — 기능(API) 모음
//  예전 앱스 스크립트 서버 함수들을 Firestore 위에서 같은 이름·같은 결과 모양으로 다시 만든 것.
//  화면(index.html)은 예전처럼 google.script.run.함수이름(...)으로 부르고,
//  여기 함수들이 대신 실행된다.
//
//  store: Firestore/Storage 를 감싼 얇은 도우미 (js/store.js). 시험할 때는 메모리 버전을 넣는다.
//  만든이 : 푸르이든
// ============================================================

export const STATUS_ACTIVE = '진행중';
export const STATUS_ENDED = '종료';
const GROUP_MAX_SIZE = 6;
const REFLECTION_MAX_LEN = 1000;
const ENDED_PROJECT_MSG = '종료된 프로젝트라 등록·수정·평가를 할 수 없어요. (보기만 가능해요)';

const pad2 = n => String(n).padStart(2, '0');
const pad4 = v => String(v == null ? '' : v).padStart(4, '0');

export function nowStr(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
// "2026-09-07 8:56:51" 처럼 시가 한 자리여도 정확히 읽는다
function timeValue(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return v;
  const m = String(v).match(/(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)).getTime();
  const t = new Date(String(v)).getTime();
  return isNaN(t) ? 0 : t;
}
function randId(prefix) {
  const s = Math.random().toString(36).slice(2, 10).padEnd(8, '0');
  return prefix + '-' + s;
}

export function createApi(store, opts = {}) {
  const PIN_PREFIX = opts.pinPrefix || '';
  const pinFor = num => (PIN_PREFIX + pad2(Number(num))).slice(-4).padStart(4, '0');

  // ---------------- 캐시 (실시간 구독) ----------------
  const C = {
    students: [],        // [{id:'01', num:1, name}]
    projects: [],        // 프로젝트 문서들
    baseReady: null,
    per: new Map(),      // pid -> { subs: Map, evals: Map, refl: Map, ready: Promise, unsubs: [] }
    lru: []
  };

  function startBase() {
    if (C.baseReady) return C.baseReady;
    let r1, r2;
    const p1 = new Promise(r => (r1 = r));
    const p2 = new Promise(r => (r2 = r));
    const fail = r => e => { console.error(e); C.baseReady = null; r(); };
    store.listen('students', [], docs => {
      C.students = docs.map(d => ({ id: d.id, num: Number(d.num), name: String(d.name) }))
        .sort((a, b) => a.num - b.num);
      r1();
    }, fail(r1));
    store.listen('projects', [], docs => {
      C.projects = docs.map(d => Object.assign({}, d));
      r2();
    }, fail(r2));
    C.baseReady = Promise.all([p1, p2]);
    return C.baseReady;
  }

  function ensureProject(pid) {
    if (!pid) return Promise.resolve(null);
    let e = C.per.get(pid);
    if (!e) {
      e = { subs: new Map(), evals: new Map(), refl: new Map(), unsubs: [] };
      const mk = (col, key) => new Promise(res => {
        let first = true;
        const un = store.listen(col, [['projectId', '==', pid]], docs => {
          const m = new Map(); docs.forEach(d => m.set(d.id, d)); e[key] = m;
          if (first) { first = false; res(); }
        }, err => {
          // 권한이 바뀌면(로그아웃 등) 구독이 끊긴다 → 다음에 다시 구독하도록 캐시에서 뺀다
          console.warn('구독 끊김:', col, err && err.code);
          if (C.per.get(pid) === e) { e.unsubs.forEach(u => { try { u(); } catch (x) {} }); C.per.delete(pid); }
          if (first) { first = false; res(); }
        });
        e.unsubs.push(un);
      });
      e.ready = Promise.all([mk('submissions', 'subs'), mk('evaluations', 'evals'), mk('reflections', 'refl')]);
      C.per.set(pid, e);
    }
    // 최근에 본 프로젝트 4개까지만 실시간 구독 유지
    C.lru = [pid].concat(C.lru.filter(x => x !== pid));
    while (C.lru.length > 4) {
      const old = C.lru.pop();
      const oe = C.per.get(old);
      if (oe) { oe.unsubs.forEach(u => { try { u(); } catch (x) {} }); C.per.delete(old); }
    }
    return e.ready.then(() => e);
  }
  // 내가 방금 쓴 내용은 구독 알림을 기다리지 않고 캐시에 바로 반영 (화면이 바로 바뀌도록)
  function cachePut(pid, key, id, data) { const e = C.per.get(pid); if (e) { if (data) e[key].set(id, Object.assign({ id }, data)); else e[key].delete(id); } }

  // ---------------- 도우미 ----------------
  const studentNames = () => C.students.map(s => s.name);
  const sidByName = name => (C.students.find(s => s.name === name) || {}).id || null;
  const nameBySid = sid => (C.students.find(s => s.id === sid) || {}).name || '';

  function sortedProjects() {
    return C.projects.slice().sort((a, b) => (a.startedMs || timeValue(a.startedAt)) - (b.startedMs || timeValue(b.startedAt)));
  }
  function projectObj(pid) {
    const list = sortedProjects();
    const i = list.findIndex(p => p.id === pid);
    if (i < 0) return null;
    const p = list[i];
    return {
      id: p.id, title: p.title || '', desc: p.desc || '', startedAt: p.startedAt || '',
      status: p.status, mode: p.mode || '개인', seq: i + 1,
      questions: p.questions || [], groups: p.groups || [], groupOf: p.groupOf || {}
    };
  }
  function requireProject(pid) {
    const p = pid ? projectObj(pid) : null;
    if (!p) throw new Error('프로젝트를 찾을 수 없습니다. 화면을 새로고침해주세요.');
    return p;
  }
  const isActive = p => p && p.status === STATUS_ACTIVE;

  // 모둠: [{groupId, groupName, members:[이름]}]
  function projectGroups(p) {
    return (p.groups || []).map(g => ({
      groupId: String(g.groupId), groupName: String(g.groupName),
      members: (g.memberSids || []).map(nameBySid).filter(Boolean)
    }));
  }
  function ownerInfo(name, p) {
    if (p.mode !== '모둠') {
      const sid = sidByName(name);
      return sid ? { ownerType: 'individual', ownerKey: sid, groupName: null, members: [name] } : null;
    }
    const sid = sidByName(name);
    const gid = sid ? (p.groupOf || {})[sid] : null;
    if (!gid) return null;
    const g = projectGroups(p).find(x => x.groupId === gid);
    if (!g) return null;
    return { ownerType: 'group', ownerKey: g.groupId, groupName: g.groupName, members: g.members };
  }
  const subIdOf = (pid, ownerKey) => pid + '_' + ownerKey;

  function evalsOf(e, subId) { return Array.from(e.evals.values()).filter(v => v.submissionId === subId); }

  function computeResults(sub, p, e) {
    if (!sub) return { hasSubmission: false };
    const questions = p.questions || [];
    const evs = evalsOf(e, sub.id);
    const sums = {}, counts = {};
    questions.forEach(q => { sums[q.id] = 0; counts[q.id] = 0; });
    const comments = [];
    evs.sort((a, b) => timeValue(a.createdAt) - timeValue(b.createdAt)).forEach(r => {
      const sc = r.scores || {};
      questions.forEach(q => { const v = Number(sc[q.id]); if (!isNaN(v) && v > 0) { sums[q.id] += v; counts[q.id] += 1; } });
      if (r.comment) comments.push({ evaluator: r.evaluatorName || nameBySid(r.evaluatorSid), comment: r.comment, date: r.updatedAt || r.createdAt || '' });
    });
    const averages = {};
    let os = 0, on = 0;
    questions.forEach(q => {
      const avg = counts[q.id] ? sums[q.id] / counts[q.id] : 0;
      averages[q.id] = Math.round(avg * 10) / 10;
      if (counts[q.id]) { os += avg; on += 1; }
    });
    return {
      hasSubmission: true,
      submission: {
        title: sub.title, desc: sub.desc || '', url: sub.url || '', imageUrl: sub.imageUrl || '',
        createdAt: sub.createdAt || '', updatedAt: sub.updatedAt || '',
        name: sub.name || '', groupName: sub.groupName || ''
      },
      questions, averages,
      overallAverage: on ? Math.round((os / on) * 10) / 10 : 0,
      evaluationCount: evs.length,
      comments
    };
  }
  function overallAvg(evs, questions) {
    if (!evs.length || !questions.length) return null;
    let sum = 0, n = 0;
    questions.forEach(q => {
      let qs = 0, qc = 0;
      evs.forEach(r => { const v = Number((r.scores || {})[q.id]); if (!isNaN(v) && v > 0) { qs += v; qc += 1; } });
      if (qc) { sum += qs / qc; n += 1; }
    });
    return n ? Math.round((sum / n) * 10) / 10 : null;
  }

  function teacherOnly() {
    if (!store.isTeacher()) throw Object.assign(new Error('교사 로그인이 필요해요. 다시 로그인해주세요.'), { code: 'not-teacher' });
  }
  function errText(e) {
    const c = (e && e.code) || '';
    if (c.includes('permission-denied')) return '권한이 없어요. (프로젝트가 종료되었거나 로그인이 풀렸을 수 있어요. 다시 로그인해보세요)';
    if (c.includes('unavailable')) return '인터넷 연결을 확인해 주세요.';
    return (e && e.message) || String(e);
  }

  async function uploadPhoto(p, owner, imageData) {
    if (!imageData || !imageData.base64) return null;
    const path = `photos/${p.id}/${owner.ownerKey}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
    const url = await store.uploadImage(path, imageData.base64, imageData.mimeType || 'image/jpeg');
    return { url, path };
  }
  async function removePhoto(path, keepPath) {
    if (!path || path === keepPath) return; // 예전 드라이브 사진(path 없음)은 그대로 둔다
    try { await store.deleteImage(path); } catch (e) { /* 이미 없으면 무시 */ }
  }

  // 이 산출물과 (선택) 특정 학생들이 이 프로젝트에서 남긴 평가를 지운다
  async function deleteSubmissionDeep(p, e, sub, alsoEvaluatorSids) {
    const ops = [];
    if (sub) {
      evalsOf(e, sub.id).forEach(v => ops.push({ op: 'delete', path: 'evaluations', id: v.id }));
      ops.push({ op: 'delete', path: 'submissions', id: sub.id });
    }
    (alsoEvaluatorSids || []).forEach(sid => {
      Array.from(e.evals.values()).filter(v => v.evaluatorSid === sid && (!sub || v.submissionId !== sub.id))
        .forEach(v => ops.push({ op: 'delete', path: 'evaluations', id: v.id }));
    });
    await store.batch(ops);
    ops.forEach(o => cachePut(p.id, o.path === 'evaluations' ? 'evals' : 'subs', o.id, null));
    if (sub) await removePhoto(sub.imagePath);
  }

  // 모둠 구성 정리 (예전 normalizeGroups_ 와 같은 규칙)
  function normalizeGroups(groups, existingIds) {
    const allNames = studentNames();
    const list = (groups || []).map((g, i) => ({
      groupId: g && g.groupId ? String(g.groupId) : '',
      groupName: (g && g.groupName && String(g.groupName).trim()) || ((i + 1) + '모둠'),
      members: ((g && g.members) || []).map(m => String(m).trim()).filter(m => m)
    }));
    if (!list.length) return { error: '모둠을 1개 이상 만들어주세요.' };
    const gNames = list.map(g => g.groupName);
    const dupG = [...new Set(gNames.filter((v, i) => gNames.indexOf(v) !== i))];
    if (dupG.length) return { error: '모둠 이름이 겹쳐요: ' + dupG.join(', ') };
    for (const g of list) {
      if (g.members.length > GROUP_MAX_SIZE) return { error: g.groupName + '의 인원이 ' + GROUP_MAX_SIZE + '명을 넘어요. (현재 ' + g.members.length + '명)' };
      const unknown = g.members.filter(m => allNames.indexOf(m) === -1);
      if (unknown.length) return { error: '명단에 없는 학생이 있어요: ' + unknown.join(', ') };
    }
    const assigned = list.reduce((a, g) => a.concat(g.members), []);
    const dup = [...new Set(assigned.filter((v, i) => assigned.indexOf(v) !== i))];
    if (dup.length) return { error: '한 학생이 여러 모둠에 중복 배정되었습니다: ' + dup.join(', ') };
    const keep = (existingIds || []).map(String);
    const used = {};
    list.forEach(g => { if (g.groupId && keep.indexOf(g.groupId) !== -1 && !used[g.groupId]) used[g.groupId] = true; else g.groupId = ''; });
    let next = 1;
    keep.forEach(id => { const n = Number(String(id).replace(/^G/, '')); if (!isNaN(n) && n >= next) next = n + 1; });
    list.forEach(g => { if (!g.groupId) { g.groupId = 'G' + next; next++; } });
    return { groups: list, unassigned: allNames.filter(n => assigned.indexOf(n) === -1) };
  }
  function groupsToDoc(groups) {
    const out = [], groupOf = {};
    groups.forEach(g => {
      const sids = g.members.map(sidByName).filter(Boolean);
      sids.forEach(s => { groupOf[s] = g.groupId; });
      out.push({ groupId: g.groupId, groupName: g.groupName, memberSids: sids });
    });
    return { groups: out, groupOf };
  }

  // ============================================================
  //  화면에서 부르는 기능들 (예전 Code.gs 와 같은 이름·결과 모양)
  // ============================================================
  const api = {};

  api.getInitData = async () => {
    await startBase();
    return { students: studentNames(), activeCount: C.projects.filter(p => p.status === STATUS_ACTIVE).length };
  };

  // ---------- 학생 로그인 / 비밀번호 ----------
  api.verifyStudentLogin = async (name, password) => {
    await startBase();
    const sid = sidByName(name);
    if (!sid) return { success: false, message: '학생 정보를 찾을 수 없습니다.' };
    try {
      await store.createSession(sid, pad4(password));
      return { success: true };
    } catch (e) {
      if (String(e.code || '').includes('permission-denied')) return { success: false, message: '비밀번호가 일치하지 않습니다.' };
      return { success: false, message: errText(e) };
    }
  };

  api.changeStudentPassword = async (name, oldPw, newPw) => {
    if (!/^\d{4}$/.test(String(newPw))) return { success: false, message: '새 비밀번호는 숫자 4자리로 입력해주세요.' };
    const sid = sidByName(name);
    if (!sid) return { success: false, message: '학생 정보를 찾을 수 없습니다.' };
    try { await store.createSession(sid, pad4(oldPw)); }
    catch (e) { return { success: false, message: '현재 비밀번호가 일치하지 않습니다.' }; }
    try {
      await store.update('pins', sid, { pin: String(newPw), updatedAt: Date.now() });
      await store.createSession(sid, String(newPw));
      return { success: true };
    } catch (e) { return { success: false, message: '변경 중 오류: ' + errText(e) }; }
  };

  api.studentSignOut = async () => { try { await store.deleteSession(); } catch (e) {} return { success: true }; };

  // ---------- 교사 로그인 ----------
  api.teacherSignIn = async (email, password) => {
    try { await store.teacherSignIn(email, password); await startBase(); return { success: true }; }
    catch (e) {
      const c = String(e.code || '');
      if (c.includes('wrong-password') || c.includes('invalid-credential') || c.includes('user-not-found') || c.includes('invalid-email'))
        return { success: false, message: '이메일 또는 비밀번호가 맞지 않아요.' };
      if (c.includes('not-teacher')) return { success: false, message: '교사 계정이 아니에요. 교사용 이메일로 로그인해주세요.' };
      if (c.includes('too-many-requests')) return { success: false, message: '로그인 시도가 너무 많아요. 잠시 후 다시 해주세요.' };
      return { success: false, message: '로그인 실패 (' + (c || e.message) + ')' };
    }
  };
  api.teacherSignOut = async () => { try { await store.teacherSignOut(); } catch (e) {} return { success: true }; };
  api.teacherLogin = async () => ({ success: store.isTeacher() });

  api.teacherListStudents = async () => {
    teacherOnly(); await startBase();
    const pins = await store.getAll('pins');
    const pm = {}; pins.forEach(p => { pm[p.id] = p.pin; });
    return {
      success: true,
      list: C.students.map(s => {
        const pw = pad4(pm[s.id] || '');
        return { number: s.num, name: s.name, password: pw, isDefault: pw === pinFor(s.num) };
      })
    };
  };
  api.teacherResetStudentPassword = async (_pw, name) => {
    teacherOnly();
    const s = C.students.find(x => x.name === name);
    if (!s) return { success: false, message: '학생을 찾을 수 없습니다.' };
    const pin = pinFor(s.num);
    await store.set('pins', s.id, { pin, updatedAt: Date.now() });
    return { success: true, password: pin };
  };
  api.teacherSetStudentPassword = async (_pw, name, newPw) => {
    teacherOnly();
    const pin = String(newPw == null ? '' : newPw).trim();
    if (!/^\d{4}$/.test(pin)) return { success: false, message: '비밀번호는 숫자 4자리로 입력해주세요.' };
    const s = C.students.find(x => x.name === name);
    if (!s) return { success: false, message: '학생을 찾을 수 없습니다.' };
    await store.set('pins', s.id, { pin, updatedAt: Date.now() });
    return { success: true, password: pin };
  };
  api.teacherResetAllPasswords = async (_pw, confirmText) => {
    teacherOnly();
    if (String(confirmText || '').trim() !== '초기화') return { success: false, message: '확인 글자가 맞지 않아 초기화하지 않았어요.' };
    await startBase();
    if (!C.students.length) return { success: false, message: '등록된 학생이 없어요.' };
    await store.batch(C.students.map(s => ({ op: 'set', path: 'pins', id: s.id, data: { pin: pinFor(s.num), updatedAt: Date.now() } })));
    return { success: true, count: C.students.length };
  };

  // 학생 명단 등록·수정 (교사) — "1 김하늘" 처럼 한 줄에 한 명
  api.teacherSaveRoster = async (_pw, lines) => {
    teacherOnly(); await startBase();
    const rows = [];
    for (const raw of lines) {
      const m = String(raw).trim().match(/^(\d{1,2})\s*[\t ,.]\s*(.+)$/);
      if (!String(raw).trim()) continue;
      if (!m) return { success: false, message: '이 줄을 이해하지 못했어요: "' + raw + '" (예: 1 김하늘)' };
      rows.push({ num: Number(m[1]), name: m[2].trim() });
    }
    if (!rows.length) return { success: false, message: '명단이 비어 있어요.' };
    const names = rows.map(r => r.name), nums = rows.map(r => r.num);
    const dupN = names.filter((v, i) => names.indexOf(v) !== i);
    if (dupN.length) return { success: false, message: '이름이 겹쳐요: ' + [...new Set(dupN)].join(', ') + ' (같은 이름이면 "김하늘B"처럼 구분해 주세요)' };
    const dupNum = nums.filter((v, i) => nums.indexOf(v) !== i);
    if (dupNum.length) return { success: false, message: '번호가 겹쳐요: ' + [...new Set(dupNum)].join(', ') };
    const existingPins = {}; (await store.getAll('pins')).forEach(p => { existingPins[p.id] = p.pin; });
    const ops = [];
    rows.forEach(r => {
      const sid = pad2(r.num);
      ops.push({ op: 'set', path: 'students', id: sid, data: { num: r.num, name: r.name } });
      if (!existingPins[sid]) ops.push({ op: 'set', path: 'pins', id: sid, data: { pin: pinFor(r.num), updatedAt: Date.now() } });
    });
    await store.batch(ops);
    return { success: true, count: rows.length };
  };
  api.teacherDeleteStudent = async (_pw, name) => {
    teacherOnly();
    const s = C.students.find(x => x.name === name);
    if (!s) return { success: false, message: '학생을 찾을 수 없습니다.' };
    await store.batch([{ op: 'delete', path: 'students', id: s.id }, { op: 'delete', path: 'pins', id: s.id }]);
    return { success: true };
  };

  // ---------- 학생: 프로젝트 / 나의 산출물 ----------
  api.getStudentProjectHistory = async () => {
    await startBase();
    const list = sortedProjects().map((p, i) => ({
      id: p.id, title: p.title || '', desc: p.desc || '', startedAt: p.startedAt || '',
      status: p.status, seq: i + 1, mode: p.mode || '개인'
    }));
    list.sort((a, b) => b.seq - a.seq);
    return { success: true, list };
  };

  api.getMySubmission = async (name, projectId) => {
    await startBase();
    const p = requireProject(projectId);
    const e = await ensureProject(p.id);
    const active = isActive(p);
    const owner = ownerInfo(name, p);
    if (!owner) return { found: false, noGroup: true, projectActive: active };
    const sub = e.subs.get(subIdOf(p.id, owner.ownerKey));
    if (!sub) return { found: false, groupName: owner.groupName, members: owner.members, projectActive: active };
    return {
      found: true, projectActive: active, submissionId: sub.id,
      title: sub.title, desc: sub.desc || '', url: sub.url || '', imageUrl: sub.imageUrl || '',
      createdAt: sub.createdAt || '', updatedAt: sub.updatedAt || '',
      groupName: owner.groupName, members: owner.members
    };
  };

  api.registerSubmission = async (name, projectId, title, url, desc, imageData) => {
    if (!name) return { success: false, message: '로그인 정보가 없습니다. 다시 로그인해주세요.' };
    if (!title || !url) return { success: false, message: '제목과 URL은 필수입니다.' };
    try {
      await startBase();
      const p = requireProject(projectId);
      if (!isActive(p)) return { success: false, message: ENDED_PROJECT_MSG };
      const owner = ownerInfo(name, p);
      if (!owner) return { success: false, message: '아직 모둠에 배정되지 않았어요. 선생님께 문의해주세요.' };
      const e = await ensureProject(p.id);
      const id = subIdOf(p.id, owner.ownerKey);
      if (e.subs.get(id) || await store.get('submissions', id)) {
        return { success: false, message: (owner.ownerType === 'group' ? '이미 우리 모둠이' : '이미') + ' 이 프로젝트에 등록한 산출물이 있습니다.' };
      }
      const ts = nowStr();
      const data = {
        projectId: p.id, ownerType: owner.ownerType, ownerKey: owner.ownerKey,
        groupName: owner.groupName || '', name, title: String(title), desc: String(desc || ''), url: String(url),
        imageUrl: '', imagePath: '', createdAt: ts, updatedAt: ts, createdMs: Date.now()
      };
      const photo = await uploadPhoto(p, owner, imageData);
      if (photo) { data.imageUrl = photo.url; data.imagePath = photo.path; }
      await store.set('submissions', id, data);
      cachePut(p.id, 'subs', id, data);
      return { success: true };
    } catch (e) { return { success: false, message: '등록 중 오류가 발생했습니다: ' + errText(e) }; }
  };

  api.updateSubmission = async (name, projectId, title, url, desc, imageData) => {
    try {
      await startBase();
      const p = requireProject(projectId);
      if (!isActive(p)) return { success: false, message: ENDED_PROJECT_MSG };
      const owner = ownerInfo(name, p);
      if (!owner) return { success: false, message: '아직 모둠에 배정되지 않았어요. 선생님께 문의해주세요.' };
      const e = await ensureProject(p.id);
      const id = subIdOf(p.id, owner.ownerKey);
      const found = e.subs.get(id);
      if (!found) return { success: false, message: '등록된 산출물이 없습니다.' };
      const newUrl = String(url == null ? '' : url).trim();
      if (!String(title || '').trim()) return { success: false, message: '제목은 꼭 입력해주세요.' };
      if (!newUrl && !found.url) return { success: false, message: 'URL을 입력해주세요.' };
      const upd = { title: String(title), url: newUrl || found.url, desc: String(desc || ''), updatedAt: nowStr() };
      if (owner.ownerType === 'group') upd.name = name; // 마지막으로 수정한 모둠원
      const photo = await uploadPhoto(p, owner, imageData);
      if (photo) { upd.imageUrl = photo.url; upd.imagePath = photo.path; }
      await store.update('submissions', id, upd);
      cachePut(p.id, 'subs', id, Object.assign({}, found, upd));
      if (photo) await removePhoto(found.imagePath, photo.path);
      return { success: true };
    } catch (e) { return { success: false, message: '수정 중 오류: ' + errText(e) }; }
  };

  api.deleteSubmission = async (name, projectId) => {
    try {
      await startBase();
      const p = requireProject(projectId);
      if (!isActive(p)) return { success: false, message: ENDED_PROJECT_MSG };
      const owner = ownerInfo(name, p);
      if (!owner) return { success: false, message: '아직 모둠에 배정되지 않았어요. 선생님께 문의해주세요.' };
      const e = await ensureProject(p.id);
      const sub = e.subs.get(subIdOf(p.id, owner.ownerKey));
      if (!sub) return { success: false, message: '등록된 산출물이 없습니다.' };
      await deleteSubmissionDeep(p, e, sub, []);
      return { success: true };
    } catch (e) { return { success: false, message: '삭제 중 오류: ' + errText(e) }; }
  };

  // ---------- 결과 / 돌아보기 ----------
  async function resultsForName(name, projectId) {
    await startBase();
    const p = projectObj(projectId);
    if (!p) return { hasSubmission: false };
    const e = await ensureProject(p.id);
    const owner = ownerInfo(name, p);
    if (!owner) return { hasSubmission: false, noGroup: true };
    return computeResults(e.subs.get(subIdOf(p.id, owner.ownerKey)), p, e);
  }
  function reflList(e) {
    return Array.from(e.refl.values()).filter(r => String(r.text || '').trim())
      .map(r => ({ name: r.name || nameBySid(r.sid), sid: r.sid, text: r.text, updatedAt: r.updatedAt || '' }));
  }

  api.getMyEvaluationResults = async (name, projectId) => {
    try {
      const result = await resultsForName(name, projectId);
      if (projectId) {
        const e = await ensureProject(projectId);
        const r = reflList(e).find(x => x.name === name);
        result.myReflection = r ? { text: r.text, updatedAt: r.updatedAt } : { text: '', updatedAt: '' };
      }
      return result;
    } catch (e) { return { hasSubmission: false, error: true, message: '결과를 불러오는 중 오류: ' + errText(e) }; }
  };

  api.saveMyReflection = async (name, projectId, text) => {
    if (!name) return { success: false, message: '로그인 정보가 없습니다. 다시 로그인해주세요.' };
    const t = String(text == null ? '' : text).trim();
    if (t.length > REFLECTION_MAX_LEN) return { success: false, message: REFLECTION_MAX_LEN + '자 이내로 써주세요. (지금 ' + t.length + '자)' };
    try {
      await startBase();
      const sid = sidByName(name);
      if (!sid) return { success: false, message: '학생 정보를 찾을 수 없습니다.' };
      const p = requireProject(projectId);
      const ts = nowStr();
      const id = p.id + '_' + sid;
      const data = { projectId: p.id, sid, name, text: t, updatedAt: ts };
      await store.set('reflections', id, data);
      cachePut(p.id, 'refl', id, data);
      return { success: true, updatedAt: ts };
    } catch (e) { return { success: false, message: '저장 중 오류: ' + errText(e) }; }
  };

  // ---------- 동료 평가 ----------
  api.getSubmissionsForEvaluation = async (evaluatorName, projectId) => {
    await startBase();
    const p = requireProject(projectId);
    const e = await ensureProject(p.id);
    const owner = ownerInfo(evaluatorName, p);
    const mySid = sidByName(evaluatorName);
    const subs = Array.from(e.subs.values()).filter(s => p.mode === '모둠'
      ? (!owner || s.ownerKey !== owner.ownerKey)
      : s.ownerKey !== mySid);
    const questions = p.questions || [];
    const list = subs.map(s => {
      const mine = e.evals.get(s.id + '_' + mySid);
      const displayName = p.mode === '모둠' ? (s.groupName || s.name) : (nameBySid(s.ownerKey) || s.name);
      const r = { submissionId: s.id, name: String(displayName || ''), title: s.title, desc: s.desc || '', url: s.url || '', imageUrl: s.imageUrl || '', evaluated: !!mine };
      if (mine) { r.myScores = {}; questions.forEach(q => { r.myScores[q.id] = (mine.scores || {})[q.id]; }); r.myComment = mine.comment; }
      return r;
    }).sort((a, b) => a.name.localeCompare(b.name, 'ko'));
    return { projectActive: isActive(p), questions, list };
  };

  api.submitEvaluation = async (submissionId, evaluatorName, scores, comment) => {
    try {
      await startBase();
      const pid = String(submissionId).split('_')[0];
      const p = projectObj(pid);
      if (!p) return { success: false, message: '프로젝트를 찾을 수 없습니다.' };
      const e = await ensureProject(p.id);
      const target = e.subs.get(submissionId);
      if (!target) return { success: false, message: '존재하지 않는 산출물입니다.' };
      if (!isActive(p)) return { success: false, message: ENDED_PROJECT_MSG };
      const sid = sidByName(evaluatorName);
      if (!sid) return { success: false, message: '학생 정보를 찾을 수 없습니다.' };
      if (p.mode === '모둠') {
        const owner = ownerInfo(evaluatorName, p);
        if (owner && owner.ownerKey === target.ownerKey) return { success: false, message: '본인이 속한 모둠의 산출물은 평가할 수 없습니다.' };
      } else if (target.ownerKey === sid) return { success: false, message: '본인의 산출물은 평가할 수 없습니다.' };
      if (!comment || !String(comment).trim()) return { success: false, message: '친구에게 힘이 되는 칭찬의 말을 코멘트로 남겨주세요.' };
      const questions = p.questions || [];
      const sc = {};
      for (const q of questions) {
        const v = Number(scores[q.id]);
        if (!v || v < 1 || v > 5) return { success: false, message: '모든 문항에 1~5점 별점을 매겨주세요.' };
        sc[q.id] = v;
      }
      const id = submissionId + '_' + sid;
      const old = e.evals.get(id);
      const ts = nowStr();
      const data = {
        projectId: p.id, submissionId, evaluatorSid: sid, evaluatorName,
        scores: sc, comment: String(comment), createdAt: old ? (old.createdAt || ts) : ts, updatedAt: ts
      };
      await store.set('evaluations', id, data);
      cachePut(p.id, 'evals', id, data);
      return { success: true };
    } catch (e) { return { success: false, message: '제출 중 오류: ' + errText(e) }; }
  };

  // ---------- 교사: 프로젝트 ----------
  api.teacherListProjects = async () => {
    try {
      teacherOnly(); await startBase();
      const list = await Promise.all(sortedProjects().map(async (p, i) => ({
        id: p.id, title: p.title || '', desc: p.desc || '', startedAt: p.startedAt || '',
        status: p.status, mode: p.mode || '개인', seq: i + 1,
        submissionCount: await store.count('submissions', [['projectId', '==', p.id]]).catch(() => 0)
      })));
      list.sort((a, b) => b.seq - a.seq);
      return { success: true, list };
    } catch (e) { return { success: false, message: '불러오는 중 오류: ' + errText(e) }; }
  };

  api.teacherCreateProject = async (_pw, title, desc, questionTexts, mode, groups) => {
    try {
      teacherOnly(); await startBase();
      if (!title) return { success: false, message: '프로젝트 제목을 입력해주세요.' };
      const qTexts = (questionTexts || []).map(t => String(t || '').trim()).filter(t => t);
      if (!qTexts.length) return { success: false, message: '평가 문항을 최소 1개 이상 입력해주세요.' };
      const modeVal = mode === '모둠' ? '모둠' : '개인';
      const doc = {
        title: String(title), desc: String(desc || ''), startedAt: nowStr(), startedMs: Date.now(),
        status: STATUS_ACTIVE, mode: modeVal,
        questions: qTexts.map((t, i) => ({ id: 'Q' + (i + 1), text: t })),
        groups: [], groupOf: {}
      };
      let unassignedCount = 0;
      if (modeVal === '모둠') {
        const norm = normalizeGroups(groups, []);
        if (norm.error) return { success: false, message: norm.error };
        Object.assign(doc, groupsToDoc(norm.groups));
        unassignedCount = norm.unassigned.length;
      }
      const id = randId('PRJ');
      await store.set('projects', id, doc);
      try { await store.del('drafts', 'newProject'); } catch (e) {}
      return { success: true, projectId: id, unassignedCount };
    } catch (e) { return { success: false, message: '프로젝트 생성 중 오류: ' + errText(e) }; }
  };

  api.teacherUpdateProject = async (_pw, projectId, title, desc, groups) => {
    try {
      teacherOnly(); await startBase();
      if (!title) return { success: false, message: '프로젝트 제목을 입력해주세요.' };
      const p = requireProject(projectId);
      const upd = { title: String(title), desc: String(desc || '') };
      let unassignedCount = 0;
      if (groups && p.mode === '모둠') {
        const existing = projectGroups(p);
        const norm = normalizeGroups(groups, existing.map(g => g.groupId));
        if (norm.error) return { success: false, message: norm.error };
        const e = await ensureProject(p.id);
        const newIds = norm.groups.map(g => g.groupId);
        const subs = Array.from(e.subs.values());
        const blocked = existing.filter(g => newIds.indexOf(g.groupId) === -1 && subs.some(s => s.ownerKey === g.groupId));
        if (blocked.length) return { success: false, message: '산출물을 이미 등록한 모둠은 삭제할 수 없어요: ' + blocked.map(g => g.groupName).join(', ') };
        Object.assign(upd, groupsToDoc(norm.groups));
        const ops = [{ op: 'update', path: 'projects', id: p.id, data: upd }];
        norm.groups.forEach(g => subs.filter(s => s.ownerKey === g.groupId && s.groupName !== g.groupName)
          .forEach(s => ops.push({ op: 'update', path: 'submissions', id: s.id, data: { groupName: g.groupName } })));
        await store.batch(ops);
        unassignedCount = norm.unassigned.length;
        return { success: true, unassignedCount };
      }
      await store.update('projects', p.id, upd);
      return { success: true, unassignedCount };
    } catch (e) { return { success: false, message: '수정 중 오류: ' + errText(e) }; }
  };

  api.teacherSetProjectStatus = async (_pw, projectId, status) => {
    try {
      teacherOnly();
      if (status !== STATUS_ACTIVE && status !== STATUS_ENDED) return { success: false, message: '잘못된 상태 값입니다.' };
      await startBase(); requireProject(projectId);
      await store.update('projects', projectId, { status });
      return { success: true };
    } catch (e) { return { success: false, message: '상태 변경 중 오류: ' + errText(e) }; }
  };

  api.teacherDeleteProject = async (_pw, projectId, confirmText) => {
    try {
      teacherOnly();
      if (String(confirmText || '').trim() !== '삭제') return { success: false, message: '확인 글자가 맞지 않아 삭제하지 않았어요.' };
      await startBase();
      const p = requireProject(projectId);
      const subs = await store.query('submissions', [['projectId', '==', p.id]]);
      const evs = await store.query('evaluations', [['projectId', '==', p.id]]);
      const refl = await store.query('reflections', [['projectId', '==', p.id]]);
      for (const s of subs) await removePhoto(s.imagePath);
      const ops = [];
      evs.forEach(d => ops.push({ op: 'delete', path: 'evaluations', id: d.id }));
      subs.forEach(d => ops.push({ op: 'delete', path: 'submissions', id: d.id }));
      refl.forEach(d => ops.push({ op: 'delete', path: 'reflections', id: d.id }));
      ops.push({ op: 'delete', path: 'projects', id: p.id });
      await store.batch(ops);
      const pe = C.per.get(p.id); if (pe) { pe.unsubs.forEach(u => u()); C.per.delete(p.id); }
      return { success: true, title: p.title, submissionCount: subs.length, evaluationCount: evs.length };
    } catch (e) { return { success: false, message: '삭제 중 오류: ' + errText(e) }; }
  };

  // ---------- 교사: 현황 / 상세 ----------
  api.teacherGetOverview = async (_pw, projectId) => {
    try {
      teacherOnly(); await startBase();
      const p = requireProject(projectId);
      const e = await ensureProject(p.id);
      const questions = p.questions || [];
      const subs = Array.from(e.subs.values());
      if (p.mode === '모둠') {
        const groups = projectGroups(p);
        const list = groups.map(g => {
          const sub = subs.find(s => s.ownerKey === g.groupId);
          const base = { groupId: g.groupId, groupName: g.groupName, members: g.members };
          if (!sub) return Object.assign(base, { registered: false });
          const mine = evalsOf(e, sub.id);
          return Object.assign(base, {
            registered: true, title: sub.title, url: sub.url || '', imageUrl: sub.imageUrl || '',
            createdAt: sub.createdAt || '', updatedAt: sub.updatedAt || '',
            receivedCount: mine.length, avgScore: overallAvg(mine, questions)
          });
        });
        const assigned = groups.reduce((a, g) => a.concat(g.members), []);
        return { success: true, mode: '모둠', list, unassigned: studentNames().filter(n => assigned.indexOf(n) === -1), projectId: p.id };
      }
      const list = C.students.map(st => {
        const sub = e.subs.get(subIdOf(p.id, st.id));
        const base = { number: st.num, name: st.name };
        if (!sub) return Object.assign(base, { registered: false });
        const mine = evalsOf(e, sub.id);
        return Object.assign(base, {
          registered: true, title: sub.title, url: sub.url || '',
          createdAt: sub.createdAt || '', updatedAt: sub.updatedAt || '',
          receivedCount: mine.length, avgScore: overallAvg(mine, questions)
        });
      });
      return { success: true, mode: '개인', list, projectId: p.id };
    } catch (e) { return { success: false, message: '데이터를 불러오는 중 오류: ' + errText(e) }; }
  };

  api.teacherGetStudentResult = async (_pw, name, projectId) => {
    teacherOnly();
    const result = await resultsForName(name, projectId);
    const e = await ensureProject(projectId);
    result.reflections = reflList(e).filter(r => r.name === name).map(r => ({ name: r.name, text: r.text, updatedAt: r.updatedAt }));
    result.success = true;
    return result;
  };

  api.teacherGetGroupResult = async (_pw, groupId, projectId) => {
    teacherOnly(); await startBase();
    const p = projectObj(projectId);
    if (!p) return { hasSubmission: false, success: true };
    const e = await ensureProject(p.id);
    const result = computeResults(e.subs.get(subIdOf(p.id, groupId)), p, e);
    const g = projectGroups(p).find(x => x.groupId === groupId);
    const members = g ? g.members : [];
    result.reflections = reflList(e).filter(r => members.indexOf(r.name) !== -1).map(r => ({ name: r.name, text: r.text, updatedAt: r.updatedAt }));
    result.success = true;
    return result;
  };

  api.teacherSaveSubmission = async (_pw, projectId, target, title, url, desc, imageData) => {
    try {
      teacherOnly(); await startBase();
      title = String(title || '').trim(); url = String(url || '').trim();
      if (!title) return { success: false, message: '제목은 꼭 입력해주세요.' };
      const p = requireProject(projectId);
      let owner;
      if (p.mode === '모둠') {
        const g = projectGroups(p).find(x => x.groupId === String((target && target.groupId) || ''));
        if (!g) return { success: false, message: '모둠을 찾을 수 없습니다. 화면을 새로고침해주세요.' };
        owner = { ownerType: 'group', ownerKey: g.groupId, groupName: g.groupName, members: g.members };
      } else {
        const sid = sidByName(String((target && target.name) || ''));
        if (!sid) return { success: false, message: '학생을 찾을 수 없습니다.' };
        owner = { ownerType: 'individual', ownerKey: sid, groupName: null, members: [target.name] };
      }
      const e = await ensureProject(p.id);
      const id = subIdOf(p.id, owner.ownerKey);
      const found = e.subs.get(id);
      if (!url && !found) return { success: false, message: 'URL을 입력해주세요.' };
      const ts = nowStr();
      const photo = await uploadPhoto(p, owner, imageData);
      if (found) {
        const upd = { title, url: url || found.url, desc: String(desc || ''), updatedAt: ts };
        if (owner.ownerType === 'group') upd.groupName = owner.groupName;
        if (photo) { upd.imageUrl = photo.url; upd.imagePath = photo.path; }
        await store.update('submissions', id, upd);
        cachePut(p.id, 'subs', id, Object.assign({}, found, upd));
        if (photo) await removePhoto(found.imagePath, photo.path);
        return { success: true, created: false };
      }
      const data = {
        projectId: p.id, ownerType: owner.ownerType, ownerKey: owner.ownerKey, groupName: owner.groupName || '',
        name: owner.ownerType === 'group' ? '선생님' : target.name,
        title, url, desc: String(desc || ''), imageUrl: photo ? photo.url : '', imagePath: photo ? photo.path : '',
        createdAt: ts, updatedAt: ts, createdMs: Date.now()
      };
      await store.set('submissions', id, data);
      cachePut(p.id, 'subs', id, data);
      return { success: true, created: true };
    } catch (e) { return { success: false, message: '저장 중 오류: ' + errText(e) }; }
  };

  api.teacherResetAllStudentData = async (_pw, name, projectId) => {
    try {
      teacherOnly(); await startBase();
      const p = requireProject(projectId);
      const e = await ensureProject(p.id);
      const sid = sidByName(name);
      if (!sid) return { success: false, message: '학생을 찾을 수 없습니다.' };
      await deleteSubmissionDeep(p, e, e.subs.get(subIdOf(p.id, sid)), [sid]);
      await store.batch([{ op: 'delete', path: 'reflections', id: p.id + '_' + sid }]);
      cachePut(p.id, 'refl', p.id + '_' + sid, null);
      return { success: true };
    } catch (e) { return { success: false, message: '초기화 중 오류: ' + errText(e) }; }
  };

  api.teacherResetGroupData = async (_pw, groupId, projectId) => {
    try {
      teacherOnly(); await startBase();
      const p = requireProject(projectId);
      if (p.mode !== '모둠') return { success: false, message: '모둠 프로젝트가 아닙니다.' };
      const e = await ensureProject(p.id);
      const g = projectGroups(p).find(x => x.groupId === groupId);
      const sids = (g ? g.members : []).map(sidByName).filter(Boolean);
      await deleteSubmissionDeep(p, e, e.subs.get(subIdOf(p.id, groupId)), sids);
      await store.batch(sids.map(s => ({ op: 'delete', path: 'reflections', id: p.id + '_' + s })));
      sids.forEach(s => cachePut(p.id, 'refl', p.id + '_' + s, null));
      return { success: true };
    } catch (e) { return { success: false, message: '초기화 중 오류: ' + errText(e) }; }
  };

  api.teacherListReflections = async (_pw, projectId) => {
    try {
      teacherOnly(); await startBase();
      const p = requireProject(projectId);
      const e = await ensureProject(p.id);
      const refl = reflList(e);
      const groups = p.mode === '모둠' ? projectGroups(p) : [];
      const list = C.students.map(st => {
        const r = refl.find(x => x.name === st.name || x.sid === st.id);
        const g = groups.find(x => x.members.indexOf(st.name) !== -1);
        return { number: st.num, name: st.name, groupName: g ? g.groupName : '', text: r ? r.text : '', updatedAt: r ? r.updatedAt : '' };
      });
      return { success: true, mode: p.mode, list, writtenCount: list.filter(x => x.text).length };
    } catch (e) { return { success: false, message: '불러오는 중 오류: ' + errText(e) }; }
  };

  api.teacherGetGroupSetup = async (_pw, projectId) => {
    try {
      teacherOnly(); await startBase();
      const p = requireProject(projectId);
      const e = await ensureProject(p.id);
      const subs = Array.from(e.subs.values());
      const groups = projectGroups(p).map(g => Object.assign({}, g, { hasSubmission: subs.some(s => s.ownerKey === g.groupId) }));
      return { success: true, mode: p.mode, students: studentNames(), groups };
    } catch (e) { return { success: false, message: '모둠 정보를 불러오는 중 오류: ' + errText(e) }; }
  };

  // ---------- 교사: 새 프로젝트 임시저장 ----------
  api.teacherSaveProjectDraft = async (_pw, draft) => {
    try {
      teacherOnly();
      const savedAt = nowStr();
      await store.set('drafts', 'newProject', Object.assign({}, draft || {}, { savedAt }));
      return { success: true, savedAt };
    } catch (e) { return { success: false, message: '임시저장 중 오류: ' + errText(e) }; }
  };
  api.teacherGetProjectDraft = async () => {
    teacherOnly();
    const d = await store.get('drafts', 'newProject');
    return { success: true, draft: d || null };
  };
  api.teacherDeleteProjectDraft = async () => {
    teacherOnly();
    await store.del('drafts', 'newProject');
    return { success: true };
  };

  // ---------- 교사: 예전 앱스 스크립트 데이터 가져오기 ----------
  // data: 앱스 스크립트 내보내기 결과 { sheets: { Students:[...], Projects:[...], ... } } (각 행은 {열이름: 값})
  api.teacherImportLegacy = async (_pw, data, onProgress) => {
    teacherOnly();
    const sh = (data && data.sheets) || {};
    const say = m => { if (onProgress) onProgress(m); };
    const rows = n => (sh[n] || []).filter(r => Object.values(r).some(v => v !== '' && v != null));

    // 1) 학생 + 비밀번호
    const students = rows('Students').filter(r => r['이름']).map(r => ({ num: Number(r['번호']), name: String(r['이름']).trim(), pin: pad4(r['비밀번호']) }));
    if (!students.length) throw new Error('가져온 데이터에 학생 명단이 없어요.');
    const sidOfName = {}; students.forEach(s => { sidOfName[s.name] = pad2(s.num); });
    const ops = [];
    students.forEach(s => {
      ops.push({ op: 'set', path: 'students', id: pad2(s.num), data: { num: s.num, name: s.name } });
      ops.push({ op: 'set', path: 'pins', id: pad2(s.num), data: { pin: /^\d{4}$/.test(s.pin) ? s.pin : pinFor(s.num), updatedAt: Date.now() } });
    });

    // 2) 프로젝트 + 문항 + 모둠
    const qRows = rows('Questions'); const gRows = rows('Groups');
    const projects = rows('Projects').filter(r => r['프로젝트ID']);
    const projMode = {};
    projects.forEach(r => {
      const pid = String(r['프로젝트ID']);
      const mode = r['평가방식'] === '모둠' ? '모둠' : '개인';
      projMode[pid] = mode;
      const questions = qRows.filter(q => String(q['프로젝트ID']) === pid).map(q => ({ id: String(q['문항ID']), text: String(q['문항내용']) }));
      const gmap = {}, order = [];
      gRows.filter(g => String(g['프로젝트ID']) === pid).forEach(g => {
        const gid = String(g['모둠ID']);
        if (!gmap[gid]) { gmap[gid] = { groupId: gid, groupName: String(g['모둠이름']), memberSids: [] }; order.push(gid); }
        const nm = String(g['이름'] || '').trim();
        const sid = sidOfName[nm];
        if (sid && gmap[gid].memberSids.indexOf(sid) === -1) gmap[gid].memberSids.push(sid);
      });
      const groups = order.map(k => gmap[k]);
      const groupOf = {}; groups.forEach(g => g.memberSids.forEach(s => { groupOf[s] = g.groupId; }));
      const startedAt = String(r['시작일시'] || '');
      ops.push({ op: 'set', path: 'projects', id: pid, data: {
        title: String(r['제목'] || ''), desc: String(r['소개'] || ''), startedAt, startedMs: timeValue(startedAt),
        status: r['상태'] === STATUS_ACTIVE ? STATUS_ACTIVE : STATUS_ENDED, mode, questions, groups, groupOf
      } });
    });

    // 3) 산출물 (예전 사진은 드라이브 주소 그대로)
    const subIdMap = {};
    let subCount = 0;
    rows('Submissions').forEach(r => {
      const pid = String(r['프로젝트ID'] || '');
      if (!projMode[pid]) return;
      const isGroup = projMode[pid] === '모둠';
      const ownerKey = isGroup ? String(r['모둠ID'] || '') : sidOfName[String(r['이름'] || '').trim()];
      if (!ownerKey) return;
      const id = pid + '_' + ownerKey;
      subIdMap[String(r['제출ID'])] = { id, pid };
      ops.push({ op: 'set', path: 'submissions', id, data: {
        projectId: pid, ownerType: isGroup ? 'group' : 'individual', ownerKey,
        groupName: String(r['모둠이름'] || ''), name: String(r['이름'] || ''),
        title: String(r['제목'] || ''), desc: String(r['소개'] || ''), url: String(r['URL'] || ''),
        imageUrl: String(r['사진URL'] || ''), imagePath: '',
        createdAt: String(r['등록일시'] || ''), updatedAt: String(r['수정일시'] || r['등록일시'] || ''),
        createdMs: timeValue(r['등록일시'])
      } });
      subCount++;
    });

    // 4) 평가
    let evCount = 0;
    rows('Evaluations').forEach(r => {
      const m = subIdMap[String(r['제출ID'])];
      const esid = sidOfName[String(r['평가자이름'] || '').trim()];
      if (!m || !esid) return;
      let scores = {};
      try { scores = JSON.parse(r['점수JSON'] || '{}'); } catch (x) { scores = {}; }
      if (!Object.keys(scores).length) Object.keys(r).forEach(k => { const mm = k.match(/^(Q\d+)점수$/); if (mm && r[k] !== '') scores[mm[1]] = Number(r[k]); });
      ops.push({ op: 'set', path: 'evaluations', id: m.id + '_' + esid, data: {
        projectId: m.pid, submissionId: m.id, evaluatorSid: esid, evaluatorName: String(r['평가자이름']),
        scores, comment: String(r['코멘트'] || ''),
        createdAt: String(r['평가일시'] || ''), updatedAt: String(r['수정일시'] || r['평가일시'] || '')
      } });
      evCount++;
    });

    // 5) 돌아보기
    let rfCount = 0;
    rows('Reflections').forEach(r => {
      const pid = String(r['프로젝트ID'] || ''); const nm = String(r['이름'] || '').trim(); const sid = sidOfName[nm];
      if (!projMode[pid] || !sid || !String(r['내용'] || '').trim()) return;
      ops.push({ op: 'set', path: 'reflections', id: pid + '_' + sid, data: { projectId: pid, sid, name: nm, text: String(r['내용']), updatedAt: String(r['수정일시'] || '') } });
      rfCount++;
    });

    say('저장하는 중... (' + ops.length + '건)');
    await store.batch(ops, n => say('저장하는 중... ' + n + ' / ' + ops.length));
    return { success: true, students: students.length, projects: projects.length, submissions: subCount, evaluations: evCount, reflections: rfCount };
  };

  // 화면 쪽에서 쓰는 보조 값
  api.__cache = C;
  api.__startBase = startBase;
  return api;
}

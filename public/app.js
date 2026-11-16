import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.0.0/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signInAnonymously, signInWithEmailAndPassword, signOut, deleteUser,
  connectAuthEmulator, EmailAuthProvider, reauthenticateWithCredential, updatePassword,
} from 'https://www.gstatic.com/firebasejs/12.0.0/firebase-auth.js';
import {
  getFirestore, connectFirestoreEmulator, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc,
  collection, query, limit, runTransaction, writeBatch,
} from 'https://www.gstatic.com/firebasejs/12.0.0/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';
import { SEED_TEAMS, makeSessions } from './seed.js';

// ---------- Firebase ----------

// http://localhost:5000/?emulator 로 열면 로컬 에뮬레이터(demo-slat)에 연결한다.
const USE_EMULATOR = ['localhost', '127.0.0.1'].includes(location.hostname)
  && new URLSearchParams(location.search).has('emulator');
const CONFIGURED = USE_EMULATOR || !String(firebaseConfig.apiKey).startsWith('YOUR_');

const fbApp = initializeApp(USE_EMULATOR
  ? { apiKey: 'demo-key', authDomain: 'demo-slat.firebaseapp.com', projectId: 'demo-slat' }
  : firebaseConfig);
const auth = getAuth(fbApp);
const db = getFirestore(fbApp);
if (USE_EMULATOR) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
}

const $app = document.getElementById('app');
const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];

const state = { me: null, ready: false, linking: false, dirty: false };

const STATUS = {
  empty: { label: '미작성', cls: 'st-empty' },
  draft: { label: '작성 중', cls: 'st-draft' },
  submitted: { label: '제출됨', cls: 'st-submitted' },
  revise: { label: '요청됨', cls: 'st-revise' },
  approved: { label: '확인 완료', cls: 'st-approved' },
};
const DONE = ['submitted', 'revise', 'approved'];
const LOG_TEXT_FIELDS = ['content', 'results', 'issues', 'nextPlan', 'references'];
const ATT_MARKS = ['출석', '지각', '조퇴', '결석', '공결'];
const BUDGET_PER_PERSON = 25000;

// ---------- 공통 도우미 ----------

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fmtDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${m}/${d}(${'일월화수목금토'[new Date(y, m - 1, d).getDay()]})`;
}

function fmtDateTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function badge(status, date) {
  const today = todayStr();
  if (!DONE.includes(status)) {
    if (date < today) return `<span class="badge overdue">${status === 'draft' ? '작성 중·기한 지남' : '미제출'}</span>`;
    if (date === today) return `<span class="badge today">오늘 차시</span>`;
  }
  const s = STATUS[status] || STATUS.empty;
  return `<span class="badge ${s.cls}">${s.label}</span>`;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 2400);
}

function block(title, text) {
  return `<div class="readonly-block"><h3>${esc(title)}</h3>${text && String(text).trim() ? `<div>${esc(text)}</div>` : '<div class="empty">작성 안 됨</div>'}</div>`;
}

function fmtWon(n) {
  return `${Number(n || 0).toLocaleString('ko-KR')}원`;
}

// 팀 예산 한도 = 인원 × 1인당 금액. 남은 예산은 구매 예정까지 뺀 값.
function budgetOf(team) {
  const purchases = team.purchases || [];
  const sum = arr => arr.reduce((n, p) => n + (Number(p.amount) || 0), 0);
  const limit = team.members.length * BUDGET_PER_PERSON;
  const spent = sum(purchases.filter(p => p.status === '구매완료'));
  const pending = sum(purchases.filter(p => p.status !== '구매완료'));
  const planned = (team.budget || []).reduce((n, b) => n + (Number(b.total) || 0), 0);
  return { limit, spent, pending, planned, remaining: limit - spent - pending };
}

function budgetBar(b) {
  const max = Math.max(b.limit, b.spent + b.pending) || 1;
  return `<div class="progress budget-bar"><span style="width:${b.spent / max * 100}%;background:var(--accent)"></span><span style="width:${b.pending / max * 100}%;background:#e0b04a"></span></div>`;
}

function won(n) {
  return n ? Number(n).toLocaleString('ko-KR') : '';
}

function friendlyError(e) {
  const map = {
    'auth/invalid-credential': '이메일 또는 비밀번호가 올바르지 않습니다.',
    'auth/invalid-email': '이메일 형식이 올바르지 않습니다.',
    'auth/wrong-password': '비밀번호가 올바르지 않습니다.',
    'auth/too-many-requests': '시도가 너무 많습니다. 잠시 후 다시 시도하세요.',
    'auth/operation-not-allowed': 'Firebase 콘솔에서 해당 로그인 방식(익명/이메일)이 꺼져 있습니다.',
    'auth/configuration-not-found': 'Firebase 콘솔에서 Authentication이 아직 설정되지 않았습니다. (Authentication → 시작하기)',
    'auth/network-request-failed': '네트워크에 연결할 수 없습니다.',
    'auth/weak-password': '비밀번호는 6자 이상이어야 합니다.',
    'permission-denied': '권한이 없습니다. 다시 로그인해 주세요.',
    'unavailable': '서버에 연결할 수 없습니다. 인터넷 연결을 확인하세요.',
  };
  return map[e?.code] || e?.message || '알 수 없는 오류가 발생했습니다.';
}

window.addEventListener('beforeunload', e => {
  if (state.dirty) { e.preventDefault(); e.returnValue = ''; }
});

// ---------- 데이터 ----------

// 학생이 새 기록을 만들 때의 기본값 (보안 규칙이 허용하는 필드만)
const studentDefaults = () => ({
  content: '', results: '', issues: '', nextPlan: '', references: '',
  attendance: [], contributions: {}, history: [],
});

const emptyLog = () => ({
  status: 'empty', rev: 0,
  content: '', results: '', issues: '', nextPlan: '', references: '',
  attendance: [], contributions: {}, feedback: '', history: [],
});

async function fetchLogs(teamId) {
  const logs = {};
  (await getDocs(collection(db, 'teams', teamId, 'logs'))).forEach(d => {
    logs[d.id] = { ...emptyLog(), ...d.data() };
  });
  return logs;
}

async function fetchAttendance(teamId) {
  const att = {};
  (await getDocs(collection(db, 'teams', teamId, 'attendance'))).forEach(d => {
    att[d.id] = { marks: {}, notes: {}, ...d.data() };
  });
  return att;
}

async function fetchTeam(teamId) {
  const snap = await getDoc(doc(db, 'teams', teamId));
  if (!snap.exists()) throw new Error('팀을 찾을 수 없습니다.');
  const team = { id: snap.id, ...snap.data() };
  const [found, attendance] = await Promise.all([fetchLogs(teamId), fetchAttendance(teamId)]);
  const logs = {};
  for (const s of team.sessions) logs[s.no] = found[s.no] || emptyLog();
  return { team, logs, attendance };
}

async function fetchAllTeams() {
  const snaps = await getDocs(collection(db, 'teams'));
  const teams = snaps.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (a.order ?? 999) - (b.order ?? 999) || a.name.localeCompare(b.name, 'ko'));
  await Promise.all(teams.map(async t => {
    [t.logs, t.attendance] = await Promise.all([fetchLogs(t.id), fetchAttendance(t.id)]);
  }));
  return teams;
}

// 기록 저장/제출. rev가 다르면 다른 팀원이 먼저 저장한 것이므로 막는다.
async function saveLog(team, no, action, fields, baseRev) {
  const ref = doc(db, 'teams', team.id, 'logs', String(no));
  const me = state.me;
  if (me.preview) throw new Error(PREVIEW_BLOCK);
  const who = me.role === 'teacher' ? '담당 교사' : `${me.sid} ${me.name}`;
  await runTransaction(db, async tx => {
    const snap = await tx.get(ref);
    const cur = snap.exists() ? snap.data() : null;
    const curRev = cur?.rev || 0;
    if (cur?.status === 'approved' && me.role !== 'teacher') throw new Error('선생님 확인이 끝난 기록은 수정할 수 없습니다.');
    if (curRev !== baseRev) throw new Error('다른 팀원(또는 선생님)이 먼저 이 기록을 수정했습니다. 내용을 복사해 두고 새로고침한 뒤 다시 저장하세요.');
    const now = new Date().toISOString();
    const next = {
      ...(cur || studentDefaults()),
      ...fields,
      rev: curRev + 1,
      updatedAt: now,
      updatedBy: who,
      history: [{ at: now, by: who, action: action === 'submit' ? '제출' : '저장' }, ...(cur?.history || [])].slice(0, 30),
    };
    if (action === 'submit') {
      next.status = 'submitted';
      next.submittedAt = now;
    } else {
      next.status = !cur || ['draft', 'empty'].includes(cur.status) ? 'draft' : cur.status;
    }
    tx.set(ref, next);
  });
}

// 교사가 기록 상태를 바꾼다. 아직 없는 기록이면 새로 만든다(작성 요청 등).
async function setLogStatus(teamId, no, status, feedback, assignee) {
  const ref = doc(db, 'teams', teamId, 'logs', String(no));
  await runTransaction(db, async tx => {
    const snap = await tx.get(ref);
    const cur = snap.exists() ? snap.data() : emptyLog();
    const hasContent = !!(cur.content || '').trim();
    const next = status === 'draft' && !hasContent ? 'empty' : status;
    const now = new Date().toISOString();
    const label = { approved: '확인 완료', revise: hasContent ? '보완 요청' : '작성 요청', submitted: '제출 처리', draft: '미제출로 변경', empty: '미제출로 변경' }[next];
    tx.set(ref, {
      ...cur,
      status: next,
      feedback,
      feedbackAt: now,
      assignee: assignee || '',
      rev: (cur.rev || 0) + 1,
      history: [{ at: now, by: '담당 교사', action: label }, ...(cur.history || [])].slice(0, 30),
    });
  });
}

// 계획서 저장: 팀 문서와 로그인 명단(roster)을 한 번에 쓴다.
async function saveTeam(oldTeam, draft) {
  const sids = new Set();
  for (const m of draft.members) {
    if (!/^[0-9A-Za-z-]{1,20}$/.test(m.sid)) throw new Error(`학번 '${m.sid}'이(가) 올바르지 않습니다.`);
    if (!m.name) throw new Error(`학번 ${m.sid}의 이름을 입력하세요.`);
    if (sids.has(m.sid)) throw new Error(`학번 ${m.sid}이(가) 중복되었습니다.`);
    sids.add(m.sid);
  }
  await Promise.all([...sids].map(async sid => {
    const r = await getDoc(doc(db, 'roster', sid));
    if (r.exists() && r.data().teamId !== oldTeam.id) throw new Error(`학번 ${sid}은(는) 이미 다른 팀에 있습니다.`);
  }));

  const batch = writeBatch(db);
  const { id, logs, ...rest } = draft;
  batch.set(doc(db, 'teams', oldTeam.id), {
    ...rest,
    members: draft.members.map(({ sid, name, role }) => ({ sid, name, role })),
    budget: draft.budget.filter(b => b.item),
  });
  for (const m of draft.members) {
    batch.set(doc(db, 'roster', m.sid), { name: m.name, teamId: oldTeam.id });
  }
  for (const old of oldTeam.members) {
    if (!sids.has(old.sid)) batch.delete(doc(db, 'roster', old.sid));
  }
  await batch.commit();
}

async function importSeed() {
  const batch = writeBatch(db);
  SEED_TEAMS.forEach((t, i) => {
    const { id, ...data } = t;
    batch.set(doc(db, 'teams', id), { ...data, order: i + 1 });
    for (const m of t.members) batch.set(doc(db, 'roster', m.sid), { name: m.name, teamId: id });
  });
  await batch.commit();
}

// ---------- 로그인 ----------

async function resolveMe(user) {
  if (!user) return null;
  if (user.isAnonymous) {
    try {
      const l = await getDoc(doc(db, 'links', user.uid));
      if (!l.exists()) return null;
      const { sid } = l.data();
      const r = await getDoc(doc(db, 'roster', sid));
      return { role: 'student', uid: user.uid, sid, name: r.data().name, teamId: r.data().teamId };
    } catch {
      return null; // 접속코드가 바뀌었거나 명단에서 빠진 경우
    }
  }
  try {
    await getDocs(query(collection(db, 'teams'), limit(1)));
    return { role: 'teacher', uid: user.uid, email: user.email };
  } catch (e) {
    console.error('교사 권한 확인 실패', e);
    return { role: 'unauthorized', email: user.email, code: e.code || e.message };
  }
}

async function studentLogin(sid, name) {
  state.linking = true;
  try {
    if (auth.currentUser && !auth.currentUser.isAnonymous) await signOut(auth);
    if (!auth.currentUser) await signInAnonymously(auth);
    const uid = auth.currentUser.uid;
    try {
      await setDoc(doc(db, 'links', uid), { sid, name, at: new Date().toISOString() });
    } catch (e) {
      if (e.code === 'permission-denied') throw new Error('학번과 이름이 선생님이 등록한 명단과 다릅니다. 명단에 어떻게 적혀 있는지 선생님께 확인하세요.');
      throw e;
    }
    const r = await getDoc(doc(db, 'roster', sid));
    state.me = { role: 'student', uid, sid, name: r.data().name, teamId: r.data().teamId };
  } finally {
    state.linking = false;
  }
}

async function logout() {
  try {
    Object.keys(localStorage).filter(k => k.startsWith('slat-report:')).forEach(k => localStorage.removeItem(k));
  } catch { /* 무시 */ }
  const user = auth.currentUser;
  if (user?.isAnonymous) {
    await deleteDoc(doc(db, 'links', user.uid)).catch(() => {});
    await deleteUser(user).catch(() => signOut(auth));
  } else {
    await signOut(auth);
  }
  state.me = null;
  location.hash = '#/login';
}

// ---------- 학생 화면 미리보기 (교사) ----------
// 교사 로그인은 그대로 둔 채 화면만 그 학생이 보는 대로 그린다. 미리보기 중에는 저장이 막힌다.

async function startPreview(teamId, sid) {
  const snap = await getDoc(doc(db, 'teams', teamId));
  const m = snap.exists() && snap.data().members.find(x => x.sid === sid);
  if (!m) throw new Error('팀원을 찾을 수 없습니다.');
  state.teacher = state.me;
  state.me = { role: 'student', uid: state.me.uid, sid, name: m.name, teamId, preview: true };
  location.replace(`#/team/${teamId}`);
}

function endPreview() {
  state.me = state.teacher;
  state.teacher = null;
  location.hash = '#/dashboard';
}

const PREVIEW_BLOCK = '미리보기 중에는 저장되지 않습니다. 실제로 고치려면 교사 화면으로 돌아가세요.';

// ---------- 레이아웃 ----------

function page(html, active) {
  const me = state.me;
  const links = me.role === 'teacher'
    ? [['dashboard', '#/dashboard', '대시보드'], ['attendance', '#/attendance', '출결'], ['reports', '#/reports', '최종 보고서'], ['budget', '#/budget', '예산'], ['pins', '#/pins', '접속 안내'], ['settings', '#/settings', '설정']]
    : [['team', `#/team/${me.teamId}`, '차시 기록'], ['report', `#/team/${me.teamId}/report`, '최종 보고서'], ['budget', `#/team/${me.teamId}/budget`, '예산'], ['info', `#/team/${me.teamId}/info`, '우리 팀 계획서']];
  $app.innerHTML = `
    <header class="topbar"><div class="wrap topbar-in">
      <a class="brand" href="#/">SLAT<span>학교주도활동 기록장</span></a>
      <nav>${links.map(([k, h, t]) => `<a href="${h}" class="${k === active ? 'active' : ''}">${t}</a>`).join('')}</nav>
      <div class="who">${me.role === 'teacher' ? '담당 교사' : esc(`${me.sid} ${me.name}`)}${USE_EMULATOR ? ' <span class="badge st-draft">에뮬레이터</span>' : ''}<button class="btn-ghost" id="logout">${me.preview ? '미리보기 끝내기' : '로그아웃'}</button></div>
    </div></header>
    ${me.preview ? `<div class="preview-bar no-print"><div class="wrap">👀 <b>${esc(me.name)}</b> 학생에게 보이는 화면입니다. 눌러 보고 써 볼 수 있지만 저장은 되지 않습니다.</div></div>` : ''}
    <main class="wrap">${html}</main>`;
  $('#logout').onclick = me.preview ? endPreview : logout;
}

// ---------- 라우터 ----------

async function route() {
  if (!state.ready) return;
  state.dirty = false;
  const me = state.me;
  if (!me) return renderLogin();
  if (me.role === 'unauthorized') return renderUnauthorized();

  const parts = (location.hash.slice(1) || '/').split('/').filter(Boolean);
  const home = me.role === 'teacher' ? '#/dashboard' : `#/team/${me.teamId}`;
  try {
    if (me.role === 'teacher') {
      if (parts[0] === 'preview' && parts[1] && parts[2]) return await startPreview(parts[1], parts[2]);
      if (parts[0] === 'dashboard') return await renderDashboard();
      if (parts[0] === 'pins') return await renderPins();
      if (parts[0] === 'attendance') return await renderAttendance(Number(parts[1]) || 0);
      if (parts[0] === 'budget') return await renderBudgetOverview();
      if (parts[0] === 'reports') return await renderReports(parts[1] === 'all');
      if (parts[0] === 'team' && parts[1] && parts[2] === 'report' && parts[3]) return await renderReport(parts[1], parts[3]);
      if (parts[0] === 'team' && parts[2] === 's' && parts[3] && parts[4] === 'edit') return await renderLog(parts[1], Number(parts[3]), true);
      if (parts[0] === 'settings') return renderSettings();
      if (parts[0] === 'team' && parts[1] && parts[2] === 'edit') return await renderEdit(parts[1]);
    }
    if (parts[0] === 'team' && parts[1]) {
      if (parts[2] === 's' && parts[3] && !parts[4]) return await renderLog(parts[1], Number(parts[3]));
      if (parts[2] === 'info') return await renderInfo(parts[1]);
      if (parts[2] === 'report' && me.role === 'student') return await renderReport(parts[1], me.sid);
      if (parts[2] === 'budget') return await renderTeamBudget(parts[1]);
      if (!parts[2]) return await renderTeam(parts[1]);
    }
    location.replace(home);
  } catch (e) {
    console.error(e);
    page(`<div class="card"><h2>문제가 생겼습니다</h2><p>${esc(friendlyError(e))}</p><a class="btn" href="${home}">처음으로</a></div>`);
  }
}
window.addEventListener('hashchange', route);

// ---------- 설정 안내 / 권한 없음 ----------

function renderSetupNeeded() {
  $app.innerHTML = `
    <div class="login-wrap"><div class="login-card" style="max-width:520px">
      <h1>⚙ Firebase 설정 필요</h1>
      <p class="muted">public/firebase-config.js 에 Firebase 웹 앱 설정값을 넣어야 사용할 수 있습니다. README의 [Firebase 설정] 순서를 따라 주세요.</p>
      <p class="small muted">로컬 테스트는 에뮬레이터 실행 후 <code>http://localhost:5000/?emulator</code> 로 접속하세요.</p>
    </div></div>`;
}

function renderUnauthorized() {
  const { email, code } = state.me;
  const denied = code === 'permission-denied';
  $app.innerHTML = `
    <div class="login-wrap"><div class="login-card">
      <h1>${denied ? '권한 없음' : '연결 오류'}</h1>
      <p class="muted">${denied
        ? `<b>${esc(email)}</b> 계정은 교사로 등록되어 있지 않습니다. Firebase 콘솔에 게시된 규칙의 교사 이메일 목록(<code>isTeacher</code>)에 이 이메일이 있는지 확인하세요.`
        : `교사 권한을 확인하는 중 오류가 났습니다. 잠시 후 다시 시도하세요.`}</p>
      <p class="small muted">로그인 계정: ${esc(email)} · 오류 코드: <code>${esc(code)}</code></p>
      <button class="btn-primary" id="out">다른 계정으로 로그인</button>
    </div></div>`;
  $('#out').onclick = logout;
}

// ---------- 로그인 화면 ----------

function renderLogin() {
  $app.innerHTML = `
    <div class="login-wrap"><div class="login-card">
      <h1>📒 SLAT 기록장</h1>
      <p class="muted">학교주도활동 주제 탐구 프로젝트 · 차시별 활동 기록</p>
      <div class="tabs">
        <button class="tab active" data-tab="student">학생</button>
        <button class="tab" data-tab="teacher">교사</button>
      </div>
      <form id="f-student">
        <div class="field"><label for="sid">학번</label><input type="text" id="sid" inputmode="numeric" autocomplete="off" required></div>
        <div class="field"><label for="sname">이름</label><input type="text" id="sname" autocomplete="off" required></div>
        <button class="btn-primary" type="submit">로그인</button>
      </form>
      <form id="f-teacher" hidden>
        <div class="field"><label for="temail">이메일</label><input type="text" id="temail" inputmode="email" autocomplete="username" required></div>
        <div class="field"><label for="tpw">비밀번호</label><input type="password" id="tpw" autocomplete="current-password" required></div>
        <button class="btn-primary" type="submit">로그인</button>
      </form>
      <p class="err" id="login-err"></p>
    </div></div>`;

  $$('.tab').forEach(tab => tab.onclick = () => {
    $$('.tab').forEach(t => t.classList.toggle('active', t === tab));
    $('#f-student').hidden = tab.dataset.tab !== 'student';
    $('#f-teacher').hidden = tab.dataset.tab !== 'teacher';
    $('#login-err').textContent = '';
  });

  const run = async (form, fn) => {
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    $('#login-err').textContent = '';
    try {
      await fn();
    } catch (e) {
      $('#login-err').textContent = friendlyError(e);
    } finally {
      btn.disabled = false;
    }
  };
  $('#f-student').onsubmit = e => {
    e.preventDefault();
    run(e.target, async () => {
      await studentLogin($('#sid').value.trim(), $('#sname').value.trim());
      location.hash = `#/team/${state.me.teamId}`;
      route();
    });
  };
  $('#f-teacher').onsubmit = e => {
    e.preventDefault();
    run(e.target, () => signInWithEmailAndPassword(auth, $('#temail').value.trim(), $('#tpw').value));
  };
  $('#sid').focus();
}

// ---------- 교사 대시보드 ----------

async function renderDashboard() {
  const teams = await fetchAllTeams();

  if (!teams.length) {
    page(`
      <div class="card" style="max-width:560px">
        <h1>시작하기</h1>
        <p>아직 팀이 없습니다. 제출된 계획서 3개(Unity, 2팀, 알루미늄 샌드위치)를 불러오거나 새 팀을 만드세요.</p>
        <p class="small muted">불러온 이름은 가운데 글자가 0으로 가려져 있습니다. 불러온 뒤 [계획서 편집]에서 실명으로 고쳐 주세요. 학생 접속코드는 자동으로 만들어집니다.</p>
        <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn-primary" id="seed">계획서 3개 불러오기</button><button class="btn" id="add-team">＋ 빈 팀 만들기</button></div>
        <p class="err" id="seed-err"></p>
      </div>`, 'dashboard');
    $('#seed').onclick = async () => {
      $('#seed').disabled = true;
      try { await importSeed(); toast('계획서를 불러왔습니다.'); route(); } catch (e) { $('#seed-err').textContent = friendlyError(e); $('#seed').disabled = false; }
    };
    $('#add-team').onclick = () => addTeam(0);
    return;
  }

  const today = todayStr();
  const maxNo = Math.max(...teams.map(t => t.sessions.length));
  const ref = teams.find(t => t.sessions.length === maxNo).sessions;
  const nowNo = (ref.find(s => s.date >= today) || ref[ref.length - 1] || {}).no;
  const st = (t, no) => t.logs[no]?.status || 'empty';

  let due = 0, done = 0, approved = 0, total = 0;
  const waiting = [], overdue = [];
  for (const t of teams) {
    for (const s of t.sessions) {
      const status = st(t, s.no);
      total++;
      if (status === 'approved') approved++;
      if (s.date <= today) {
        due++;
        if (DONE.includes(status)) done++;
        else if (s.date < today) overdue.push({ t, s, status });
      }
      if (status === 'submitted') waiting.push({ t, s });
    }
  }

  // 불러온 직후의 가려진 이름(김0현)은 학생 로그인과 맞지 않으므로 알려 준다.
  const masked = teams.flatMap(t => t.members.filter(m => m.name.includes('0')).map(m => ({ t, m })));

  const rows = teams.map(t => {
    const cells = [];
    for (let no = 1; no <= maxNo; no++) {
      const s = t.sessions.find(x => x.no === no);
      if (!s) { cells.push('<td class="cell muted">–</td>'); continue; }
      cells.push(`<td class="cell ${no === nowNo ? 'now' : ''}"><a href="#/team/${t.id}/s/${no}" title="${esc(s.plan)}">${badge(st(t, no), s.date)}${t.logs[no]?.feedback ? '<span class="dot-fb" title="피드백 있음"></span>' : ''}</a></td>`);
    }
    const submitted = t.sessions.filter(s => DONE.includes(st(t, s.no))).length;
    return `<tr>
      <td class="team-cell"><a href="#/team/${t.id}">${esc(t.name)}</a><div class="small muted">${esc(t.topic)}</div>
        <div class="small muted">${t.members.length}명 · 제출 ${submitted}/${t.sessions.length} · 예산 잔액 ${fmtWon(budgetOf(t).remaining)}</div></td>
      ${cells.join('')}</tr>`;
  }).join('');

  const queue = (items, render, emptyMsg) => items.length
    ? `<ul class="queue">${items.map(render).join('')}</ul>`
    : `<p class="muted small">${emptyMsg}</p>`;

  page(`
    <div class="page-head">
      <div><h1>대시보드</h1><p class="muted small">오늘 ${fmtDate(today)} · 총 ${maxNo}차시</p></div>
      <div class="actions">
        <button class="btn" id="csv">⬇ 전체 기록 CSV</button>
        <button class="btn" id="add-team">＋ 팀 추가</button>
      </div>
    </div>

    ${masked.length ? `<div class="feedback-box revise" style="margin-bottom:16px">
      <b>⚠ 이름이 가려진 팀원이 ${masked.length}명 있습니다 — 학생이 로그인할 수 없습니다</b>
      <div class="small" style="margin-top:4px">${masked.map(({ t, m }) => `${esc(t.name)} ${esc(m.sid)} <b>${esc(m.name)}</b>`).join(' · ')}</div>
      <div class="small" style="margin-top:6px">학생은 명단에 적힌 이름 그대로 입력해야 들어옵니다. 각 팀 <b>[계획서 편집]</b>에서 실명(과 실제 학번)으로 고쳐 주세요.</div>
    </div>` : ''}
    <div class="stats">
      <div class="stat"><div class="num">${teams.length}<small> 팀</small></div><div class="lbl">참여 학생 ${teams.reduce((n, t) => n + t.members.length, 0)}명</div></div>
      <div class="stat"><div class="num">${done}<small> / ${due}</small></div><div class="lbl">지금까지 도래한 차시 중 제출</div></div>
      <div class="stat ${waiting.length ? 'alert' : ''}"><div class="num">${waiting.length}</div><div class="lbl">확인 대기 중인 기록</div></div>
      <div class="stat ${overdue.length ? 'alert' : ''}"><div class="num">${overdue.length}</div><div class="lbl">기한 지난 미제출</div></div>
      <div class="stat"><div class="num">${approved}<small> / ${total}</small></div><div class="lbl">확인 완료</div></div>
    </div>

    <div class="section-title"><h2>팀별 차시 현황</h2>
      <div class="legend">
        <span class="badge st-empty">미작성</span><span class="badge st-draft">작성 중</span>
        <span class="badge st-submitted">제출됨</span><span class="badge st-revise">보완 요청</span>
        <span class="badge st-approved">확인 완료</span><span class="badge overdue">미제출</span>
        <span><span class="dot-fb"></span> 피드백 있음</span>
      </div>
    </div>
    <div class="table-scroll"><table class="matrix">
      <thead><tr><th>팀</th>${ref.map(s => `<th class="col ${s.no === nowNo ? 'now' : ''}">${s.no}차시<br><span class="small">${fmtDate(s.date)}</span></th>`).join('')}</tr></thead>
      <tbody>${rows}</tbody>
    </table></div>

    <div class="two-col" style="margin-top:24px">
      <div class="card"><h2 style="margin-bottom:8px">확인 대기 (${waiting.length})</h2>
        ${queue(waiting, ({ t, s }) => `<li><span><b>${esc(t.name)}</b> · ${s.no}차시 <span class="muted small">${fmtDate(s.date)}</span></span><a class="btn btn-sm" href="#/team/${t.id}/s/${s.no}">검토하기</a></li>`, '확인할 기록이 없습니다.')}
      </div>
      <div class="card"><h2 style="margin-bottom:8px">기한 지난 미제출 (${overdue.length})</h2>
        ${queue(overdue, ({ t, s, status }) => `<li><span><b>${esc(t.name)}</b> · ${s.no}차시 <span class="muted small">${fmtDate(s.date)} · ${STATUS[status].label}</span></span><a class="btn btn-sm" href="#/team/${t.id}/s/${s.no}">보기</a></li>`, '밀린 기록이 없습니다. 👍')}
      </div>
    </div>`, 'dashboard');

  $('#add-team').onclick = () => addTeam(teams.length);
  $('#csv').onclick = () => downloadCsv(teams);
}

async function addTeam(count) {
  const name = prompt('새 팀 이름을 입력하세요.');
  if (!name) return;
  const id = 't' + [...crypto.getRandomValues(new Uint8Array(4))].map(b => b.toString(16).padStart(2, '0')).join('');
  await setDoc(doc(db, 'teams', id), {
    name, topic: '', purpose: '', place: '', time: '월요일 7교시', leaderSid: '', caution: '',
    members: [], budget: [], sessions: makeSessions(), order: count + 1,
  });
  location.hash = `#/team/${id}/edit`;
}

function saveCsv(rows, filename) {
  const cell = v => {
    const s = String(v ?? '');
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const blob = new Blob(['\ufeff' + rows.map(r => r.map(cell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function downloadCsv(teams) {
  const header = ['팀명', '주제', '차시', '날짜', '계획', '상태', '교사 출결', '참여자', '활동 내용', '개인별 역할·기여', '결과·산출물', '어려운 점·해결', '다음 차시 계획', '참고자료·출처', '교사 피드백', '제출 일시', '최종 수정'];
  const rows = [header];
  for (const t of teams) {
    const nameOf = sid => t.members.find(m => m.sid === sid)?.name || sid;
    for (const s of t.sessions) {
      const l = t.logs[s.no] || emptyLog();
      rows.push([
        t.name, t.topic, s.no, s.date, s.plan, STATUS[l.status].label,
        Object.entries(t.attendance?.[s.no]?.marks || {}).map(([sid, m]) => `${nameOf(sid)}:${m}`).join(', '),
        l.attendance.map(nameOf).join(', '), l.content,
        Object.entries(l.contributions || {}).filter(([, v]) => v).map(([sid, v]) => `${nameOf(sid)}: ${v}`).join('\n'),
        l.results, l.issues, l.nextPlan, l.references, l.feedback,
        l.submittedAt ? new Date(l.submittedAt).toLocaleString('ko-KR') : '',
        l.updatedAt ? `${new Date(l.updatedAt).toLocaleString('ko-KR')} (${l.updatedBy})` : '',
      ]);
    }
  }
  saveCsv(rows, `SLAT_활동기록_${todayStr()}.csv`);
}

// ---------- 팀 홈 (차시 목록) ----------

async function renderTeam(teamId) {
  const { team, logs, attendance } = await fetchTeam(teamId);
  const me = state.me;
  const myReport = me.role === 'student' ? await fetchReport(teamId, me.sid).catch(() => null) : null;
  const today = todayStr();
  const nowNo = (team.sessions.find(s => s.date >= today) || {}).no;
  const count = st => team.sessions.filter(s => logs[s.no].status === st).length;
  const n = team.sessions.length || 1;
  const leader = team.members.find(m => m.sid === team.leaderSid);

  const nameOf = sid => team.members.find(m => m.sid === sid)?.name || sid;
  const extra = (no, l) => {
    const marks = attendance[no]?.marks || {};
    let att = '';
    if (me.role === 'teacher') {
      const counts = ATT_MARKS.map(k => [k, Object.values(marks).filter(v => v === k).length]).filter(([, c]) => c);
      if (counts.length) att = `출결 ${counts.map(([k, c]) => `${k} ${c}`).join(' · ')}`;
    } else if (marks[me.sid]) {
      att = `내 출결: ${marks[me.sid]}`;
    }
    const who = l.assignee ? `✍ 작성 담당: ${esc(nameOf(l.assignee))}${l.assignee === me.sid ? ' (나)' : ''}` : '';
    return att || who ? `<div class="meta">${[who, att].filter(Boolean).join(' · ')}</div>` : '';
  };

  const cards = team.sessions.map(s => {
    const l = logs[s.no];
    const action = me.role === 'teacher'
      ? (l.status === 'submitted' ? '검토하기' : '보기')
      : (l.status === 'approved' ? '보기' : l.status === 'empty' ? '작성하기' : '이어서 작성');
    return `
      <a class="session ${s.no === nowNo ? 'is-now' : ''}" href="#/team/${team.id}/s/${s.no}">
        <div class="no"><b>${s.no}</b><span>${fmtDate(s.date)}</span></div>
        <div>
          <div class="plan">${esc(s.plan) || '<span class="muted">(계획 미입력)</span>'}</div>
          <div class="meta">${l.updatedAt ? `마지막 수정 ${fmtDateTime(l.updatedAt)} · ${esc(l.updatedBy)}` : s.date > today ? '예정된 차시' : '아직 기록이 없습니다'}</div>
          ${extra(s.no, l)}
          ${l.feedback ? `<div class="fb-line">💬 선생님: ${esc(l.feedback.length > 60 ? l.feedback.slice(0, 60) + '…' : l.feedback)}</div>` : ''}
        </div>
        <div class="right">${badge(l.status, s.date)}<span class="btn btn-sm">${action}</span></div>
      </a>`;
  }).join('');

  page(`
    <div class="card team-hero">
      ${me.role === 'teacher' ? `<div class="crumb"><a href="#/dashboard">대시보드</a> › 팀</div>` : ''}
      <div class="page-head" style="margin-bottom:0">
        <div>
          <div class="muted small">${esc(team.name)} · ${esc(team.place)} · ${esc(team.time)}</div>
          <h1>${esc(team.topic || '(주제 미입력)')}</h1>
        </div>
        <div class="actions">
          <a class="btn" href="#/team/${team.id}/info">계획서 보기</a>
          <a class="btn" href="#/team/${team.id}/budget">예산</a>
          ${me.role === 'teacher' ? `<a class="btn" href="#/team/${team.id}/edit">계획서 편집</a>` : ''}
        </div>
      </div>
      <div class="chips">${team.members.map(m => `<span class="chip">${m.sid === team.leaderSid ? '👑 ' : ''}<b>${esc(m.name)}</b> ${esc(m.sid)}${m.role ? ` · ${esc(m.role)}` : ''}</span>`).join('')}</div>
      ${me.role === 'teacher' && team.members.length ? `<div class="small muted" style="margin-top:10px">👀 학생 화면 미리보기: ${team.members.map(m => `<a href="#/preview/${team.id}/${esc(m.sid)}">${esc(m.name)}</a>`).join(' · ')}</div>` : ''}
      <div class="progress-row">
        <div><div class="small muted">제출 ${team.sessions.filter(s => DONE.includes(logs[s.no].status)).length} / ${team.sessions.length}차시 · 확인 완료 ${count('approved')}</div>
          <div class="progress">
            <span style="width:${count('approved') / n * 100}%;background:var(--st-approved-fg)"></span>
            <span style="width:${count('submitted') / n * 100}%;background:var(--st-submitted-fg)"></span>
            <span style="width:${count('revise') / n * 100}%;background:var(--st-revise-fg)"></span>
            <span style="width:${count('draft') / n * 100}%;background:#e0b04a"></span>
          </div></div>
        ${leader ? `<div class="small muted">팀장 ${esc(leader.name)}</div>` : ''}
      </div>
    </div>
    ${team.caution ? `<div class="feedback-box" style="margin-top:16px">⚠ <b>활동 시 주의사항</b> — ${esc(team.caution)}</div>` : ''}
    ${myReport ? `<a class="session report-banner" href="#/team/${team.id}/report">
        <div class="no"><b>📝</b><span>개인</span></div>
        <div><div class="plan">최종 보고서 (개인별 작성)</div>
          <div class="meta">${myReport.status === 'revise' ? '선생님이 보완을 요청했습니다. 고친 뒤 다시 제출하세요.' : `탐구 이름·최종 목표와 질문 ${REPORT_QS.length}개에 각자 답을 써서 제출합니다.`}</div></div>
        <div class="right"><span class="badge ${STATUS[myReport.status].cls}">${STATUS[myReport.status].label}</span><span class="btn btn-sm">${myReport.status === 'approved' ? '보기' : myReport.status === 'empty' ? '작성하기' : '이어서 작성'}</span></div>
      </a>` : ''}
    <div class="section-title"><h2>차시별 활동 기록</h2><span class="muted small">매 차시가 끝나면 그날 한 활동을 기록하고 [제출]하세요.</span></div>
    <div class="session-list">${cards}</div>`, 'team');
}

// ---------- 차시 기록 (작성·검토) ----------

async function renderLog(teamId, no, editMode = false) {
  const { team, logs, attendance } = await fetchTeam(teamId);
  const s = team.sessions.find(x => x.no === no);
  if (!s) throw new Error('차시를 찾을 수 없습니다.');
  const log = logs[no];
  const me = state.me;
  const isTeacher = me.role === 'teacher';
  const editable = isTeacher ? editMode : log.status !== 'approved';
  const nameOf = sid => team.members.find(m => m.sid === sid)?.name || sid;
  const prev = team.sessions.find(x => x.no === no - 1);
  const next = team.sessions.find(x => x.no === no + 1);
  const base = `#/team/${team.id}/s/${no}`;

  const planBox = `
    <div class="card plan-box">
      <div class="muted small">${s.no}차시 · ${fmtDate(s.date)}</div>
      <h3 style="margin:4px 0 10px">계획서상 활동</h3>
      <p>${esc(s.plan) || '<span class="muted">(없음)</span>'}</p>
      ${s.experiment ? `<h3>실험 계획</h3><div class="exp">${esc(s.experiment)}</div>` : ''}
      <div style="display:flex;justify-content:space-between;margin-top:16px;gap:8px">
        ${prev ? `<a class="btn btn-sm" href="#/team/${team.id}/s/${prev.no}">‹ ${prev.no}차시</a>` : '<span></span>'}
        ${next ? `<a class="btn btn-sm" href="#/team/${team.id}/s/${next.no}">${next.no}차시 ›</a>` : ''}
      </div>
    </div>`;

  const requested = log.status === 'revise';
  const feedback = log.feedback || log.assignee
    ? `<div class="feedback-box ${requested ? 'revise' : ''}">
         <b>💬 ${requested ? (log.content ? '선생님 보완 요청 — 고친 뒤 다시 제출해 주세요' : '선생님 작성 요청 — 이 차시 기록을 작성해 제출해 주세요') : '선생님 피드백'}</b>
         ${log.assignee ? `<div class="assignee">✍ 작성 담당: ${esc(nameOf(log.assignee))}${log.assignee === me.sid ? ' (나)' : ''}</div>` : ''}
         ${log.feedback ? `<div style="white-space:pre-wrap;margin-top:4px">${esc(log.feedback)}</div>` : ''}
         <span class="who">${fmtDateTime(log.feedbackAt)}</span></div>`
    : '';

  const head = `
    <div class="crumb"><a href="${isTeacher ? '#/dashboard' : `#/team/${team.id}`}">${isTeacher ? '대시보드' : '차시 기록'}</a> › ${isTeacher ? `<a href="#/team/${team.id}">${esc(team.name)}</a> › ` : ''}${isTeacher && editMode ? `<a href="${base}">${s.no}차시</a> › 직접 작성` : `${s.no}차시`}</div>
    <div class="page-head"><div><h1>${s.no}차시 활동 기록 ${badge(log.status, s.date)}</h1>
      <p class="muted small">${esc(team.name)} · ${fmtDate(s.date)} ${esc(team.time)}${log.updatedAt ? ` · 마지막 수정 ${fmtDateTime(log.updatedAt)} (${esc(log.updatedBy)})` : ''}</p></div></div>`;

  let main;
  if (editable) {
    main = `
      <form class="card" id="log-form">
        ${feedback}
        ${isTeacher ? '<p class="small muted" style="margin-top:0">✏ 선생님이 작성하는 중입니다. 수정자는 ‘담당 교사’로 기록됩니다.</p>' : ''}
        <div class="field"><label for="content">오늘 한 활동 <span class="hint">무엇을, 어떻게 했는지 적어 주세요</span></label>
          <textarea id="content" rows="10">${esc(log.content)}</textarea></div>
        <div class="form-actions">
          ${isTeacher
            ? `<span class="grow">저장만 하면 상태는 그대로 유지됩니다.</span>
               <a class="btn" href="${base}">취소</a>
               <button type="button" id="save">저장</button>
               <button type="submit" class="btn-primary">저장하고 제출 처리</button>`
            : `<span class="grow">${log.status === 'submitted' ? '이미 제출한 기록입니다. 고친 뒤 다시 제출할 수 있습니다.' : '임시저장은 팀원끼리 함께 볼 수 있고, 제출해야 선생님께 전달됩니다.'}</span>
               <button type="button" id="save">임시저장</button>
               <button type="submit" class="btn-primary">${DONE.includes(log.status) ? '다시 제출' : '제출하기'}</button>`}
        </div>
        <p class="err" id="log-err"></p>
      </form>`;
  } else {
    const contribs = team.members.map(m => log.contributions[m.sid] ? `${m.name}: ${log.contributions[m.sid]}` : '').filter(Boolean).join('\n');
    const written = log.content || log.results || log.attendance.length;
    const marks = attendance[no]?.marks || {};
    const cur = ['empty', 'draft'].includes(log.status) ? 'draft' : log.status;
    const statusBtn = (st, label, cls = '') => `<button type="button" class="${cls} ${cur === st ? 'current' : ''}" data-status="${st}">${label}</button>`;
    main = `
      <div>
        <div class="card">
          ${isTeacher ? '' : feedback}
          ${!isTeacher && log.status === 'approved' ? '<p class="muted small">✅ 선생님 확인이 끝난 기록입니다. 수정이 필요하면 선생님께 말씀드리세요.</p>' : ''}
          ${written ? `
            ${block('오늘 한 활동', log.content)}
            ${log.attendance.length ? block('참여자', log.attendance.map(nameOf).join(', ')) : ''}
            ${contribs ? block('개인별 역할·기여', contribs) : ''}
            ${log.results ? block('결과·산출물', log.results) : ''}
            ${log.issues ? block('어려웠던 점과 해결 방법', log.issues) : ''}
            ${log.nextPlan ? block('다음 차시 계획', log.nextPlan) : ''}
            ${log.references ? block('참고자료·출처', log.references) : ''}` : '<p class="muted">아직 작성된 내용이 없습니다.</p>'}
          ${log.history?.length ? `<details><summary class="small muted">변경 이력 (${log.history.length})</summary><ul class="history">${log.history.map(h => `<li>${fmtDateTime(h.at)} · ${esc(h.by)} · ${esc(h.action)}</li>`).join('')}</ul></details>` : ''}
        </div>
        ${isTeacher ? `
          <div class="card review-panel">
            <h2>교사 관리</h2>
            <p class="small muted">현재 상태: <b>${STATUS[log.status].label}</b> · 출결: ${Object.keys(marks).length
              ? ATT_MARKS.map(k => [k, Object.values(marks).filter(v => v === k).length]).filter(([, c]) => c).map(([k, c]) => `${k} ${c}`).join(', ')
              : '미입력'} <a href="#/attendance/${no}">출결 입력</a></p>
            <div class="field"><label for="fb">피드백·요청 메시지 <span class="hint">학생 화면에 그대로 보입니다</span></label>
              <textarea id="fb" rows="3" placeholder="잘한 점, 보완할 점, 작성해 올 내용 등을 적어 주세요.">${esc(log.feedback)}</textarea></div>
            <div class="field"><label for="assignee">작성 담당 학생 <span class="hint">요청할 때 지정하면 그 학생 화면에 표시</span></label>
              <select id="assignee"><option value="">팀 전체</option>${team.members.map(m => `<option value="${esc(m.sid)}" ${log.assignee === m.sid ? 'selected' : ''}>${esc(m.name)} (${esc(m.sid)})</option>`).join('')}</select></div>
            <div class="small muted" style="margin-bottom:6px">상태 변경 — 누르면 위 메시지·담당도 함께 저장됩니다</div>
            <div class="btns">
              ${statusBtn('draft', '미제출')}
              ${statusBtn('submitted', '제출됨')}
              ${statusBtn('revise', '↩ 학생에게 작성·보완 요청')}
              ${statusBtn('approved', '✅ 확인 완료', 'btn-primary')}
            </div>
            <p class="small muted">미제출·요청 상태에서는 학생이 고칠 수 있고, 확인 완료하면 학생 수정이 잠깁니다.</p>
            <div class="btns"><a class="btn" href="${base}/edit">✏ 선생님이 직접 작성·수정</a></div>
            <p class="err" id="rv-err"></p>
          </div>` : ''}
      </div>`;
  }

  page(`${head}<div class="log-layout">${planBox}${main}</div>`, 'team');

  if (editable) {
    const form = $('#log-form');
    form.addEventListener('input', () => { state.dirty = true; });
    const collect = () => ({ content: $('#content').value.slice(0, 5000) });
    const save = async action => {
      $('#log-err').textContent = '';
      if (action === 'submit' && !$('#content').value.trim()) {
        $('#log-err').textContent = '‘오늘 한 활동’을 입력해야 제출할 수 있습니다.';
        $('#content').focus();
        return;
      }
      $$('#log-form button').forEach(b => { b.disabled = true; });
      try {
        await saveLog(team, no, action, collect(), log.rev);
        state.dirty = false;
        if (isTeacher) {
          toast(action === 'submit' ? '저장하고 제출 처리했습니다.' : '저장했습니다.');
          location.hash = base;
        } else {
          toast(action === 'submit' ? '제출했습니다. 선생님이 확인하면 여기에 표시돼요.' : '임시저장했습니다.');
          if (action === 'submit') location.hash = `#/team/${team.id}`;
          else route();
        }
      } catch (e) {
        $('#log-err').textContent = friendlyError(e);
        $$('#log-form button').forEach(b => { b.disabled = false; });
      }
    };
    $('#save').onclick = () => save('save');
    form.onsubmit = e => { e.preventDefault(); save('submit'); };
  }

  $$('[data-status]').forEach(btn => btn.onclick = async () => {
    const status = btn.dataset.status;
    const feedbackText = $('#fb').value.slice(0, 2000);
    if (status === 'revise' && !feedbackText.trim()) {
      $('#rv-err').textContent = '요청할 때는 무엇을 작성·보완할지 메시지를 적어 주세요.';
      $('#fb').focus();
      return;
    }
    $$('[data-status]').forEach(b => { b.disabled = true; });
    try {
      await setLogStatus(team.id, no, status, feedbackText, $('#assignee').value);
      toast({ approved: '확인 완료로 처리했습니다.', revise: '학생에게 요청했습니다.', submitted: '제출됨으로 바꿨습니다.', draft: '미제출로 바꿨습니다. 학생이 수정할 수 있습니다.' }[status]);
      const nextWaiting = status === 'approved' && team.sessions.find(x => x.no > no && logs[x.no].status === 'submitted');
      if (nextWaiting) location.hash = `#/team/${team.id}/s/${nextWaiting.no}`;
      else route();
    } catch (e) {
      $('#rv-err').textContent = friendlyError(e);
      $$('[data-status]').forEach(b => { b.disabled = false; });
    }
  });
}

// ---------- 최종 보고서 (개인별) ----------

// 질문 문항. k는 Firestore 필드 이름(firestore.rules의 reportKeys와 맞춰야 한다).
// example은 가상의 팀(주제: 환기 방법에 따른 교실 이산화탄소 농도 변화)이 쓴 작성 예시.
const REPORT_QS = [
  {
    k: 'motive',
    title: 'SLAT 활동에 참여하게 된 계기',
    guide: '‘친구가 하자고 해서’라고 쓰면 안 됩니다. 아래 네 가지 중 자기에게 맞는 것을 골라서 쓰세요.',
    frames: [
      '교과 연계: 통합과학 시간에 ~를 배웠는데 ~에서 흥미를 느껴서 탐구해 보고자 ~를 주제로 정했다.',
      '독서 연계: ~라는 책에서 ~에 대해 봤는데 흥미를 느껴서 탐구해 보고자 ~를 주제로 정했다.',
      '진로 연계: 관심 분야인 ~에서 ~ 기사를 봤는데 흥미를 느껴서 탐구해 보고자 ~를 주제로 정했다.',
      '실생활 연계: 평소 ~를 하다가 ~가 궁금했는데 탐구해 보고 싶어서 ~를 주제로 정했다.',
    ],
    example: '통합과학 시간에 세포 호흡을 하면 이산화탄소가 나온다는 것을 배웠다. 그때 선생님이 5교시에 교실이 답답하고 졸린 것도 이산화탄소 때문일 수 있다고 하셔서 흥미가 생겼다. 생각해 보니 우리 반은 겨울에 춥다고 창문을 거의 열지 않는데, 서른 명 가까운 사람이 한 교실에서 계속 숨을 쉬면 농도가 꽤 높아질 것 같았다. 집에 와서 찾아보니 실내 이산화탄소 농도에 권고 기준이 있다는 것도 알게 되었다. 그래서 우리 교실은 실제로 농도가 얼마나 되는지, 그리고 쉬는 시간 10분 동안 어떻게 환기해야 가장 빨리 낮아지는지 직접 재 보고 싶어서 ‘환기 방법에 따른 교실 이산화탄소 농도 변화’를 주제로 정했다.',
  },
  {
    k: 'activity',
    title: '어떠한 활동을 하였는가? 어떤 역할을 맡아서 어떠한 것을 탐구하였는가?',
    guide: '팀 전체가 한 일 말고 내가 한 일을 쓰세요. 무엇을 어떤 방법으로 몇 번 했는지 구체적으로 씁니다.',
    example: '나는 측정 장치를 만들고 데이터를 기록하는 역할을 맡았다. 먼저 아두이노에 이산화탄소 센서를 연결하고, 1분마다 농도를 재서 SD 카드에 저장하는 코드를 짰다. 처음에는 값이 화면에만 나오고 저장이 안 돼서 예제 코드를 찾아보면서 세 번 정도 고쳤다. 장치가 완성된 뒤에는 창문만 열었을 때, 앞뒤 문만 열었을 때, 창문과 문을 다 열었을 때로 조건을 나누고, 쉬는 시간 10분 동안 농도가 어떻게 변하는지 조건마다 3일씩 모두 9일 동안 쟀다. 비교하려고 아무것도 열지 않은 날도 하루 쟀다. 잰 값은 엑셀에 옮겨서 조건별로 평균을 내고 꺾은선 그래프로 그렸다. 보고서에서는 탐구 방법과 결과 부분을 내가 썼다.',
  },
  {
    k: 'sources',
    title: '탐구하면서 어떤 자료를 찾아보았는가? 그 자료를 어디에 활용하였는가?',
    guide: '책, 교과서, 기사, 영상, 설명서 등 실제로 본 자료의 이름을 쓰세요. ‘인터넷 검색’이라고만 쓰면 안 됩니다.',
    example: '먼저 통합과학 교과서의 세포 호흡 부분을 다시 읽고 사람이 많으면 이산화탄소가 왜 늘어나는지 정리해서 보고서의 탐구 배경에 썼다. 센서를 처음 써 봐서 제조사 설명서를 찾아 읽었는데, 전원을 켜고 바로 잰 값은 정확하지 않다고 되어 있어서 켜고 몇 분 지난 뒤부터 재는 것으로 방법을 바꿨다. 아두이노로 SD 카드에 저장하는 방법은 유튜브 강의 영상을 보고 따라 하면서 배웠다. 환경부 자료에서 실내 이산화탄소 권고 기준을 찾아서 우리 교실 값이 높은 편인지 판단하는 기준으로 썼다. 또 교실 환기에 대한 신문 기사를 읽었는데, 바람이 통하게 양쪽을 열어야 한다는 내용이 있어서 ‘창문과 문을 다 여는 조건’을 추가하게 되었다.',
  },
  {
    k: 'difficulty',
    title: 'SLAT를 진행하는 중 어려움은 없었는가? 있었다면 그것을 해결하기 위해 어떤 것을 해 봤는가?',
    guide: '‘어려웠지만 열심히 했다’라고 쓰면 안 됩니다. 어떤 문제가 있었는지, 왜 그랬는지, 그래서 무엇을 바꿨는지, 바꾼 뒤에 어떻게 됐는지를 쓰세요.',
    example: '가장 어려웠던 것은 같은 조건으로 쟀는데도 날마다 값이 많이 달라서 비교를 할 수 없었던 것이다. 처음에는 센서가 고장 난 줄 알고 다시 연결해 봤는데 똑같았다. 팀원들과 측정한 날의 상황을 하나씩 적어 보니, 쉬는 시간에 교실에 남아 있는 사람 수가 매번 달랐고 센서를 놓는 자리도 그때그때 달랐다. 그래서 센서를 교실 가운데 책상 위에 고정하고, 잴 때마다 교실에 남은 사람 수를 같이 적기로 했다. 사람 수가 너무 다른 날의 값은 빼고 다시 쟀다. 그렇게 한 뒤로는 같은 조건에서 값 차이가 줄어서 비교할 수 있었다. 또 체육 수업 때문에 교실이 비는 날이 있어서 계획보다 측정이 늦어졌는데, 점심시간에 한 번 더 재는 것으로 일정을 맞췄다.',
  },
  {
    k: 'teamwork',
    title: '팀원들과 화합을 이루어 프로젝트를 진행하기 위해서 노력한 것이 있는가?',
    guide: '‘사이좋게 지냈다’ 말고 실제로 한 행동을 쓰세요. 역할을 어떻게 나눴는지, 의견이 다를 때 어떻게 정했는지, 팀원을 어떻게 도왔는지 등.',
    example: '쉬는 시간마다 재야 해서 한 사람만 계속 하게 되면 불만이 생길 것 같았다. 그래서 요일별로 당번을 정하자고 내가 먼저 말했고, 당번표를 만들어 단체 대화방에 올렸다. 어떤 조건으로 잴지 의견이 달랐을 때는 말로만 하면 결론이 안 나서, 각자 생각한 방법으로 하루씩 재 보고 결과를 보고 정했다. 코딩을 어려워하는 팀원이 있어서 내가 짠 코드에 한 줄씩 설명을 적어 주었고, 나중에는 그 팀원도 혼자 장치를 켜고 값을 저장할 수 있게 되었다. 반대로 나는 그래프를 보기 좋게 만드는 것을 잘 못해서 그 부분은 다른 팀원에게 배웠다. 매 차시가 끝나면 5분 정도 모여서 다음 시간에 누가 무엇을 할지 정하고 헤어졌다.',
  },
  {
    k: 'insight',
    title: '탐구 결과 무엇을 알게 되었는가? 최종적으로 활동 결과물을 통해서 무엇을 느꼈는가?',
    guide: '알게 된 내용을 먼저 쓰세요(측정한 값이나 관찰한 것을 근거로). 느낀 점은 그 다음에 씁니다. ‘재미있었다’로 끝내면 안 됩니다.',
    example: '아무것도 열지 않으면 쉬는 시간에도 농도가 거의 내려가지 않았고, 창문만 열면 천천히 내려갔다. 창문과 문을 같이 열면 창문만 열 때보다 훨씬 빨리 내려간다는 것을 그래프로 확인했다. 바람이 들어오는 곳과 나가는 곳이 둘 다 있어야 공기가 잘 바뀐다는 것을 알게 되었다. 환기하면 좋다는 건 원래 알았지만 직접 잰 숫자로 보니까 확실히 믿게 되었고, 반 친구들에게 쉬는 시간에 문도 같이 열자고 설명할 수 있었다. 그리고 조건을 똑같이 맞추지 않으면 결과를 비교할 수 없다는 것을 실험하면서 알게 되었다. 교과서에서 변인 통제를 배울 때는 당연한 말 같았는데 직접 해 보니 제일 어려운 부분이었다. 다만 9일밖에 재지 못해서 날씨나 바람의 영향은 확인하지 못한 것이 아쉽다.',
  },
  {
    k: 'poster',
    title: '활동 결과물에 대해서 발표나 전시를 할 계획이 있는가?',
    guide: 'B4 1장짜리 포스터를 만듭니다. 포스터에 무엇을 넣을지, 내가 맡을 부분은 무엇인지 쓰세요.',
    example: 'B4 1장 포스터로 만들어서 복도 게시판에 붙일 계획이다. 제목은 ‘쉬는 시간, 문도 같이 열어야 하는 이유’로 정했다. 왼쪽에는 탐구하게 된 계기와 측정 방법을 장치 사진과 함께 넣고, 가운데에는 조건별 농도 변화 그래프를 가장 크게 넣는다. 오른쪽에는 결론과 우리가 제안하는 환기 방법을 넣는다. 글이 많으면 아무도 안 읽을 것 같아서 그래프와 사진 위주로 만들기로 했다. 나는 그래프를 맡고 다른 팀원이 디자인과 글을 맡아서 마지막 차시까지 완성하기로 했다. 포스터를 붙인 뒤에는 우리 반에서 3분 정도 발표도 할 예정이다.',
  },
  {
    k: 'future',
    title: '이번 활동을 통해서 앞으로(2학년, 3학년 중) 추가적으로 탐구해 보고 싶은 것이 있는가?',
    guide: '이번에 해결하지 못한 것이나 활동하다가 새로 궁금해진 것을 쓰세요.',
    example: '이번에는 이산화탄소만 쟀는데, 창문을 열면 바깥 미세먼지가 들어오지 않을까 하는 궁금증이 생겼다. 2학년 때는 미세먼지 센서를 추가해서 이산화탄소와 미세먼지를 같이 재고, 미세먼지가 많은 날에는 언제 얼마나 환기하는 것이 좋은지 탐구해 보고 싶다. 이번에 날씨와 바람의 영향을 확인하지 못했기 때문에 측정 기간도 한 달 정도로 늘리고 싶다. 또 농도가 기준보다 높아지면 소리나 불빛으로 알려 주는 장치를 만들어서 교실에 두고, 실제로 환기 횟수가 늘어나는지도 확인해 보고 싶다. 그러려면 정보 시간에 배우는 프로그래밍을 더 공부해야 할 것 같다.',
  },
];
// 번호 붙은 질문보다 먼저 쓰는 팀 공통 항목. 팀원끼리 똑같이 써야 한다(교사 화면에서 다르면 표시).
const REPORT_COMMON = [
  {
    k: 'title',
    title: '이번 SLAT 탐구의 이름',
    guide: '우리 팀이 한 탐구에 이름을 붙이세요. 팀원끼리 상의해서 정하고, 팀원 모두 똑같이 써야 합니다.',
    example: '환기 방법에 따른 교실 이산화탄소 농도 변화 탐구',
    short: true,
  },
  {
    k: 'goal',
    title: '이 프로젝트의 최종 목표',
    guide: '이 프로젝트에서 최종적으로 무엇을 알아내거나 만들려고 했는지 쓰세요. 이것도 팀원 모두 똑같이 써야 합니다.',
    example: '환기 방법에 따라 교실의 이산화탄소 농도가 낮아지는 속도가 어떻게 다른지 직접 측정하고, 쉬는 시간 10분 안에 농도를 가장 빨리 낮출 수 있는 환기 방법을 찾아서 우리 반에 제안한다.',
  },
];
// 저장·검사·내보내기에 쓰는 전체 항목. label은 화면과 CSV에 보이는 제목.
const REPORT_FIELDS = [
  ...REPORT_COMMON.map(q => ({ ...q, common: true, label: q.title })),
  ...REPORT_QS.map((q, i) => ({ ...q, label: `${i + 1}. ${q.title}` })),
];
const REPORT_MAX = 3000;

const emptyReport = () => ({
  status: 'empty', feedback: '',
  ...Object.fromEntries(REPORT_FIELDS.map(q => [q.k, ''])),
});

async function fetchReport(teamId, sid) {
  const snap = await getDoc(doc(db, 'teams', teamId, 'reports', sid));
  return { ...emptyReport(), ...(snap.exists() ? snap.data() : {}) };
}

// 팀의 모든 보고서. 새 보안 규칙이 아직 배포되지 않았으면 null.
async function fetchReports(teamId) {
  try {
    const out = {};
    (await getDocs(collection(db, 'teams', teamId, 'reports'))).forEach(d => { out[d.id] = { ...emptyReport(), ...d.data() }; });
    return out;
  } catch (e) {
    if (e.code === 'permission-denied') return null;
    throw e;
  }
}

const RULES_NOTICE = '최종 보고서 기능은 새 보안 규칙이 배포되어야 쓸 수 있습니다.';

function reportSheet(team, m, r) {
  return `
    <div class="card report-sheet">
      <div class="report-head">
        <div><div class="muted small">${esc(team.name)} · ${esc(team.topic)}</div>
          <h2>${esc(m.name)} <span class="muted small">${esc(m.sid)}${m.role ? ` · ${esc(m.role)}` : ''}</span></h2></div>
        <div class="small muted">${r.submittedAt ? `제출 ${fmtDateTime(r.submittedAt)}` : ''} <span class="badge ${STATUS[r.status].cls}">${STATUS[r.status].label}</span></div>
      </div>
      ${REPORT_FIELDS.map(q => block(q.label, r[q.k])).join('')}
    </div>`;
}

async function renderReport(teamId, sid) {
  const { team, logs } = await fetchTeam(teamId);
  const me = state.me;
  const isTeacher = me.role === 'teacher';
  const m = team.members.find(x => x.sid === sid);
  if (!m) throw new Error('팀원을 찾을 수 없습니다.');
  let r;
  try {
    r = await fetchReport(teamId, sid);
  } catch (e) {
    if (e.code !== 'permission-denied') throw e;
    return page(`<div class="card"><h2>아직 준비 중입니다</h2><p>${RULES_NOTICE}${isTeacher ? ' README의 [보안 규칙 배포]를 참고해 <code>firestore.rules</code>를 배포해 주세요.' : ' 선생님께 알려 주세요.'}</p></div>`, isTeacher ? 'reports' : 'report');
  }
  const ref = doc(db, 'teams', teamId, 'reports', sid);
  const requested = r.status === 'revise';
  const feedback = r.feedback
    ? `<div class="feedback-box ${requested ? 'revise' : ''}"><b>💬 ${requested ? '선생님 보완 요청 — 고친 뒤 다시 제출해 주세요' : '선생님 피드백'}</b>
         <div style="white-space:pre-wrap;margin-top:4px">${esc(r.feedback)}</div><span class="who">${fmtDateTime(r.feedbackAt)}</span></div>`
    : '';

  if (isTeacher) {
    page(`
      <div class="crumb no-print"><a href="#/reports">최종 보고서</a> › ${esc(team.name)} › ${esc(m.name)}</div>
      <div class="page-head no-print"><h1>최종 보고서</h1>
        <div class="actions"><button class="btn" onclick="window.print()">🖨 인쇄</button></div></div>
      ${reportSheet(team, m, r)}
      <div class="card review-panel no-print">
        <h2>교사 확인</h2>
        <div class="field" style="margin-top:12px"><label for="fb">피드백·보완 요청 메시지 <span class="hint">학생 화면에 그대로 보입니다</span></label>
          <textarea id="fb" rows="3" placeholder="예: 3번에서 어떤 방법으로 해결했는지 더 구체적으로 써 주세요.">${esc(r.feedback)}</textarea></div>
        <div class="btns">
          ${[['draft', '미제출'], ['submitted', '제출됨'], ['revise', '↩ 보완 요청'], ['approved', '✅ 확인 완료']].map(([st, label]) =>
            `<button type="button" class="${st === 'approved' ? 'btn-primary' : ''} ${(r.status === 'empty' ? 'draft' : r.status) === st ? 'current' : ''}" data-rstatus="${st}">${label}</button>`).join('')}
        </div>
        <p class="small muted">확인 완료하면 학생이 더 고칠 수 없습니다. 보완 요청·미제출 상태에서는 학생이 고쳐 다시 제출할 수 있습니다.</p>
        <p class="err" id="rv-err"></p>
      </div>`, 'reports');
    $$('[data-rstatus]').forEach(btn => btn.onclick = async () => {
      const status = btn.dataset.rstatus;
      const text = $('#fb').value.slice(0, 2000);
      if (status === 'revise' && !text.trim()) {
        $('#rv-err').textContent = '보완 요청할 때는 무엇을 고칠지 메시지를 적어 주세요.';
        $('#fb').focus();
        return;
      }
      $$('[data-rstatus]').forEach(b => { b.disabled = true; });
      try {
        await setDoc(ref, { status, feedback: text, feedbackAt: new Date().toISOString() }, { merge: true });
        toast('저장했습니다.');
        route();
      } catch (e) {
        $('#rv-err').textContent = friendlyError(e);
        $$('[data-rstatus]').forEach(b => { b.disabled = false; });
      }
    });
    return;
  }

  if (r.status === 'approved') {
    return page(`
      <div class="page-head"><div><h1>최종 보고서</h1><p class="muted small">✅ 선생님 확인이 끝났습니다. 수정이 필요하면 선생님께 말씀드리세요.</p></div></div>
      ${feedback}${reportSheet(team, m, r)}`, 'report');
  }

  // 휴대폰에서 쓰다가 탭이 닫혀도 잃지 않도록 입력 중인 내용을 이 기기에 보관한다.
  // 서버 기록이 그 사이에 바뀌었으면(다른 기기에서 저장) 보관분은 버린다.
  const draftKey = `slat-report:${teamId}:${sid}`;
  const base = r.updatedAt || '';
  let restored = false;
  try {
    const loc = me.preview ? null : JSON.parse(localStorage.getItem(draftKey) || 'null');
    if (loc && loc.base === base) {
      for (const q of REPORT_FIELDS) {
        if (typeof loc[q.k] === 'string' && loc[q.k] !== r[q.k]) { r[q.k] = loc[q.k]; restored = true; }
      }
    } else if (loc) localStorage.removeItem(draftKey);
  } catch { /* 저장소를 못 쓰는 브라우저에서는 보관 없이 진행 */ }

  const written = team.sessions.filter(s => (logs[s.no].content || '').trim());
  page(`
    <div class="page-head"><div><h1>최종 보고서 <span class="badge ${STATUS[r.status].cls}">${STATUS[r.status].label}</span></h1>
      <p class="muted small">${esc(m.name)} · ${esc(team.name)} · 팀별이 아니라 <b>각자</b> 씁니다. 다른 팀원은 볼 수 없습니다.</p></div></div>
    ${feedback}
    <div class="card report-tips">
      <b>쓰기 전에 읽어 보세요</b>
      <ul>
        <li>무엇을, 어떻게, 몇 번 했는지 <b>구체적으로</b> 씁니다.</li>
        <li>팀이 한 일이 아니라 <b>내가 한 일</b>을 씁니다.</li>
        <li><b>탐구 이름</b>과 <b>최종 목표</b>는 팀원끼리 상의해서 모두 똑같이 씁니다. 나머지는 각자 씁니다.</li>
        <li>질문 아래 [작성 예시]는 다른 주제로 쓴 것입니다. 베끼지 말고 참고만 하세요.</li>
      </ul>
      ${restored ? '<p class="restored">저장하지 않고 닫았던 내용을 불러왔습니다. [임시저장]을 눌러야 저장됩니다.</p>' : ''}
      ${written.length ? `<details><summary>우리 팀 차시 기록 다시 보기 (${written.length}개)</summary>
        ${written.map(s => `<div class="readonly-block" style="margin:10px 0 0"><h3>${s.no}차시 · ${fmtDate(s.date)} · ${esc(s.plan)}</h3><div>${esc(logs[s.no].content)}</div></div>`).join('')}</details>` : ''}
    </div>
    <form class="card" id="report-form">
      ${REPORT_FIELDS.map(q => `
        <div class="field report-q ${q.common ? 'report-common' : ''}">
          <label for="r-${q.k}">${esc(q.label)}${q.common ? ' <span class="badge st-submitted">팀원 동일</span>' : ''}</label>
          <p class="guide">${esc(q.guide)}</p>
          ${q.frames ? `<ul class="frames">${q.frames.map(f => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}
          ${q.short
            ? `<input type="text" id="r-${q.k}" maxlength="100" value="${esc(r[q.k])}">`
            : `<textarea id="r-${q.k}" rows="${q.common ? 3 : 6}" maxlength="${REPORT_MAX}">${esc(r[q.k])}</textarea>`}
          <div class="report-under"><details><summary>작성 예시 보기</summary><div class="example">${esc(q.example)}</div></details><span class="count" data-count="${q.k}"></span></div>
        </div>`).join('')}
      <div class="form-actions">
        <span class="grow">${r.status === 'submitted' ? '이미 제출했습니다. 고친 뒤 다시 제출할 수 있습니다.' : '임시저장해 두고 나중에 이어 쓸 수 있습니다. 제출해야 선생님께 전달됩니다.'}</span>
        <button type="button" id="r-save">임시저장</button>
        <button type="submit" class="btn-primary">${DONE.includes(r.status) ? '다시 제출' : '제출하기'}</button>
      </div>
      <p class="err" id="r-err"></p>
    </form>`, 'report');

  const form = $('#report-form');
  const count = () => REPORT_FIELDS.forEach(q => { $(`[data-count="${q.k}"]`).textContent = `${$(`#r-${q.k}`).value.trim().length}자`; });
  count();
  const read = () => Object.fromEntries(REPORT_FIELDS.map(q => [q.k, $(`#r-${q.k}`).value.slice(0, REPORT_MAX)]));
  if (restored) state.dirty = true;
  form.addEventListener('input', () => {
    state.dirty = true;
    count();
    if (me.preview) return;
    try { localStorage.setItem(draftKey, JSON.stringify({ base, ...read() })); } catch { /* 무시 */ }
  });
  const save = async submit => {
    $('#r-err').textContent = '';
    const fields = read();
    if (submit) {
      const miss = REPORT_FIELDS.find(q => !fields[q.k].trim());
      if (miss) {
        $('#r-err').textContent = `‘${miss.common ? miss.title : `${miss.label.split('.')[0]}번 질문`}’을(를) 써야 제출할 수 있습니다. (지금까지 쓴 내용은 [임시저장]으로 보관하세요.)`;
        $(`#r-${miss.k}`).focus();
        return;
      }
    }
    if (me.preview) { $('#r-err').textContent = PREVIEW_BLOCK; return; }
    $$('#report-form button').forEach(b => { b.disabled = true; });
    try {
      const now = new Date().toISOString();
      await setDoc(ref, {
        ...fields,
        status: submit ? 'submitted' : ['empty', 'draft'].includes(r.status) ? 'draft' : r.status,
        updatedAt: now,
        ...(submit ? { submittedAt: now } : {}),
      }, { merge: true });
      state.dirty = false;
      try { localStorage.removeItem(draftKey); } catch { /* 무시 */ }
      toast(submit ? '제출했습니다.' : '임시저장했습니다.');
      if (submit) location.hash = `#/team/${team.id}`;
      else route();
    } catch (e) {
      $('#r-err').textContent = e.code === 'permission-denied' ? `저장하지 못했습니다. ${RULES_NOTICE} 내용을 복사해 두고 선생님께 알려 주세요.` : friendlyError(e);
      $$('#report-form button').forEach(b => { b.disabled = false; });
    }
  };
  $('#r-save').onclick = () => save(false);
  form.onsubmit = e => { e.preventDefault(); save(true); };
}

// 교사: 전체 현황 / 모아 보기(인쇄용)
async function renderReports(showAll) {
  const teams = (await getDocs(collection(db, 'teams'))).docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
  let blocked = false;
  await Promise.all(teams.map(async t => {
    t.reports = await fetchReports(t.id);
    if (!t.reports) { blocked = true; t.reports = {}; }
  }));
  if (blocked) {
    return page(`<div class="card"><h2>보안 규칙 배포 필요</h2><p>${RULES_NOTICE} 저장소의 <code>firestore.rules</code>를 배포하거나(<code>npx firebase-tools deploy --only firestore:rules</code>), 파일 내용을 Firebase 콘솔 <b>Firestore → 규칙</b>에 붙여 넣고 [게시]해 주세요.</p></div>`, 'reports');
  }
  const all = teams.flatMap(t => t.members.map(m => ({ t, m, r: t.reports[m.sid] || emptyReport() })));
  const n = st => all.filter(x => x.r.status === st).length;
  const len = r => REPORT_FIELDS.reduce((s, q) => s + (r[q.k] || '').trim().length, 0);

  // 탐구 이름·최종 목표는 팀원끼리 같아야 한다. 쓴 내용을 모아 보여 주고 서로 다르면 알린다.
  const commonBox = t => {
    const rows = REPORT_COMMON.map(q => {
      const groups = new Map();
      for (const m of t.members) {
        const v = (t.reports[m.sid]?.[q.k] || '').trim().replace(/\s+/g, ' ');
        if (v) groups.set(v, [...(groups.get(v) || []), m.name]);
      }
      return { q, groups: [...groups] };
    }).filter(x => x.groups.length);
    if (!rows.length) return '';
    const differ = rows.some(x => x.groups.length > 1);
    return `<div class="feedback-box ${differ ? 'revise' : ''}" style="margin-bottom:10px">
      ${differ ? '<b>⚠ 팀원끼리 다르게 쓴 항목이 있습니다</b>' : ''}
      ${rows.map(({ q, groups }) => `<div class="small" style="margin-top:4px"><b>${esc(q.title)}</b>${groups.length > 1
        ? `<ul style="margin:2px 0 0;padding-left:18px">${groups.map(([v, names]) => `<li>${esc(v)} <span class="muted">(${esc(names.join(', '))})</span></li>`).join('')}</ul>`
        : `: ${esc(groups[0][0])}`}</div>`).join('')}
    </div>`;
  };

  if (showAll) {
    const shown = all.filter(x => x.r.status !== 'empty');
    page(`
      <div class="crumb no-print"><a href="#/reports">최종 보고서</a> › 모아 보기</div>
      <div class="page-head no-print"><div><h1>최종 보고서 모아 보기</h1><p class="muted small">작성된 보고서 ${shown.length}건 · 인쇄하면 학생마다 새 쪽에서 시작합니다.</p></div>
        <div class="actions"><button class="btn-primary" onclick="window.print()">🖨 인쇄 / PDF 저장</button></div></div>
      ${shown.map(x => reportSheet(x.t, x.m, x.r)).join('') || '<div class="card muted">아직 작성된 보고서가 없습니다.</div>'}`, 'reports');
    return;
  }

  page(`
    <div class="page-head">
      <div><h1>최종 보고서</h1><p class="muted small">학생이 개인별로 작성합니다. 이름을 누르면 내용을 보고 확인·보완 요청할 수 있습니다.</p></div>
      <div class="actions"><a class="btn" href="#/reports/all">모아 보기 · 인쇄</a><button class="btn" id="r-csv">⬇ 보고서 CSV</button></div>
    </div>
    <div class="stats">
      <div class="stat"><div class="num">${n('submitted') + n('approved') + n('revise')}<small> / ${all.length}</small></div><div class="lbl">제출한 학생</div></div>
      <div class="stat ${n('submitted') ? 'alert' : ''}"><div class="num">${n('submitted')}</div><div class="lbl">확인 대기</div></div>
      <div class="stat"><div class="num">${n('draft')}</div><div class="lbl">작성 중</div></div>
      <div class="stat ${n('empty') ? 'alert' : ''}"><div class="num">${n('empty')}</div><div class="lbl">미작성</div></div>
      <div class="stat"><div class="num">${n('approved')}</div><div class="lbl">확인 완료</div></div>
    </div>
    ${teams.map(t => `
      <div class="section-title"><h2>${esc(t.name)}</h2><span class="muted small">${esc(t.topic)}</span></div>
      ${commonBox(t)}
      <div class="table-scroll"><table>
        <thead><tr><th>학생</th><th>상태</th><th class="num">분량</th><th>제출</th><th>피드백</th><th></th></tr></thead>
        <tbody>${t.members.map(m => {
          const r = t.reports[m.sid] || emptyReport();
          return `<tr>
            <td><a href="#/team/${t.id}/report/${esc(m.sid)}"><b>${esc(m.name)}</b></a> <span class="small muted">${esc(m.sid)}</span></td>
            <td><span class="badge ${STATUS[r.status].cls}">${STATUS[r.status].label}</span></td>
            <td class="num">${len(r) ? `${len(r).toLocaleString('ko-KR')}자 · ${REPORT_FIELDS.filter(q => (r[q.k] || '').trim()).length}/${REPORT_FIELDS.length}항목` : ''}</td>
            <td class="small">${fmtDateTime(r.submittedAt)}</td>
            <td class="small">${esc((r.feedback || '').slice(0, 40))}${(r.feedback || '').length > 40 ? '…' : ''}</td>
            <td><a class="btn btn-sm" href="#/team/${t.id}/report/${esc(m.sid)}">${r.status === 'submitted' ? '검토하기' : '보기'}</a></td>
          </tr>`;
        }).join('') || '<tr><td class="muted">팀원이 없습니다.</td></tr>'}</tbody>
      </table></div>`).join('')}`, 'reports');

  $('#r-csv').onclick = () => saveCsv([
    ['팀명', '주제', '학번', '이름', '상태', ...REPORT_FIELDS.map(q => q.label), '교사 피드백', '제출 일시'],
    ...all.map(({ t, m, r }) => [t.name, t.topic, m.sid, m.name, STATUS[r.status].label, ...REPORT_FIELDS.map(q => r[q.k]), r.feedback,
      r.submittedAt ? new Date(r.submittedAt).toLocaleString('ko-KR') : '']),
  ], `SLAT_최종보고서_${todayStr()}.csv`);
}

// ---------- 출결 (교사) ----------

const MARK_CLS = { 출석: 'm-ok', 지각: 'm-late', 조퇴: 'm-late', 결석: 'm-absent', 공결: 'm-excused' };
const MARK_ABBR = { 출석: '○', 지각: '지', 조퇴: '조', 결석: '×', 공결: '공' };

async function renderAttendance(selNo) {
  const teams = await fetchAllTeams();
  if (!teams.length) return page('<div class="card">팀이 없습니다. 대시보드에서 먼저 팀을 만드세요.</div>', 'attendance');
  const today = todayStr();
  const maxNo = Math.max(...teams.map(t => t.sessions.length));
  const ref = teams.find(t => t.sessions.length === maxNo).sessions;
  const no = ref.some(s => s.no === selNo) ? selNo : ([...ref].reverse().find(s => s.date <= today) || ref[0]).no;

  const teamCard = t => {
    const s = t.sessions.find(x => x.no === no);
    if (!s) return '';
    const a = t.attendance[no] || { marks: {}, notes: {} };
    const participants = t.logs[no]?.attendance || [];
    return `
      <div class="card att-card" data-team="${t.id}">
        <div class="section-title" style="margin:0 0 10px">
          <h2>${esc(t.name)} <span class="small muted">${fmtDate(s.date)}${a.updatedAt ? ` · 저장 ${fmtDateTime(a.updatedAt)}` : ' · 미입력'}</span></h2>
          <div class="actions">
            <button type="button" class="btn-sm" data-all="${t.id}">모두 출석</button>
            ${participants.length ? `<button type="button" class="btn-sm" data-fill="${t.id}" title="학생이 기록에 체크한 참여자는 출석, 나머지는 결석">기록 참여자로 채우기</button>` : ''}
          </div>
        </div>
        <div class="table-scroll"><table class="att-table"><tbody>
          ${t.members.map(m => `
            <tr data-sid="${esc(m.sid)}">
              <td class="nm">${esc(m.name)}<div class="small muted">${esc(m.sid)}</div></td>
              <td><div class="att-marks">${ATT_MARKS.map(k => `<label class="${MARK_CLS[k]}"><input type="radio" name="att-${t.id}-${esc(m.sid)}" value="${k}" ${a.marks?.[m.sid] === k ? 'checked' : ''}>${k}</label>`).join('')}</div></td>
              <td style="min-width:140px"><input type="text" data-note placeholder="비고" value="${esc(a.notes?.[m.sid] || '')}"></td>
            </tr>`).join('') || '<tr><td class="muted">팀원이 없습니다.</td></tr>'}
        </tbody></table></div>
      </div>`;
  };

  const summary = teams.map(t => `
    <h3 style="margin:18px 0 8px">${esc(t.name)}</h3>
    <div class="table-scroll"><table class="att-summary">
      <thead><tr><th>학생</th>${t.sessions.map(s => `<th class="c ${s.no === no ? 'now' : ''}">${s.no}</th>`).join('')}${ATT_MARKS.map(k => `<th class="c">${k}</th>`).join('')}</tr></thead>
      <tbody>${t.members.map(m => {
        const row = t.sessions.map(s => t.attendance[s.no]?.marks?.[m.sid] || '');
        return `<tr><td>${esc(m.name)}</td>${row.map(v => `<td class="c ${MARK_CLS[v] || ''}">${v ? MARK_ABBR[v] : ''}</td>`).join('')}${ATT_MARKS.map(k => `<td class="c">${row.filter(v => v === k).length || ''}</td>`).join('')}</tr>`;
      }).join('')}</tbody>
    </table></div>`).join('');

  page(`
    <div class="page-head">
      <div><h1>출결</h1><p class="muted small">차시를 고르고 학생별 출결을 체크한 뒤 [저장]하세요. 학생은 자기 출결만 볼 수 있습니다.</p></div>
      <div class="actions"><button class="btn-primary" id="att-save">${no}차시 출결 저장</button></div>
    </div>
    <div class="session-tabs">${ref.map(s => `<a href="#/attendance/${s.no}" class="${s.no === no ? 'active' : ''}">${s.no}차시<small>${fmtDate(s.date)}</small></a>`).join('')}</div>
    <div class="att-list">${teams.map(teamCard).join('')}</div>
    <p class="err" id="att-err"></p>
    <div class="section-title"><h2>출결 현황</h2><span class="legend">○ 출석 · 지 지각 · 조 조퇴 · × 결석 · 공 공결</span></div>
    ${summary}`, 'attendance');

  const list = $('.att-list');
  list.addEventListener('change', () => { state.dirty = true; });
  list.addEventListener('input', () => { state.dirty = true; });
  const setMark = (teamId, sid, k) => {
    const r = document.querySelector(`input[name="att-${teamId}-${sid}"][value="${k}"]`);
    if (r) r.checked = true;
  };
  $$('[data-all]').forEach(b => b.onclick = () => {
    const t = teams.find(x => x.id === b.dataset.all);
    t.members.forEach(m => setMark(t.id, m.sid, '출석'));
    state.dirty = true;
  });
  $$('[data-fill]').forEach(b => b.onclick = () => {
    const t = teams.find(x => x.id === b.dataset.fill);
    const p = t.logs[no]?.attendance || [];
    t.members.forEach(m => setMark(t.id, m.sid, p.includes(m.sid) ? '출석' : '결석'));
    state.dirty = true;
  });
  $('#att-save').onclick = async () => {
    const batch = writeBatch(db);
    const now = new Date().toISOString();
    for (const t of teams) {
      if (!t.sessions.some(s => s.no === no)) continue;
      const marks = {}, notes = {};
      for (const m of t.members) {
        const r = document.querySelector(`input[name="att-${t.id}-${m.sid}"]:checked`);
        if (r) marks[m.sid] = r.value;
        const note = document.querySelector(`.att-card[data-team="${t.id}"] tr[data-sid="${m.sid}"] [data-note]`).value.trim();
        if (note) notes[m.sid] = note.slice(0, 200);
      }
      batch.set(doc(db, 'teams', t.id, 'attendance', String(no)), { marks, notes, updatedAt: now });
    }
    $('#att-save').disabled = true;
    try {
      await batch.commit();
      state.dirty = false;
      toast(`${no}차시 출결을 저장했습니다.`);
      route();
    } catch (e) {
      $('#att-err').textContent = friendlyError(e);
      $('#att-save').disabled = false;
    }
  };
}

// ---------- 예산 ----------

async function renderBudgetOverview() {
  const teams = (await getDocs(collection(db, 'teams'))).docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
  const all = teams.map(t => ({ t, b: budgetOf(t) }));
  const tot = k => all.reduce((n, x) => n + x.b[k], 0);

  page(`
    <div class="page-head"><div><h1>예산</h1><p class="muted small">팀 한도 = 인원 × ${fmtWon(BUDGET_PER_PERSON)} · 팀 이름을 누르면 구매 내역을 관리합니다.</p></div></div>
    <div class="table-scroll"><table>
      <thead><tr><th>팀</th><th class="num">인원</th><th class="num">한도</th><th class="num">계획서 예산</th><th class="num">구매 완료</th><th class="num">구매 예정</th><th class="num">남은 예산</th><th>사용률</th></tr></thead>
      <tbody>${all.map(({ t, b }) => `
        <tr>
          <td><a href="#/team/${t.id}/budget"><b>${esc(t.name)}</b></a></td>
          <td class="num">${t.members.length}명</td>
          <td class="num">${fmtWon(b.limit)}</td>
          <td class="num ${b.planned > b.limit ? 'over' : ''}">${fmtWon(b.planned)}</td>
          <td class="num">${fmtWon(b.spent)}</td>
          <td class="num">${fmtWon(b.pending)}</td>
          <td class="num ${b.remaining < 0 ? 'over' : ''}"><b>${fmtWon(b.remaining)}</b></td>
          <td style="min-width:140px">${budgetBar(b)}</td>
        </tr>`).join('')}
        <tr><td><b>합계</b></td><td class="num">${teams.reduce((n, t) => n + t.members.length, 0)}명</td>
          <td class="num"><b>${fmtWon(tot('limit'))}</b></td><td class="num">${fmtWon(tot('planned'))}</td>
          <td class="num">${fmtWon(tot('spent'))}</td><td class="num">${fmtWon(tot('pending'))}</td>
          <td class="num"><b>${fmtWon(tot('remaining'))}</b></td><td></td></tr>
      </tbody>
    </table></div>
    <p class="small muted" style="margin-top:10px">남은 예산 = 한도 − 구매 완료 − 구매 예정. 계획서 예산이 한도를 넘으면 빨간색으로 표시됩니다.</p>`, 'budget');
}

async function renderTeamBudget(teamId) {
  const { team } = await fetchTeam(teamId);
  const isTeacher = state.me.role === 'teacher';
  const rows = structuredClone(team.purchases || []);
  const STATUSES = ['구매예정', '구매완료'];

  const summaryHtml = b => `
    <div class="stats">
      <div class="stat"><div class="num">${fmtWon(b.limit)}</div><div class="lbl">팀 한도 (${team.members.length}명 × ${fmtWon(BUDGET_PER_PERSON)})</div></div>
      <div class="stat"><div class="num">${fmtWon(b.spent)}</div><div class="lbl">구매 완료</div></div>
      <div class="stat"><div class="num">${fmtWon(b.pending)}</div><div class="lbl">구매 예정</div></div>
      <div class="stat ${b.remaining < 0 ? 'alert' : ''}"><div class="num">${fmtWon(b.remaining)}</div><div class="lbl">${b.remaining < 0 ? '⚠ 한도 초과' : '남은 예산 (예정 포함)'}</div></div>
    </div>
    <div style="margin-top:12px">${budgetBar(b)}</div>`;

  const editRow = (p, i) => `
    <tr data-i="${i}">
      <td style="width:150px"><input type="date" data-p="date" value="${esc(p.date || '')}"></td>
      <td><input type="text" data-p="item" value="${esc(p.item)}" placeholder="품목"></td>
      <td><input type="text" data-p="use" value="${esc(p.use)}" placeholder="용도"></td>
      <td style="width:76px"><input type="number" data-p="qty" min="0" value="${p.qty ?? 1}"></td>
      <td style="width:110px"><input type="number" data-p="unitPrice" min="0" value="${p.unitPrice || ''}"></td>
      <td class="num amt" style="width:100px">${fmtWon(p.amount)}</td>
      <td style="width:100px"><input type="text" data-p="vendor" value="${esc(p.vendor)}"></td>
      <td style="width:110px"><select data-p="status">${STATUSES.map(st => `<option ${p.status === st ? 'selected' : ''}>${st}</option>`).join('')}</select></td>
      <td><input type="text" data-p="note" value="${esc(p.note)}" placeholder="비고"></td>
      <td style="width:56px"><button type="button" class="btn-sm btn-danger" data-del="${i}">삭제</button></td>
    </tr>`;
  const viewRow = p => `
    <tr><td>${esc(p.date)}</td><td>${esc(p.item)}</td><td>${esc(p.use)}</td><td class="num">${p.qty ?? ''}</td>
      <td class="num">${p.unitPrice ? fmtWon(p.unitPrice) : ''}</td><td class="num">${fmtWon(p.amount)}</td>
      <td>${esc(p.vendor)}</td><td><span class="badge ${p.status === '구매완료' ? 'st-approved' : 'st-draft'}">${esc(p.status)}</span></td><td>${esc(p.note)}</td></tr>`;

  const collect = () => {
    $$('#b-rows tr[data-i]').forEach(tr => {
      const p = rows[tr.dataset.i];
      tr.querySelectorAll('[data-p]').forEach(inp => {
        const k = inp.dataset.p;
        p[k] = ['qty', 'unitPrice'].includes(k) ? Math.max(0, Math.round(Number(inp.value) || 0)) : inp.value.trim();
      });
      p.amount = p.qty * p.unitPrice;
    });
  };
  const recalc = () => {
    collect();
    $$('#b-rows tr[data-i]').forEach(tr => { tr.querySelector('.amt').textContent = fmtWon(rows[tr.dataset.i].amount); });
    $('#b-summary').innerHTML = summaryHtml(budgetOf({ ...team, purchases: rows }));
  };

  const render = () => {
    const plan = team.budget || [];
    page(`
      <div class="crumb"><a href="${isTeacher ? '#/budget' : `#/team/${team.id}`}">${isTeacher ? '예산' : '차시 기록'}</a> › ${esc(team.name)}</div>
      <div class="page-head"><div><h1>예산 · 구매 내역</h1><p class="muted small">${esc(team.name)}${isTeacher ? '' : ' · 구매 내역은 선생님이 기록합니다.'}</p></div>
        ${isTeacher ? '<div class="actions"><button class="btn-primary" id="b-save">저장</button></div>' : ''}</div>
      <div id="b-summary">${summaryHtml(budgetOf({ ...team, purchases: rows }))}</div>

      <div class="section-title"><h2>구매 내역</h2>
        ${isTeacher ? `<div class="actions"><button class="btn-sm" id="b-add">＋ 항목 추가</button>${plan.length ? '<button class="btn-sm" id="b-import">계획서 예산에서 가져오기</button>' : ''}</div>` : ''}</div>
      <div class="table-scroll"><table class="${isTeacher ? 'edit-table' : ''}">
        <thead><tr><th>구매일</th><th>품목</th><th>용도</th><th class="num">수량</th><th class="num">단가</th><th class="num">금액</th><th>구매처</th><th>상태</th><th>비고</th>${isTeacher ? '<th></th>' : ''}</tr></thead>
        <tbody id="b-rows">${rows.length ? rows.map(isTeacher ? editRow : viewRow).join('') : `<tr><td colspan="10" class="muted">아직 구매 내역이 없습니다.</td></tr>`}</tbody>
      </table></div>
      <p class="err" id="b-err"></p>

      ${plan.length ? `
        <div class="section-title"><h2>참고: 계획서 예산 (신청 당시)</h2></div>
        <div class="table-scroll"><table>
          <thead><tr><th>항목</th><th>용도</th><th>단가</th><th class="num">합계</th><th>구매처</th></tr></thead>
          <tbody>${plan.map(p => `<tr><td>${esc(p.item)}</td><td>${esc(p.use)}</td><td>${esc(p.unit)}</td><td class="num">${fmtWon(p.total)}</td><td>${esc(p.vendor)}</td></tr>`).join('')}</tbody>
        </table></div>` : ''}`, 'budget');

    if (!isTeacher) return;
    $('#b-rows').addEventListener('input', () => { recalc(); state.dirty = true; });
    $('#b-rows').addEventListener('change', () => { recalc(); state.dirty = true; });
    const change = fn => () => { collect(); fn(); render(); state.dirty = true; };
    $('#b-add').onclick = change(() => rows.push({ date: todayStr(), item: '', use: '', qty: 1, unitPrice: 0, amount: 0, vendor: '', status: '구매예정', note: '' }));
    if ($('#b-import')) {
      $('#b-import').onclick = change(() => plan.forEach(p => rows.push({
        date: '', item: p.item, use: p.use, qty: 1, unitPrice: p.total || 0, amount: p.total || 0, vendor: p.vendor, status: '구매예정', note: p.unit,
      })));
    }
    $$('[data-del]').forEach(b => b.onclick = change(() => rows.splice(Number(b.dataset.del), 1)));
    $('#b-save').onclick = async () => {
      collect();
      $('#b-save').disabled = true;
      try {
        await updateDoc(doc(db, 'teams', team.id), { purchases: rows.filter(p => p.item) });
        state.dirty = false;
        toast('구매 내역을 저장했습니다.');
        route();
      } catch (e) {
        $('#b-err').textContent = friendlyError(e);
        $('#b-save').disabled = false;
      }
    };
  };
  render();
}

// ---------- 계획서 보기 ----------

async function renderInfo(teamId) {
  const { team } = await fetchTeam(teamId);
  const isTeacher = state.me.role === 'teacher';
  const leader = team.members.find(m => m.sid === team.leaderSid);
  const total = team.budget.reduce((n, b) => n + (b.total || 0), 0);

  page(`
    <div class="crumb"><a href="${isTeacher ? '#/dashboard' : `#/team/${team.id}`}">${isTeacher ? '대시보드' : '차시 기록'}</a> › 계획서</div>
    <div class="page-head"><div><h1>주제 탐구 프로젝트 계획서</h1><p class="muted small">${esc(team.name)}</p></div>
      <div class="actions"><a class="btn" href="#/team/${team.id}">차시 기록 보기</a>${isTeacher ? `<a class="btn btn-primary" href="#/team/${team.id}/edit">편집</a>` : ''}</div></div>

    <div class="card"><dl class="info-grid">
      <dt>주제</dt><dd><b>${esc(team.topic)}</b></dd>
      <dt>목적 및 취지</dt><dd>${esc(team.purpose)}</dd>
      <dt>기간</dt><dd>${team.sessions.length ? `${fmtDate(team.sessions[0].date)} ~ ${fmtDate(team.sessions[team.sessions.length - 1].date)}` : ''} · ${esc(team.time)}</dd>
      <dt>장소</dt><dd>${esc(team.place)}</dd>
      <dt>팀장</dt><dd>${leader ? `${esc(leader.name)} (${esc(leader.sid)})` : '-'}</dd>
      <dt>주의사항</dt><dd>${esc(team.caution) || '<span class="muted">-</span>'}</dd>
    </dl></div>

    <div class="section-title"><h2>팀원</h2></div>
    <div class="table-scroll"><table>
      <thead><tr><th>학번</th><th>이름</th><th>역할·담당 분야</th></tr></thead>
      <tbody>${team.members.map(m => `<tr><td>${esc(m.sid)}</td><td>${m.sid === team.leaderSid ? '👑 ' : ''}${esc(m.name)}</td><td>${esc(m.role) || '<span class="muted">-</span>'}</td></tr>`).join('')}</tbody>
    </table></div>

    <div class="section-title"><h2>차시별 활동 계획</h2></div>
    <div class="table-scroll"><table>
      <thead><tr><th>차시</th><th>날짜</th><th>활동 내용</th><th>실험 계획</th></tr></thead>
      <tbody>${team.sessions.map(s => `<tr><td>${s.no}</td><td style="white-space:nowrap">${fmtDate(s.date)}</td><td>${esc(s.plan)}</td><td class="small">${esc(s.experiment) || '<span class="muted">-</span>'}</td></tr>`).join('')}</tbody>
    </table></div>

    <div class="section-title"><h2>예산 사용 계획</h2><span class="muted small">팀 한도 ${team.members.length}명 × ${fmtWon(BUDGET_PER_PERSON)} = <b>${fmtWon(team.members.length * BUDGET_PER_PERSON)}</b> · <a href="#/team/${team.id}/budget">구매 내역 보기</a></span></div>
    <div class="table-scroll"><table>
      <thead><tr><th>항목</th><th>용도</th><th>단가</th><th style="text-align:right">합계(원)</th><th>구매처</th></tr></thead>
      <tbody>${team.budget.length ? team.budget.map(b => `<tr><td>${esc(b.item)}</td><td>${esc(b.use)}</td><td>${esc(b.unit)}</td><td style="text-align:right">${won(b.total)}</td><td>${esc(b.vendor)}</td></tr>`).join('')
        + `<tr><td colspan="3"><b>합계</b></td><td style="text-align:right"><b>${won(total) || 0}</b></td><td></td></tr>`
        : '<tr><td colspan="5" class="muted">예산 사용 계획 없음</td></tr>'}</tbody>
    </table></div>`, 'info');
}

// ---------- 계획서 편집 (교사) ----------

async function renderEdit(teamId) {
  const { team } = await fetchTeam(teamId);
  const draft = structuredClone(team);

  const memberRows = () => draft.members.map((m, i) => `
    <tr data-i="${i}">
      <td style="width:50px;text-align:center"><input type="radio" name="leader" value="${i}" ${m.sid && m.sid === draft.leaderSid ? 'checked' : ''} title="팀장"></td>
      <td style="width:110px"><input type="text" data-m="sid" value="${esc(m.sid)}" placeholder="학번"></td>
      <td style="width:120px"><input type="text" data-m="name" value="${esc(m.name)}" placeholder="이름"></td>
      <td><input type="text" data-m="role" value="${esc(m.role)}" placeholder="역할·담당 분야"></td>
      <td style="width:60px"><button type="button" class="btn-sm btn-danger" data-del-member="${i}">삭제</button></td>
    </tr>`).join('');

  const sessionRows = () => draft.sessions.map((s, i) => `
    <tr data-i="${i}">
      <td style="width:50px;text-align:center">${i + 1}</td>
      <td style="width:160px"><input type="date" data-s="date" value="${esc(s.date)}"></td>
      <td><textarea data-s="plan" rows="2">${esc(s.plan)}</textarea></td>
      <td><textarea data-s="experiment" rows="2" placeholder="실험 없으면 비워 두기">${esc(s.experiment)}</textarea></td>
    </tr>`).join('');

  const budgetRows = () => draft.budget.map((b, i) => `
    <tr data-i="${i}">
      <td><input type="text" data-b="item" value="${esc(b.item)}"></td>
      <td><input type="text" data-b="use" value="${esc(b.use)}"></td>
      <td style="width:150px"><input type="text" data-b="unit" value="${esc(b.unit)}" placeholder="예: 18,000×2"></td>
      <td style="width:120px"><input type="number" data-b="total" value="${b.total || ''}" min="0"></td>
      <td style="width:100px"><input type="text" data-b="vendor" value="${esc(b.vendor)}"></td>
      <td style="width:60px"><button type="button" class="btn-sm btn-danger" data-del-budget="${i}">삭제</button></td>
    </tr>`).join('');

  // 현재 화면의 입력값을 draft에 반영한다 (행 추가·삭제·저장 전에 호출).
  const collect = () => {
    for (const k of ['name', 'topic', 'purpose', 'place', 'time', 'caution']) draft[k] = $(`#e-${k}`).value;
    $$('#members tr[data-i]').forEach(tr => {
      const m = draft.members[tr.dataset.i];
      tr.querySelectorAll('[data-m]').forEach(inp => {
        m[inp.dataset.m] = inp.value.trim();
      });
    });
    const leaderIdx = $('input[name=leader]:checked')?.value;
    draft.leaderSid = leaderIdx != null ? draft.members[leaderIdx]?.sid || '' : '';
    $$('#sessions tr[data-i]').forEach(tr => {
      const s = draft.sessions[tr.dataset.i];
      tr.querySelectorAll('[data-s]').forEach(inp => { s[inp.dataset.s] = inp.value; });
    });
    $$('#budget tr[data-i]').forEach(tr => {
      const b = draft.budget[tr.dataset.i];
      tr.querySelectorAll('[data-b]').forEach(inp => { b[inp.dataset.b] = inp.dataset.b === 'total' ? Math.max(0, Math.round(Number(inp.value) || 0)) : inp.value; });
    });
  };

  const render = () => {
    page(`
      <div class="crumb"><a href="#/dashboard">대시보드</a> › <a href="#/team/${team.id}">${esc(team.name)}</a> › 계획서 편집</div>
      <div class="page-head"><h1>계획서 편집</h1></div>
      <form id="edit-form">
        <div class="card">
          <div class="two-col">
            <div class="field"><label for="e-name">팀명</label><input type="text" id="e-name" value="${esc(draft.name)}"></div>
            <div class="field"><label for="e-place">장소</label><input type="text" id="e-place" value="${esc(draft.place)}"></div>
          </div>
          <div class="field"><label for="e-topic">주제</label><input type="text" id="e-topic" value="${esc(draft.topic)}"></div>
          <div class="field"><label for="e-purpose">목적 및 취지</label><textarea id="e-purpose" rows="3">${esc(draft.purpose)}</textarea></div>
          <div class="two-col">
            <div class="field"><label for="e-time">시간</label><input type="text" id="e-time" value="${esc(draft.time)}"></div>
            <div class="field"><label for="e-caution">활동 시 주의사항 <span class="hint">학생 화면 상단에 표시</span></label><input type="text" id="e-caution" value="${esc(draft.caution)}"></div>
          </div>
        </div>

        <div class="section-title"><h2>팀원</h2><span class="muted small">학생은 여기 적힌 <b>학번 + 이름</b>으로 로그인합니다. 이름을 고치거나 명단에서 빼면 그 학생의 기존 로그인은 끊깁니다.</span></div>
        <div class="table-scroll"><table class="edit-table">
          <thead><tr><th>팀장</th><th>학번</th><th>이름</th><th>역할</th><th></th></tr></thead>
          <tbody id="members">${memberRows()}</tbody></table></div>
        <p><button type="button" class="btn-sm" id="add-member">＋ 팀원 추가</button></p>

        <div class="section-title"><h2>차시 계획</h2></div>
        <div class="table-scroll"><table class="edit-table">
          <thead><tr><th>차시</th><th>날짜</th><th>활동 내용</th><th>실험 계획</th></tr></thead>
          <tbody id="sessions">${sessionRows()}</tbody></table></div>

        <div class="section-title"><h2>예산 사용 계획</h2></div>
        <div class="table-scroll"><table class="edit-table">
          <thead><tr><th>항목</th><th>용도</th><th>단가</th><th>합계(원)</th><th>구매처</th><th></th></tr></thead>
          <tbody id="budget">${budgetRows()}</tbody></table></div>
        <p><button type="button" class="btn-sm" id="add-budget">＋ 항목 추가</button></p>

        <div class="form-actions">
          <span class="grow"></span>
          <a class="btn" href="#/team/${team.id}/info">취소</a>
          <button type="submit" class="btn-primary">저장</button>
        </div>
        <p class="err" id="edit-err"></p>
      </form>`, 'dashboard');

    const change = fn => () => { collect(); fn(); render(); state.dirty = true; };
    $('#edit-form').addEventListener('input', () => { state.dirty = true; });
    $('#add-member').onclick = change(() => draft.members.push({ sid: '', name: '', role: '' }));
    $('#add-budget').onclick = change(() => draft.budget.push({ item: '', use: '', unit: '', total: 0, vendor: '' }));
    $$('[data-del-member]').forEach(b => b.onclick = change(() => draft.members.splice(Number(b.dataset.delMember), 1)));
    $$('[data-del-budget]').forEach(b => b.onclick = change(() => draft.budget.splice(Number(b.dataset.delBudget), 1)));
    $('#edit-form').onsubmit = async e => {
      e.preventDefault();
      collect();
      const submitBtn = e.target.querySelector('button[type=submit]');
      submitBtn.disabled = true;
      try {
        await saveTeam(team, draft);
        state.dirty = false;
        toast('계획서를 저장했습니다.');
        location.hash = `#/team/${team.id}/info`;
      } catch (err) {
        $('#edit-err').textContent = friendlyError(err);
        submitBtn.disabled = false;
      }
    };
  };
  render();
}

// ---------- 접속 안내 (교사, 인쇄용) ----------

async function renderPins() {
  const teams = (await getDocs(collection(db, 'teams'))).docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
  const url = location.origin + location.pathname;
  // 로그인은 roster 문서와 대조하므로, 실제 로그인에 쓰이는 값을 그대로 보여 준다.
  const roster = {};
  (await getDocs(collection(db, 'roster'))).forEach(d => { roster[d.id] = d.data(); });
  page(`
    <div class="page-head no-print">
      <div><h1>학생 접속 안내</h1><p class="muted small">학생은 아래 주소에서 <b>학번과 이름</b>을 입력하면 들어옵니다. 아래 적힌 값과 <b>똑같이</b> 입력해야 로그인됩니다.</p></div>
      <div class="actions"><button class="btn-primary" onclick="window.print()">🖨 인쇄</button></div>
    </div>
    <div class="card qr-card">
      <img src="qr.png" alt="접속 주소 QR 코드" width="220" height="220">
      <div>
        <h2>휴대폰으로 접속하기</h2>
        <ol class="qr-steps">
          <li>카메라로 QR 코드를 찍습니다.</li>
          <li>학번과 이름을 입력하고 [로그인]을 누릅니다.</li>
          <li>차시를 골라 그날 한 활동을 적고 [제출]합니다.</li>
        </ol>
        <p class="qr-url">${esc(url)}</p>
      </div>
    </div>
    ${teams.map(t => `
      <div class="section-title"><h2>${esc(t.name)}</h2></div>
      <div class="chips">${t.members.map(m => {
        const r = roster[m.sid];
        const bad = !r ? '명단 없음' : r.name !== m.name ? `로그인 이름: ${r.name}` : '';
        return `<span class="chip ${bad ? 'chip-warn' : ''}"><b>${esc(m.sid)}</b> ${esc(m.name)}${bad ? ` ⚠ ${esc(bad)}` : ''} <a class="no-print" href="#/preview/${t.id}/${esc(m.sid)}">화면 보기</a></span>`;
      }).join('') || '<span class="muted">팀원 없음</span>'}</div>`).join('')}
    <p class="small muted no-print" style="margin-top:20px">※ 접속코드 없이 명단의 학번·이름으로 들어갑니다. 같은 반 학생은 서로 알 수 있으니, 기록은 선생님이 확인해 주세요.</p>`, 'pins');
}

// ---------- 설정 (교사) ----------

function renderSettings() {
  page(`
    <div class="page-head"><h1>설정</h1></div>
    <div class="card" style="max-width:480px">
      <h2 style="margin-bottom:14px">교사 비밀번호 변경</h2>
      <form id="pw-form">
        <div class="field"><label for="pw-cur">현재 비밀번호</label><input type="password" id="pw-cur" autocomplete="current-password" required></div>
        <div class="field"><label for="pw-next">새 비밀번호 <span class="hint">6자 이상</span></label><input type="password" id="pw-next" minlength="6" autocomplete="new-password" required></div>
        <button class="btn-primary" type="submit">변경</button>
        <p class="err" id="pw-err"></p>
      </form>
    </div>
    <div class="card" style="max-width:480px">
      <h2 style="margin-bottom:8px">데이터</h2>
      <p class="small muted">모든 기록은 Firebase Firestore에 저장됩니다. 학기 말에는 CSV로 내려받아 보관하세요.</p>
      <button class="btn" id="csv">⬇ 전체 기록 CSV 내려받기 (엑셀용)</button>
    </div>`, 'settings');

  $('#csv').onclick = async () => downloadCsv(await fetchAllTeams());
  $('#pw-form').onsubmit = async e => {
    e.preventDefault();
    try {
      const user = auth.currentUser;
      await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, $('#pw-cur').value));
      await updatePassword(user, $('#pw-next').value);
      toast('비밀번호를 변경했습니다.');
      e.target.reset();
      $('#pw-err').textContent = '';
    } catch (err) {
      $('#pw-err').textContent = friendlyError(err);
    }
  };
}

// ---------- 시작 ----------

if (!CONFIGURED) {
  renderSetupNeeded();
} else {
  onAuthStateChanged(auth, async user => {
    if (state.linking) return;
    state.me = await resolveMe(user);
    state.ready = true;
    route();
  });
}

import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.0.0/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signInAnonymously, signInWithEmailAndPassword, signOut, deleteUser,
  connectAuthEmulator, EmailAuthProvider, reauthenticateWithCredential, updatePassword,
} from 'https://www.gstatic.com/firebasejs/12.0.0/firebase-auth.js';
import {
  getFirestore, connectFirestoreEmulator, doc, getDoc, getDocs, setDoc, deleteDoc,
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
  revise: { label: '보완 요청', cls: 'st-revise' },
  approved: { label: '확인 완료', cls: 'st-approved' },
};
const DONE = ['submitted', 'revise', 'approved'];
const LOG_TEXT_FIELDS = ['content', 'results', 'issues', 'nextPlan', 'references'];
const PIN_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';

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

function won(n) {
  return n ? Number(n).toLocaleString('ko-KR') : '';
}

function genPin() {
  const buf = crypto.getRandomValues(new Uint32Array(6));
  return [...buf].map(n => PIN_CHARS[n % PIN_CHARS.length]).join('');
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

async function fetchTeam(teamId) {
  const snap = await getDoc(doc(db, 'teams', teamId));
  if (!snap.exists()) throw new Error('팀을 찾을 수 없습니다.');
  const team = { id: snap.id, ...snap.data() };
  const found = await fetchLogs(teamId);
  const logs = {};
  for (const s of team.sessions) logs[s.no] = found[s.no] || emptyLog();
  return { team, logs };
}

async function fetchAllTeams() {
  const snaps = await getDocs(collection(db, 'teams'));
  const teams = snaps.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (a.order ?? 999) - (b.order ?? 999) || a.name.localeCompare(b.name, 'ko'));
  await Promise.all(teams.map(async t => { t.logs = await fetchLogs(t.id); }));
  return teams;
}

// 기록 저장/제출. rev가 다르면 다른 팀원이 먼저 저장한 것이므로 막는다.
async function saveLog(team, no, action, fields, baseRev) {
  const ref = doc(db, 'teams', team.id, 'logs', String(no));
  const me = state.me;
  const who = me.role === 'teacher' ? '담당 교사' : `${me.sid} ${me.name}`;
  await runTransaction(db, async tx => {
    const snap = await tx.get(ref);
    const cur = snap.exists() ? snap.data() : null;
    const curRev = cur?.rev || 0;
    if (cur?.status === 'approved' && me.role !== 'teacher') throw new Error('선생님 확인이 끝난 기록은 수정할 수 없습니다.');
    if (curRev !== baseRev) throw new Error('다른 팀원(또는 선생님)이 먼저 이 기록을 수정했습니다. 내용을 복사해 두고 새로고침한 뒤 다시 저장하세요.');
    const now = new Date().toISOString();
    const next = {
      ...(cur || {}),
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
      next.status = !cur || cur.status === 'draft' ? 'draft' : cur.status;
    }
    tx.set(ref, next);
  });
}

async function reviewLog(teamId, no, decision, feedback) {
  const ref = doc(db, 'teams', teamId, 'logs', String(no));
  await runTransaction(db, async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error('아직 작성되지 않은 기록입니다.');
    const cur = snap.data();
    const now = new Date().toISOString();
    const label = { approved: '확인 완료', revise: '보완 요청', submitted: '확인 취소' }[decision];
    tx.update(ref, {
      status: decision,
      feedback,
      feedbackAt: now,
      rev: (cur.rev || 0) + 1,
      history: [{ at: now, by: '담당 교사', action: label }, ...(cur.history || [])].slice(0, 30),
    });
  });
}

async function fetchPins(sids) {
  const pins = {};
  await Promise.all(sids.map(async sid => {
    const s = await getDoc(doc(db, 'pins', sid));
    pins[sid] = s.exists() ? s.data().pin : '';
  }));
  return pins;
}

// 계획서 저장: 팀 문서 + 로그인 명단(roster) + 접속코드(pins)를 한 번에 쓴다.
async function saveTeam(oldTeam, draft, pins) {
  const sids = new Set();
  for (const m of draft.members) {
    if (!/^[0-9A-Za-z-]{1,20}$/.test(m.sid)) throw new Error(`학번 '${m.sid}'이(가) 올바르지 않습니다.`);
    if (!m.name) throw new Error(`학번 ${m.sid}의 이름을 입력하세요.`);
    if (sids.has(m.sid)) throw new Error(`학번 ${m.sid}이(가) 중복되었습니다.`);
    if (!/^[a-z0-9]{4,20}$/.test(pins[m.sid] || '')) throw new Error(`${m.name}의 접속코드는 영문 소문자·숫자 4자 이상이어야 합니다.`);
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
    batch.set(doc(db, 'pins', m.sid), { pin: pins[m.sid] });
  }
  for (const old of oldTeam.members) {
    if (!sids.has(old.sid)) {
      batch.delete(doc(db, 'roster', old.sid));
      batch.delete(doc(db, 'pins', old.sid));
    }
  }
  await batch.commit();
}

async function importSeed() {
  const batch = writeBatch(db);
  SEED_TEAMS.forEach((t, i) => {
    const { id, ...data } = t;
    batch.set(doc(db, 'teams', id), { ...data, order: i + 1 });
    for (const m of t.members) {
      batch.set(doc(db, 'roster', m.sid), { name: m.name, teamId: id });
      batch.set(doc(db, 'pins', m.sid), { pin: genPin() });
    }
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

async function studentLogin(sid, pin) {
  state.linking = true;
  try {
    if (auth.currentUser && !auth.currentUser.isAnonymous) await signOut(auth);
    if (!auth.currentUser) await signInAnonymously(auth);
    const uid = auth.currentUser.uid;
    try {
      await setDoc(doc(db, 'links', uid), { sid, pin, at: new Date().toISOString() });
    } catch (e) {
      if (e.code === 'permission-denied') throw new Error('학번 또는 접속코드가 올바르지 않습니다. 담당 선생님께 확인하세요.');
      throw e;
    }
    const r = await getDoc(doc(db, 'roster', sid));
    state.me = { role: 'student', uid, sid, name: r.data().name, teamId: r.data().teamId };
  } finally {
    state.linking = false;
  }
}

async function logout() {
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

// ---------- 레이아웃 ----------

function page(html, active) {
  const me = state.me;
  const links = me.role === 'teacher'
    ? [['dashboard', '#/dashboard', '대시보드'], ['pins', '#/pins', '접속코드'], ['settings', '#/settings', '설정']]
    : [['team', `#/team/${me.teamId}`, '차시 기록'], ['info', `#/team/${me.teamId}/info`, '우리 팀 계획서']];
  $app.innerHTML = `
    <header class="topbar"><div class="wrap topbar-in">
      <a class="brand" href="#/">SLAT<span>학교주도활동 기록장</span></a>
      <nav>${links.map(([k, h, t]) => `<a href="${h}" class="${k === active ? 'active' : ''}">${t}</a>`).join('')}</nav>
      <div class="who">${me.role === 'teacher' ? '담당 교사' : esc(`${me.sid} ${me.name}`)}${USE_EMULATOR ? ' <span class="badge st-draft">에뮬레이터</span>' : ''}<button class="btn-ghost" id="logout">로그아웃</button></div>
    </div></header>
    <main class="wrap">${html}</main>`;
  $('#logout').onclick = logout;
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
      if (parts[0] === 'dashboard') return await renderDashboard();
      if (parts[0] === 'pins') return await renderPins();
      if (parts[0] === 'settings') return renderSettings();
      if (parts[0] === 'team' && parts[1] && parts[2] === 'edit') return await renderEdit(parts[1]);
    }
    if (parts[0] === 'team' && parts[1]) {
      if (parts[2] === 's' && parts[3]) return await renderLog(parts[1], Number(parts[3]));
      if (parts[2] === 'info') return await renderInfo(parts[1]);
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
        <div class="field"><label for="sid">학번</label><input type="text" id="sid" inputmode="numeric" autocomplete="off" placeholder="예: 10709" required></div>
        <div class="field"><label for="spin">접속코드 <span class="hint">선생님께 받은 6자리</span></label><input type="text" id="spin" autocomplete="off" autocapitalize="off" spellcheck="false" required></div>
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
      await studentLogin($('#sid').value.trim(), $('#spin').value.trim().toLowerCase());
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
        <div class="small muted">${t.members.length}명 · 제출 ${submitted}/${t.sessions.length}</div></td>
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

function downloadCsv(teams) {
  const cell = v => {
    const s = String(v ?? '');
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ['팀명', '주제', '차시', '날짜', '계획', '상태', '참여자', '활동 내용', '개인별 역할·기여', '결과·산출물', '어려운 점·해결', '다음 차시 계획', '참고자료·출처', '교사 피드백', '제출 일시', '최종 수정'];
  const rows = [header];
  for (const t of teams) {
    const nameOf = sid => t.members.find(m => m.sid === sid)?.name || sid;
    for (const s of t.sessions) {
      const l = t.logs[s.no] || emptyLog();
      rows.push([
        t.name, t.topic, s.no, s.date, s.plan, STATUS[l.status].label,
        l.attendance.map(nameOf).join(', '), l.content,
        Object.entries(l.contributions || {}).filter(([, v]) => v).map(([sid, v]) => `${nameOf(sid)}: ${v}`).join('\n'),
        l.results, l.issues, l.nextPlan, l.references, l.feedback,
        l.submittedAt ? new Date(l.submittedAt).toLocaleString('ko-KR') : '',
        l.updatedAt ? `${new Date(l.updatedAt).toLocaleString('ko-KR')} (${l.updatedBy})` : '',
      ]);
    }
  }
  const blob = new Blob(['﻿' + rows.map(r => r.map(cell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `SLAT_활동기록_${todayStr()}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- 팀 홈 (차시 목록) ----------

async function renderTeam(teamId) {
  const { team, logs } = await fetchTeam(teamId);
  const me = state.me;
  const today = todayStr();
  const nowNo = (team.sessions.find(s => s.date >= today) || {}).no;
  const count = st => team.sessions.filter(s => logs[s.no].status === st).length;
  const n = team.sessions.length || 1;
  const leader = team.members.find(m => m.sid === team.leaderSid);

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
          ${me.role === 'teacher' ? `<a class="btn" href="#/team/${team.id}/edit">계획서 편집</a>` : ''}
        </div>
      </div>
      <div class="chips">${team.members.map(m => `<span class="chip">${m.sid === team.leaderSid ? '👑 ' : ''}<b>${esc(m.name)}</b> ${esc(m.sid)}${m.role ? ` · ${esc(m.role)}` : ''}</span>`).join('')}</div>
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
    <div class="section-title"><h2>차시별 활동 기록</h2><span class="muted small">매 차시가 끝나면 그날 한 활동을 기록하고 [제출]하세요.</span></div>
    <div class="session-list">${cards}</div>`, 'team');
}

// ---------- 차시 기록 (작성·검토) ----------

async function renderLog(teamId, no) {
  const { team, logs } = await fetchTeam(teamId);
  const s = team.sessions.find(x => x.no === no);
  if (!s) throw new Error('차시를 찾을 수 없습니다.');
  const log = logs[no];
  const me = state.me;
  const isTeacher = me.role === 'teacher';
  const editable = !isTeacher && log.status !== 'approved';
  const nameOf = sid => team.members.find(m => m.sid === sid)?.name || sid;
  const prev = team.sessions.find(x => x.no === no - 1);
  const next = team.sessions.find(x => x.no === no + 1);

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

  const feedback = log.feedback
    ? `<div class="feedback-box ${log.status === 'revise' ? 'revise' : ''}">
         <b>💬 선생님 피드백${log.status === 'revise' ? ' — 보완 후 다시 제출해 주세요' : ''}</b>
         <div style="white-space:pre-wrap;margin-top:4px">${esc(log.feedback)}</div>
         <span class="who">${fmtDateTime(log.feedbackAt)}</span></div>`
    : '';

  const head = `
    <div class="crumb"><a href="${isTeacher ? '#/dashboard' : `#/team/${team.id}`}">${isTeacher ? '대시보드' : '차시 기록'}</a> › ${isTeacher ? `<a href="#/team/${team.id}">${esc(team.name)}</a> › ` : ''}${s.no}차시</div>
    <div class="page-head"><div><h1>${s.no}차시 활동 기록 ${badge(log.status, s.date)}</h1>
      <p class="muted small">${esc(team.name)} · ${fmtDate(s.date)} ${esc(team.time)}${log.updatedAt ? ` · 마지막 수정 ${fmtDateTime(log.updatedAt)} (${esc(log.updatedBy)})` : ''}</p></div></div>`;

  let main;
  if (editable) {
    main = `
      <form class="card" id="log-form">
        ${feedback}
        <div class="field"><label>참여자 <span class="hint">오늘 활동에 참여한 팀원을 모두 체크</span></label>
          <div class="attend">${team.members.map(m => `<label><input type="checkbox" name="att" value="${esc(m.sid)}" ${log.attendance.includes(m.sid) ? 'checked' : ''}>${esc(m.name)}</label>`).join('')}</div></div>
        <div class="field"><label for="content">오늘 한 활동 <span class="hint">필수 · 무엇을, 어떻게 했는지 구체적으로</span></label>
          <textarea id="content" rows="6" placeholder="예) 게임 몰입도를 결정하는 요인을 선행 연구 3편에서 조사하고, 팀원별로 담당 분야와 연결해 정리했다.">${esc(log.content)}</textarea></div>
        <div class="field"><label>개인별 역할·기여 <span class="hint">각자 맡은 일</span></label>
          <div class="contrib">${team.members.map(m => `
            <div class="contrib-row"><div class="nm">${esc(m.name)}${m.role ? `<small>${esc(m.role)}</small>` : ''}</div>
            <textarea data-sid="${esc(m.sid)}" rows="2">${esc(log.contributions[m.sid] || '')}</textarea></div>`).join('')}</div></div>
        <div class="field"><label for="results">결과·산출물 <span class="hint">측정값, 정리한 자료, 만든 것 등</span></label>
          <textarea id="results" rows="4">${esc(log.results)}</textarea></div>
        <div class="two-col">
          <div class="field"><label for="issues">어려웠던 점과 해결 방법</label><textarea id="issues" rows="3">${esc(log.issues)}</textarea></div>
          <div class="field"><label for="nextPlan">다음 차시 계획</label><textarea id="nextPlan" rows="3">${esc(log.nextPlan)}</textarea></div>
        </div>
        <div class="field"><label for="references">참고자료·출처 <span class="hint">책·논문·웹사이트 주소 등 (저작권 표기)</span></label>
          <textarea id="references" rows="2">${esc(log.references)}</textarea></div>
        <div class="form-actions">
          <span class="grow">${log.status === 'submitted' ? '이미 제출한 기록입니다. 고친 뒤 다시 제출할 수 있습니다.' : '임시저장은 팀원끼리 함께 볼 수 있고, 제출해야 선생님께 전달됩니다.'}</span>
          <button type="button" id="save">임시저장</button>
          <button type="submit" class="btn-primary">${DONE.includes(log.status) ? '다시 제출' : '제출하기'}</button>
        </div>
        <p class="err" id="log-err"></p>
      </form>`;
  } else {
    const contribs = team.members.map(m => log.contributions[m.sid] ? `${m.name}: ${log.contributions[m.sid]}` : '').filter(Boolean).join('\n');
    main = `
      <div>
        <div class="card">
          ${isTeacher ? '' : feedback}
          ${!isTeacher && log.status === 'approved' ? '<p class="muted small">✅ 선생님 확인이 끝난 기록입니다. 수정이 필요하면 선생님께 말씀드리세요.</p>' : ''}
          ${block('참여자', log.attendance.map(nameOf).join(', '))}
          ${block('오늘 한 활동', log.content)}
          ${block('개인별 역할·기여', contribs)}
          ${block('결과·산출물', log.results)}
          ${block('어려웠던 점과 해결 방법', log.issues)}
          ${block('다음 차시 계획', log.nextPlan)}
          ${block('참고자료·출처', log.references)}
          ${log.history?.length ? `<details><summary class="small muted">수정 이력 (${log.history.length})</summary><ul class="history">${log.history.map(h => `<li>${fmtDateTime(h.at)} · ${esc(h.by)} · ${esc(h.action)}</li>`).join('')}</ul></details>` : ''}
        </div>
        ${isTeacher ? `
          <div class="card review-panel">
            <h2>교사 검토</h2>
            ${log.status === 'empty' ? '<p class="muted">아직 학생이 작성하지 않았습니다.</p>' : `
              <div class="field" style="margin-top:10px"><label for="fb">피드백 <span class="hint">학생 화면에 그대로 보입니다</span></label>
                <textarea id="fb" rows="4" placeholder="잘한 점, 보완할 점을 적어 주세요.">${esc(log.feedback)}</textarea></div>
              <div class="btns">
                <button class="btn-primary" data-decision="approved">✅ 확인 완료</button>
                <button class="btn-danger" data-decision="revise">↩ 보완 요청</button>
                ${log.status === 'approved' || log.status === 'revise' ? '<button data-decision="submitted">검토 취소 (제출 상태로)</button>' : ''}
                <span class="muted small" style="align-self:center">${log.status === 'draft' ? '※ 아직 학생이 제출하지 않은 임시저장 상태입니다.' : ''}</span>
              </div>
              <p class="err" id="rv-err"></p>`}
          </div>` : ''}
      </div>`;
  }

  page(`${head}<div class="log-layout">${planBox}${main}</div>`, 'team');

  if (editable) {
    const form = $('#log-form');
    form.addEventListener('input', () => { state.dirty = true; });
    const collect = () => {
      const fields = {
        attendance: $$('input[name=att]:checked').map(i => i.value),
        contributions: Object.fromEntries($$('textarea[data-sid]').map(t => [t.dataset.sid, t.value.slice(0, 1000)])),
      };
      for (const k of LOG_TEXT_FIELDS) fields[k] = $(`#${k}`).value.slice(0, 5000);
      return fields;
    };
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
        toast(action === 'submit' ? '제출했습니다. 선생님이 확인하면 여기에 표시돼요.' : '임시저장했습니다.');
        if (action === 'submit') location.hash = `#/team/${team.id}`;
        else route();
      } catch (e) {
        $('#log-err').textContent = friendlyError(e);
        $$('#log-form button').forEach(b => { b.disabled = false; });
      }
    };
    $('#save').onclick = () => save('save');
    form.onsubmit = e => { e.preventDefault(); save('submit'); };
  }

  $$('[data-decision]').forEach(btn => btn.onclick = async () => {
    const decision = btn.dataset.decision;
    const feedbackText = $('#fb').value.slice(0, 2000);
    if (decision === 'revise' && !feedbackText.trim()) {
      $('#rv-err').textContent = '보완 요청 시에는 무엇을 보완할지 피드백을 적어 주세요.';
      return;
    }
    try {
      await reviewLog(team.id, no, decision, feedbackText);
      toast({ approved: '확인 완료로 처리했습니다.', revise: '보완을 요청했습니다.', submitted: '검토를 취소했습니다.' }[decision]);
      const nextWaiting = decision !== 'submitted' && team.sessions.find(x => x.no > no && logs[x.no].status === 'submitted');
      location.hash = nextWaiting ? `#/team/${team.id}/s/${nextWaiting.no}` : '#/dashboard';
    } catch (e) {
      $('#rv-err').textContent = friendlyError(e);
    }
  });
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

    <div class="section-title"><h2>예산 사용 계획</h2></div>
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
  const pins = await fetchPins(team.members.map(m => m.sid));
  draft.members.forEach(m => { m.pin = pins[m.sid] || genPin(); });

  const memberRows = () => draft.members.map((m, i) => `
    <tr data-i="${i}">
      <td style="width:50px;text-align:center"><input type="radio" name="leader" value="${i}" ${m.sid && m.sid === draft.leaderSid ? 'checked' : ''} title="팀장"></td>
      <td style="width:110px"><input type="text" data-m="sid" value="${esc(m.sid)}" placeholder="학번"></td>
      <td style="width:120px"><input type="text" data-m="name" value="${esc(m.name)}" placeholder="이름"></td>
      <td><input type="text" data-m="role" value="${esc(m.role)}" placeholder="역할·담당 분야"></td>
      <td style="width:150px"><div style="display:flex;gap:4px"><input type="text" data-m="pin" value="${esc(m.pin)}" spellcheck="false"><button type="button" class="btn-sm" data-regen="${i}" title="새 접속코드">↻</button></div></td>
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
        m[inp.dataset.m] = inp.dataset.m === 'pin' ? inp.value.trim().toLowerCase() : inp.value.trim();
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

        <div class="section-title"><h2>팀원</h2><span class="muted small">학생은 <b>학번 + 접속코드</b>로 로그인합니다. 접속코드를 바꾸면 그 학생의 기존 로그인은 끊깁니다.</span></div>
        <div class="table-scroll"><table class="edit-table">
          <thead><tr><th>팀장</th><th>학번</th><th>이름</th><th>역할</th><th>접속코드</th><th></th></tr></thead>
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
    $('#add-member').onclick = change(() => draft.members.push({ sid: '', name: '', role: '', pin: genPin() }));
    $('#add-budget').onclick = change(() => draft.budget.push({ item: '', use: '', unit: '', total: 0, vendor: '' }));
    $$('[data-regen]').forEach(b => b.onclick = change(() => { draft.members[Number(b.dataset.regen)].pin = genPin(); }));
    $$('[data-del-member]').forEach(b => b.onclick = change(() => draft.members.splice(Number(b.dataset.delMember), 1)));
    $$('[data-del-budget]').forEach(b => b.onclick = change(() => draft.budget.splice(Number(b.dataset.delBudget), 1)));
    $('#edit-form').onsubmit = async e => {
      e.preventDefault();
      collect();
      const submitBtn = e.target.querySelector('button[type=submit]');
      submitBtn.disabled = true;
      try {
        const pinMap = Object.fromEntries(draft.members.map(m => [m.sid, m.pin]));
        await saveTeam(team, draft, pinMap);
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

// ---------- 접속코드 목록 (교사, 인쇄용) ----------

async function renderPins() {
  const teams = (await getDocs(collection(db, 'teams'))).docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
  const pins = await fetchPins(teams.flatMap(t => t.members.map(m => m.sid)));
  page(`
    <div class="page-head no-print"><div><h1>학생 접속코드</h1><p class="muted small">인쇄해서 잘라 나눠 주세요. 코드 변경은 [계획서 편집]에서 합니다.</p></div>
      <div class="actions"><button class="btn-primary" onclick="window.print()">🖨 인쇄</button></div></div>
    <div class="pin-grid">${teams.flatMap(t => t.members.map(m => `
      <div class="pin-card">
        <div class="small muted">SLAT 기록장 · ${esc(t.name)}</div>
        <div><b>${esc(m.sid)} ${esc(m.name)}</b></div>
        <div class="pin-code">${esc(pins[m.sid] || '(없음)')}</div>
        <div class="small muted">${esc(location.origin + location.pathname)}</div>
      </div>`)).join('') || '<p class="muted">팀원이 없습니다.</p>'}</div>`, 'pins');
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

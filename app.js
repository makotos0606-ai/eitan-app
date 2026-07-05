// ===== 設定 =====
const CONFIG = {
  studentPassword: 'eigo2024',    // 生徒用パスワード（後で変更可）
  teacherPassword: 'sensei2024',  // 先生用パスワード（後で変更可）
  grades: ['1年', '2年', '3年'],
  classes: ['1組', '2組', '3組', '4組', '5組', '6組'],
  lessons: Array.from({length: 12}, (_, i) => `Lesson ${i + 1}`),
   ranks: [
    { name: 'ペンギンちゃん',   emoji: '🐧', min: 0,     max: 599   },
    { name: 'イルカちゃん',     emoji: '🐬', min: 600,   max: 1999  },
    { name: 'パンダちゃん',     emoji: '🐼', min: 2000,  max: 4999  },
    { name: 'トラちゃん',       emoji: '🐯', min: 5000,  max: 11999 },
    { name: 'ユニコーンちゃん', emoji: '🦄', min: 12000, max: Infinity },
  ],
  points: {
    typingCorrect: 2,
    typingLesson: 10,   // 1レッスン完走ボーナス
    quizCorrect: 5,
    quizPerfect: 20,    // パーフェクトボーナス
    memoryMatch: 3,     // 神経衰弱：1ペア成功
    memoryComplete: 15, // 神経衰弱：全ペア完成ボーナス
    shooterHit: 3,      // シューター：正解1発
    shooterBonus: 10,   // シューター：ノーミスボーナス
    patternCorrect: 6,  // 文型パズル：1問正解
    patternPerfect: 25, // 文型パズル：全問正解ボーナス
  }
};

// ===== 状態管理 =====
const state = {
  screen: 'login',      // login | nameEntry | home | typing | quiz | ranking | teacher
  role: null,           // student | teacher
  student: null,        // { id, name, grade, class, points }
  typingState: null,
  quizState: null,
  teacherTab: 'words',
};

const db = window.__db;
const F  = window.__firebase;

// ===== ユーティリティ =====
const app = document.getElementById('app');

function render(html) { app.innerHTML = html; }

function toast(msg, duration = 2500) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), duration);
}

function getRank(points) {
  for (let i = CONFIG.ranks.length - 1; i >= 0; i--) {
    if (points >= CONFIG.ranks[i].min) return CONFIG.ranks[i];
  }
  return CONFIG.ranks[0];
}

function getNextRank(points) {
  for (let i = 0; i < CONFIG.ranks.length - 1; i++) {
    if (points >= CONFIG.ranks[i].min && points <= CONFIG.ranks[i].max) {
      return CONFIG.ranks[i + 1];
    }
  }
  return null;
}

function rankProgress(points) {
  const rank = getRank(points);
  if (rank.max === Infinity) return 100;
  const total = rank.max - rank.min + 1;
  const done  = points - rank.min;
  return Math.min(100, Math.round((done / total) * 100));
}

// ===== DB ヘルパー =====
async function getStudent(id) {
  const snap = await F.getDoc(F.doc(db, 'students', id));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

async function saveStudent(student) {
  await F.setDoc(F.doc(db, 'students', student.id), {
    name: student.name,
    grade: student.grade,
    class: student.class,
    points: student.points,
    updatedAt: Date.now(),
  });
}

// ポイント加算：画面には即反映し、保存は裏でまとめて行う（体感速度UP）
let _pendingPts = 0;
let _ptsSaveTimer = null;

function addPoints(studentId, pts) {
  if (!state.student) return;
  const oldRank = getRank(state.student.points);
  state.student.points += pts;          // 即ローカル反映
  const newRank = getRank(state.student.points);
  if (newRank.name !== oldRank.name) showRankUp(newRank);

  // 保存は1.5秒間まとめて1回だけ書き込む
  _pendingPts += pts;
  if (_ptsSaveTimer) clearTimeout(_ptsSaveTimer);
  _ptsSaveTimer = setTimeout(() => flushPoints(studentId), 1500);
  return state.student.points;
}

async function flushPoints(studentId) {
  if (_pendingPts === 0) return;
  const toSave = _pendingPts;
  _pendingPts = 0;
  try {
    const inc = F.increment
      ? F.increment
      : (await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js")).increment;
    await F.updateDoc(F.doc(db, 'students', studentId), {
      points: inc(toSave),
      updatedAt: Date.now(),
    });
  } catch(e) {
    _pendingPts += toSave; // 失敗したら次回に持ち越し
  }
}

// 画面を閉じる直前にも保存を試みる
window.addEventListener('beforeunload', () => {
  if (_pendingPts !== 0 && state.student) flushPoints(state.student.id);
});

// 単語キャッシュ（5分間有効）— 2回目以降のロードを一瞬に
const _wordsCache = new Map();
const WORDS_CACHE_MS = 5 * 60 * 1000;

async function getWordsRaw(grade, cls, lesson) {
  const key = `${grade}|${cls}|${lesson}`;
  const hit = _wordsCache.get(key);
  if (hit && Date.now() - hit.at < WORDS_CACHE_MS) return hit.data;

  const q = F.query(
    F.collection(db, 'words'),
    F.where('grade', '==', grade),
    F.where('class', '==', cls),
    F.where('lesson', '==', lesson)
  );
  const snap = await F.getDocs(q);
  const data = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  _wordsCache.set(key, { at: Date.now(), data });
  return data;
}

// 語彙アクティビティ用（文型パズルのデータは除外）
async function getWords(grade, cls, lesson) {
  return (await getWordsRaw(grade, cls, lesson)).filter(w => w.kind !== 'pattern');
}

// 指定レッスンの文型パズル文を取得
async function getPatternsByLesson(grade, cls, lesson) {
  return (await getWordsRaw(grade, cls, lesson)).filter(w => w.kind === 'pattern');
}

// 学年・クラスの全文型パズル文を取得（生徒用）
async function getPatternsFor(grade, cls) {
  const all = await getAllWords();
  return all.filter(w => w.kind === 'pattern' && w.grade === grade && w.class === cls);
}

async function getAllStudents() {
  const snap = await F.getDocs(F.collection(db, 'students'));
  return snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => b.points - a.points);
}

async function getAllWords() {
  const snap = await F.getDocs(F.collection(db, 'words'));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function deleteWord(id) {
  const del = F.deleteDoc
    ? F.deleteDoc
    : (await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js")).deleteDoc;
  await del(F.doc(db, 'words', id));
  _wordsCache.clear(); // キャッシュを無効化
}

// ===== 画面描画 =====

// --- ログイン ---
function showLogin() {
  state.screen = 'login';
  render(`
    <div class="page-center">
      <div class="card login-card">
        <div class="mascot">📚</div>
        <h2>英単語チャレンジ！</h2>
        <p>パスワードを入力してスタート</p>
        <div class="login-tabs">
          <button class="active" onclick="setLoginTab('student', this)">生徒</button>
          <button class="inactive" onclick="setLoginTab('teacher', this)">先生</button>
        </div>
        <div id="login-form">
          <div class="form-group">
            <label>パスワード</label>
            <input type="password" id="pw-input" placeholder="パスワードを入力" onkeydown="if(event.key==='Enter')doLogin()">
          </div>
          <button class="btn-primary btn-full" onclick="doLogin()">ログイン</button>
        </div>
        <p id="login-error" style="color:#ef4444;margin-top:12px;font-size:.9rem;min-height:20px"></p>
      </div>
    </div>
  `);
  document.getElementById('pw-input').focus();
}

let loginTab = 'student';
window.setLoginTab = (tab, btn) => {
  loginTab = tab;
  document.querySelectorAll('.login-tabs button').forEach(b => {
    b.className = 'inactive';
  });
  btn.className = 'active';
};

window.doLogin = () => {
  const pw = document.getElementById('pw-input').value.trim();
  if (loginTab === 'student' && pw === CONFIG.studentPassword) {
    state.role = 'student';
    showNameEntry();
  } else if (loginTab === 'teacher' && pw === CONFIG.teacherPassword) {
    state.role = 'teacher';
    showTeacher();
  } else {
    document.getElementById('login-error').textContent = 'パスワードが違います';
    document.getElementById('pw-input').value = '';
    document.getElementById('pw-input').focus();
  }
};

// --- 名前・学年・クラス登録 ---
let entryGrade = '', entryClass = '';

function showNameEntry() {
  state.screen = 'nameEntry';
  render(`
    <div class="container" style="max-width:520px;padding-top:40px">
      <div class="card">
        <h2 style="margin-bottom:4px;color:var(--primary)">📝 プロフィール登録</h2>
        <p style="color:var(--muted);margin-bottom:16px">最初に情報を入力してね！</p>
        <div style="background:#fffbeb;border-left:4px solid #f59e0b;border-radius:0 8px 8px 0;padding:10px 14px;margin-bottom:18px;font-size:.88rem;color:#78350f;line-height:1.6">
          ⚠️ 名前を間違えると、ポイントが正しく反映されないことがあるよ！<br>よく確認してから登録しよう。
        </div>
        <div class="form-group">
          <label>名前（下の名前をひらがなで入力）</label>
          <input type="text" id="name-input" placeholder="例：たろう" maxlength="20">
          <p style="font-size:.8rem;color:var(--muted);margin-top:4px">※ 苗字は不要です。下の名前だけひらがなで入力してください。</p>
        </div>
        <div class="form-group">
          <label>学年</label>
          <div class="select-grid" id="grade-grid">
            ${CONFIG.grades.map(g => `<button class="select-btn" onclick="selectGrade('${g}',this)">${g}</button>`).join('')}
          </div>
        </div>
        <div class="form-group">
          <label>クラス</label>
          <div class="select-grid" id="class-grid">
            ${CONFIG.classes.map(c => `<button class="select-btn" onclick="selectClass('${c}',this)">${c}</button>`).join('')}
          </div>
        </div>
        <button class="btn-primary btn-full" onclick="doRegister()">スタート！🚀</button>
        <p id="reg-error" style="color:#ef4444;margin-top:10px;font-size:.9rem;min-height:18px"></p>
      </div>
    </div>
  `);
}

window.selectGrade = (g, btn) => {
  entryGrade = g;
  document.querySelectorAll('#grade-grid .select-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
};
window.selectClass = (c, btn) => {
  entryClass = c;
  document.querySelectorAll('#class-grid .select-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
};

window.doRegister = async () => {
  const name = document.getElementById('name-input').value.trim();
  if (!name) { document.getElementById('reg-error').textContent = '名前を入力してください'; return; }
  if (!entryGrade) { document.getElementById('reg-error').textContent = '学年を選んでください'; return; }
  if (!entryClass) { document.getElementById('reg-error').textContent = 'クラスを選んでください'; return; }

  const id = `${entryGrade}_${entryClass}_${name}`;
  let student = await getStudent(id);
  if (!student) {
    student = { id, name, grade: entryGrade, class: entryClass, points: 0 };
    await saveStudent(student);
  }
  state.student = student;
  localStorage.setItem('eitanStudentId', id); // 次回から自動ログイン
  showHome();
};

// ===== 苦手単語（端末に記憶＋Firestoreにも記録） =====
function _weakKey() { return `eitanWeak_${state.student?.id || ''}`; }
function getWeakWords() {
  try { return JSON.parse(localStorage.getItem(_weakKey()) || '{}'); } catch(e) { return {}; }
}
function recordWeak(word) {
  if (!word?.en) return;
  const w = getWeakWords();
  const k = word.en.toLowerCase();
  w[k] = { en: word.en, ja: word.ja, n: (w[k]?.n || 0) + 1 };
  localStorage.setItem(_weakKey(), JSON.stringify(w));
  // 先生の分析用に記録（失敗しても無視）
  try {
    F.addDoc(F.collection(db, 'mistakes'), {
      grade: state.student.grade, class: state.student.class,
      en: word.en, ja: word.ja, at: Date.now(),
    }).catch(() => {});
  } catch(e) {}
}
function weakCorrect(word) {
  if (!word?.en) return;
  const w = getWeakWords();
  const k = word.en.toLowerCase();
  if (!w[k]) return;
  w[k].n--;
  if (w[k].n <= 0) delete w[k]; // 克服！
  localStorage.setItem(_weakKey(), JSON.stringify(w));
}

// ===== 連続ログイン＆今日のミッション =====
const DAILY_GOAL = 20;   // 1日の目標正解数
const DAILY_BONUS = 15;  // 達成ボーナス

function _todayStr() { const d = new Date(); return `${d.getFullYear()}-${d.getMonth()+1}-${d.getDate()}`; }

function updateStreak() {
  const key = `eitanStreak_${state.student?.id || ''}`;
  let st; try { st = JSON.parse(localStorage.getItem(key) || 'null'); } catch(e) { st = null; }
  const today = _todayStr();
  const yest = (() => { const d = new Date(Date.now() - 864e5); return `${d.getFullYear()}-${d.getMonth()+1}-${d.getDate()}`; })();
  if (!st || (st.last !== today && st.last !== yest)) st = { last: today, n: 1 };
  else if (st.last === yest) st = { last: today, n: st.n + 1 };
  localStorage.setItem(key, JSON.stringify(st));
  return st.n;
}

function getDaily() {
  const key = `eitanDaily_${state.student?.id || ''}`;
  let d; try { d = JSON.parse(localStorage.getItem(key) || 'null'); } catch(e) { d = null; }
  if (!d || d.date !== _todayStr()) d = { date: _todayStr(), count: 0, rewarded: false };
  return d;
}

function bumpDaily() {
  if (!state.student) return;
  const key = `eitanDaily_${state.student.id}`;
  const d = getDaily();
  d.count++;
  if (d.count >= DAILY_GOAL && !d.rewarded) {
    d.rewarded = true;
    addPoints(state.student.id, DAILY_BONUS);
    toast(`🎯 今日のミッション達成！ +${DAILY_BONUS}pt`, 3000);
    playSfx('win');
  }
  localStorage.setItem(key, JSON.stringify(d));
}

// ===== 苦手単語だけ練習 =====
window.showWeakMenu = () => {
  const weak = Object.values(getWeakWords());
  if (weak.length === 0) { toast('苦手な単語はないよ！すごい！🎉', 2500); return; }
  render(`
    ${header()}
    <div class="container" style="max-width:560px">
      <div class="card">
        <h2 style="color:#ef4444;margin-bottom:4px">💪 苦手な単語だけ練習</h2>
        <p style="color:var(--muted);margin-bottom:16px">まちがえた単語 ${weak.length}語 に挑戦！正解すればリストから消えるよ</p>
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:20px">
          ${weak.slice(0, 30).map(w => `<span style="background:#fef2f2;color:#b91c1c;border-radius:8px;padding:4px 10px;font-size:.85rem;font-weight:600">${w.en}</span>`).join('')}
          ${weak.length > 30 ? `<span style="color:var(--muted)">…ほか${weak.length - 30}語</span>` : ''}
        </div>
        <div style="display:grid;gap:10px">
          <button class="btn-primary" onclick='startTypingHint(${JSON.stringify(weak).replace(/'/g, "&#39;")})'>✏️ タイピングで練習</button>
          ${weak.length >= 2 ? `<button class="btn-primary" style="background:linear-gradient(135deg,#7c3aed,#c026d3)" onclick='startQuiz(${JSON.stringify(weak).replace(/'/g, "&#39;")})'>🧠 4択テストで練習</button>` : ''}
          <button class="btn-secondary" onclick="showHome()">← 戻る</button>
        </div>
      </div>
    </div>
  `);
};

// --- ホーム ---
function showHome() {
  state.screen = 'home';
  const s = state.student;
  const rank = getRank(s.points);
  const next = getNextRank(s.points);
  const prog = rankProgress(s.points);
  const streak = updateStreak();
  const daily = getDaily();
  const dailyPct = Math.min(100, Math.round(daily.count / DAILY_GOAL * 100));
  const weakCount = Object.keys(getWeakWords()).length;

  render(`
    ${header()}
    <div class="container">
      <div class="profile-bar">
        <div>
          <div class="name">${rank.emoji} ${s.name} さん</div>
          <div class="rank-badge">${rank.name}</div>
        </div>
        <div class="progress-wrap">
          <div class="progress-label">
            ${next ? `次のランクまで ${next.min - s.points}pt` : '最高ランク達成！🎉'}
          </div>
          <div class="progress-bar"><div class="progress-fill" style="width:${prog}%"></div></div>
        </div>
        <div class="pts">${s.points} pt</div>
      </div>

      <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px">
        <div style="flex:1;min-width:160px;background:white;border-radius:12px;padding:12px 16px;box-shadow:var(--shadow);display:flex;align-items:center;gap:10px">
          <span style="font-size:1.6rem">🔥</span>
          <div>
            <div style="font-weight:800;font-size:1.1rem">連続 ${streak} 日</div>
            <div style="font-size:.75rem;color:var(--muted)">毎日続けよう！</div>
          </div>
        </div>
        <div style="flex:2;min-width:220px;background:white;border-radius:12px;padding:12px 16px;box-shadow:var(--shadow)">
          <div style="display:flex;justify-content:space-between;font-size:.85rem;margin-bottom:6px">
            <span style="font-weight:700">🎯 今日のミッション：${DAILY_GOAL}問正解</span>
            <span style="color:${daily.rewarded ? 'var(--success)' : 'var(--muted)'};font-weight:700">
              ${daily.rewarded ? `達成！ +${DAILY_BONUS}pt 🎉` : `${daily.count} / ${DAILY_GOAL}`}
            </span>
          </div>
          <div class="progress-bar"><div class="progress-fill" style="width:${dailyPct}%;background:linear-gradient(90deg,#f59e0b,#ef4444)"></div></div>
        </div>
      </div>

      <h3 style="margin-bottom:14px;color:var(--muted)">何をやる？</h3>
      <div class="menu-grid">
        <div class="menu-card" onclick="showLessonSelect('typing-hint')">
          <div class="icon">✏️</div>
          <h3>タイピング練習</h3>
          <p>頭文字を見ながら英単語を打とう</p>
        </div>
        <div class="menu-card" onclick="showLessonSelect('typing')">
          <div class="icon">⌨️</div>
          <h3>タイピング実践</h3>
          <p>ヒントなしで英単語を打とう</p>
        </div>
        <div class="menu-card" onclick="showLessonSelect('quiz')">
          <div class="icon">🧠</div>
          <h3>ミニテスト</h3>
          <p>4択で意味を当てよう</p>
        </div>
        <div class="menu-card" onclick="showLessonSelect('shooter')">
          <div class="icon">🎯</div>
          <h3>ワードシューター</h3>
          <p>飛んでくる英単語を撃ち抜け！</p>
        </div>
        <div class="menu-card" onclick="showLessonSelect('memory')">
          <div class="icon">🎴</div>
          <h3>神経衰弱</h3>
          <p>英語と日本語をマッチさせよう</p>
        </div>
        <div class="menu-card" onclick="showLessonSelect('pop')">
          <div class="icon">🃏</div>
          <h3>POP ゲーム</h3>
          <p>グループで遊べるカードゲーム</p>
        </div>
        <div class="menu-card" onclick="startPattern()">
          <div class="icon">🧩</div>
          <h3>文型パズル</h3>
          <p>カードを並べて英文の「型」を作ろう</p>
        </div>
        <div class="menu-card" onclick="showWeakMenu()" style="${weakCount > 0 ? 'border:2px solid #fca5a5' : ''}">
          <div class="icon">💪</div>
          <h3>苦手な単語だけ練習</h3>
          <p>${weakCount > 0 ? `まちがえた ${weakCount}語 をやっつけよう！` : 'まちがえた単語がここにたまるよ'}</p>
        </div>
        <div class="menu-card" onclick="showRanking()">
          <div class="icon">🏆</div>
          <h3>ランキング</h3>
          <p>みんなのポイントを見る</p>
        </div>
      </div>
    </div>
  `);
}

// --- レッスン選択（複数選択対応） ---
let selectedLessons = [];
let activityType = '';

const ACTIVITY_LABELS = {
  'typing':      'タイピング実践',
  'typing-hint': 'タイピング練習',
  'quiz':        'ミニテスト',
  'shooter':     'ワードシューター',
  'memory':      '神経衰弱',
  'pop':         'POPゲーム',
};

function showLessonSelect(type) {
  activityType = type;
  selectedLessons = [];
  const label = ACTIVITY_LABELS[type] || type;
  render(`
    ${header()}
    <div class="container" style="max-width:560px">
      <div class="card">
        <h2 style="color:var(--primary);margin-bottom:4px">${label}</h2>
        <p style="color:var(--muted);margin-bottom:4px">${state.student.grade} ${state.student.class} のレッスンを選んでね</p>
        <p style="color:var(--accent);font-size:.85rem;margin-bottom:16px">複数選択OK！タップで選択／解除</p>
        <div class="form-group">
          <label>レッスン</label>
          <div class="select-grid">
            ${CONFIG.lessons.map(l => `<button class="select-btn" onclick="toggleLesson('${l}',this)">${l}</button>`).join('')}
          </div>
        </div>
        <div id="lesson-count" style="text-align:center;color:var(--muted);font-size:.85rem;margin-bottom:12px"></div>
        <div style="display:flex;gap:10px">
          <button class="btn-secondary" style="flex:1" onclick="showHome()">← 戻る</button>
          <button class="btn-primary" style="flex:2" onclick="startActivity()">スタート！</button>
        </div>
        <p id="lesson-error" style="color:#ef4444;margin-top:10px;font-size:.9rem;min-height:18px"></p>
      </div>
    </div>
  `);
}

window.toggleLesson = (l, btn) => {
  const idx = selectedLessons.indexOf(l);
  if (idx === -1) { selectedLessons.push(l); btn.classList.add('active'); }
  else            { selectedLessons.splice(idx, 1); btn.classList.remove('active'); }
  const el = document.getElementById('lesson-count');
  if (el) el.textContent = selectedLessons.length > 0 ? `${selectedLessons.length}レッスン選択中` : '';
};

window.startActivity = async () => {
  try {
    const errEl = document.getElementById('lesson-error');
    if (selectedLessons.length === 0) {
      if (errEl) errEl.textContent = 'レッスンを選んでください';
      return;
    }
    if (errEl) errEl.textContent = '読み込み中…';

    // 全レッスンを同時に取得（1つ失敗しても他は生かす）
    const results = await Promise.all(
      selectedLessons.map(l =>
        getWords(state.student.grade, state.student.class, l).catch(() => [])
      )
    );
    let words = [].concat(...results);

    if (words.length === 0) {
      if (errEl) errEl.textContent = '単語が登録されていません。先生に登録してもらおう！';
      return;
    }
    if (activityType === 'typing')           startTyping(words);
    else if (activityType === 'typing-hint') startTypingHint(words);
    else if (activityType === 'quiz')        startQuiz(words);
    else if (activityType === 'pop')         showPOPSetup(words);
    else if (activityType === 'memory')      startMemory(words);
    else if (activityType === 'shooter')     startShooter(words);
  } catch(e) {
    const msg = e?.message || String(e) || '不明なエラー';
    render(`
      ${header()}
      <div class="container" style="max-width:520px">
        <div class="card" style="border-left:4px solid #ef4444">
          <h3 style="color:#ef4444">エラーが発生しました</h3>
          <p style="font-family:monospace;font-size:.85rem;background:#f1f5f9;padding:12px;border-radius:8px;margin:12px 0;word-break:break-all">${msg}</p>
          <button class="btn-primary" onclick="showHome()">ホームへ戻る</button>
        </div>
      </div>
    `);
  }
};

// --- タイピング練習 ---
function shuffle(arr) { return [...arr].sort(() => Math.random() - .5); }

function startTyping(words) {
  state.screen = 'typing';
  const list = shuffle(words);
  state.typingState = { list, index: 0, correct: 0, wrong: 0, done: false, hintLevel: 0 };
  renderTyping();
}

function renderTyping() {
  const ts = state.typingState;
  if (ts.index >= ts.list.length) { showTypingResult(); return; }
  const word = ts.list[ts.index];
  const pct = Math.round((ts.index / ts.list.length) * 100);

  render(`
    ${header()}
    <div class="container">
      <div class="typing-area">
        <div class="typing-progress">
          <span>${ts.index + 1} / ${ts.list.length}</span>
          <span>✅ ${ts.correct}  ❌ ${ts.wrong}</span>
        </div>
        <div class="progress-bar" style="margin-bottom:16px">
          <div class="progress-fill" style="width:${pct}%"></div>
        </div>
        <div class="word-display">
          <div class="word-ja">${word.ja}</div>
          <div class="word-hint" id="hint-area"></div>
        </div>
        <div class="typing-feedback" id="feedback"></div>
        <div class="typing-input-wrap">
          <input class="typing-input" id="type-input" type="text"
            placeholder="英語でタイプしてね" autocomplete="off" autocorrect="off"
            spellcheck="false" oninput="checkTyping()" onkeydown="handleTypingKey(event)">
        </div>
        <div style="display:flex;gap:10px;justify-content:center">
          <button class="btn-secondary btn-sm" onclick="showHint()">ヒント</button>
          <button class="btn-secondary btn-sm" onclick="skipWord()">スキップ</button>
          <button class="btn-secondary btn-sm" onclick="showHome()">やめる</button>
        </div>
      </div>
    </div>
  `);
  setTimeout(() => document.getElementById('type-input')?.focus(), 50);
}

window.checkTyping = () => {
  const ts = state.typingState;
  const word = ts.list[ts.index];
  const inp = document.getElementById('type-input');
  if (!inp) return;
  const val = inp.value.trim().toLowerCase();
  const target = word.en.toLowerCase();
  if (val === target) {
    inp.classList.add('correct');
    document.getElementById('feedback').textContent = '✨ 正解！';
    document.getElementById('feedback').className = 'typing-feedback ok';
    ts.correct++;
    playSfx('correct');
    speakWord(word.en);
    weakCorrect(word);
    bumpDaily();
    addPoints(state.student.id, CONFIG.points.typingCorrect);
    setTimeout(() => {
      ts.index++;
      ts.hintLevel = 0;
      renderTyping();
    }, 350);
  }
};

window.handleTypingKey = (e) => {
  if (e.key === 'Enter') {
    const ts = state.typingState;
    const word = ts.list[ts.index];
    const val = document.getElementById('type-input').value.trim().toLowerCase();
    if (val !== word.en.toLowerCase()) {
      const inp = document.getElementById('type-input');
      inp.classList.add('wrong');
      document.getElementById('feedback').textContent = `❌ 正解は「${word.en}」`;
      document.getElementById('feedback').className = 'typing-feedback ng';
      ts.wrong++;
      recordWeak(word);
      playSfx('wrong');
      setTimeout(() => {
        inp.classList.remove('wrong');
        inp.value = '';
        document.getElementById('feedback').textContent = '';
      }, 1200);
    }
  }
};

window.showHint = () => {
  const ts = state.typingState;
  const word = ts.list[ts.index];
  if (ts.hintLevel === undefined) ts.hintLevel = 0;

  const maxReveal = Math.min(3, word.en.length);
  if (ts.hintLevel === 0) {
    // 1回目：文字数のみ
    const el = document.getElementById('hint-area');
    if (el) el.textContent = `ヒント: ${'＿'.repeat(word.en.length)}（${word.en.length}文字）`;
    ts.hintLevel = 1;
  } else if (ts.hintLevel <= maxReveal) {
    // 2回目以降：1文字ずつ最大3文字まで
    const revealed = word.en.slice(0, ts.hintLevel);
    const hidden = '＿'.repeat(word.en.length - ts.hintLevel);
    const el = document.getElementById('hint-area');
    if (el) el.textContent = `ヒント: ${revealed}${hidden}（${word.en.length}文字）`;
    ts.hintLevel++;
  } else {
    const el = document.getElementById('hint-area');
    if (el) el.textContent = `ヒント: ${word.en.slice(0, maxReveal)}${'＿'.repeat(word.en.length - maxReveal)}（これ以上は出せないよ！）`;
  }
};

window.skipWord = () => {
  state.typingState.index++;
  state.typingState.hintLevel = 0;
  renderTyping();
};

async function showTypingResult() {
  const ts = state.typingState;
  const bonus = ts.correct === ts.list.length ? CONFIG.points.typingLesson : 0;
  if (bonus > 0) await addPoints(state.student.id, bonus);

  render(`
    <div class="overlay"></div>
    <div class="score-popup">
      <h2>練習おわり！</h2>
      <div class="big">⌨️</div>
      <p>${ts.list.length}問中 <strong>${ts.correct}問</strong> 正解</p>
      ${bonus > 0 ? `<p style="color:var(--accent);font-weight:700">パーフェクトボーナス +${bonus}pt 🎉</p>` : ''}
      <div class="pts-earned">+${ts.correct * CONFIG.points.typingCorrect + bonus} pt</div>
      <p style="color:var(--muted);font-size:.85rem;margin-bottom:20px">合計 ${state.student.points} pt</p>
      <div style="display:flex;gap:10px">
        <button class="btn-secondary" onclick="showLessonSelect('typing')">もう一度</button>
        <button class="btn-primary" onclick="showHome()">ホームへ</button>
      </div>
    </div>
  `);
}

// --- タイピング練習（頭文字ヒント＋間違えたら1文字ずつ） ---
// ===== キーボード定義（JIS配列） =====
const KB_ROWS = [
  ['1','2','3','4','5','6','7','8','9','0','-','^'],
  ['Q','W','E','R','T','Y','U','I','O','P'],
  ['A','S','D','F','G','H','J','K','L'],
  ['Z','X','C','V','B','N','M'],
];

function buildKeyboardHTML(word, typed) {
  const typedUpper = typed.toUpperCase();
  const nextChar   = word.en[typed.length]?.toUpperCase() || '';
  return KB_ROWS.map(row => `
    <div class="th-kb-row">
      ${row.map(k => {
        const isNext  = k === nextChar;
        const isTyped = typedUpper.includes(k) && !isNext;
        const cls = isNext ? 'th-key next' : isTyped ? 'th-key typed' : 'th-key';
        return `<div class="${cls}">${k}</div>`;
      }).join('')}
    </div>
  `).join('');
}

// ===== 単語の色分け表示（正しく打済=グレー / 誤り=赤 / 次=オレンジ / 残り=黒） =====
function buildWordColorHTML(word, typed) {
  return word.en.split('').map((ch, i) => {
    if (i < typed.length) {
      const ok = typed[i].toLowerCase() === ch.toLowerCase();
      return `<span style="color:${ok ? '#94a3b8' : '#ef4444'}">${ch}</span>`;
    } else if (i === typed.length) {
      return `<span style="color:#f97316;font-weight:900;text-decoration:underline">${ch}</span>`;
    } else {
      return `<span style="color:#1e293b">${ch}</span>`;
    }
  }).join(' ');
}

// ===== タイプした文字を表示（誤りは赤で表示） =====
function buildTypedRowHTML(word, typed) {
  if (!typed) return '<span style="color:#94a3b8;font-style:italic">ここに入力してね</span>';
  const spans = typed.split('').map((ch, i) => {
    const ok = word && i < word.en.length && ch.toLowerCase() === word.en[i].toLowerCase();
    return `<span style="color:${ok ? '#1e293b' : '#ef4444'};font-weight:700">${ch}</span>`;
  }).join(' ');
  return `${spans}<span class="th-cursor">|</span>`;
}

// ===== 効果音（Web Audio API）全アクティビティ共通 =====
let _audioCtx = null;
function _beep(freqFrom, freqTo, dur, type = 'sine', vol = 0.18, delay = 0) {
  try {
    if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const ctx  = _audioCtx;
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    const t = ctx.currentTime + delay;
    osc.type = type;
    osc.frequency.setValueAtTime(freqFrom, t);
    if (freqTo !== freqFrom) osc.frequency.exponentialRampToValueAtTime(freqTo, t + dur);
    gain.gain.setValueAtTime(vol, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.start(t); osc.stop(t + dur);
  } catch(e) {}
}

// ===== サウンド設定（生徒が🔊/🔇で切替、端末に記憶） =====
window._sfxMuted = localStorage.getItem('eitanMuted') === '1';
window.toggleMute = () => {
  window._sfxMuted = !window._sfxMuted;
  localStorage.setItem('eitanMuted', window._sfxMuted ? '1' : '0');
  const btn = document.getElementById('mute-btn');
  if (btn) btn.textContent = window._sfxMuted ? '🔇' : '🔊';
  toast(window._sfxMuted ? 'サウンドOFF' : 'サウンドON', 1200);
};

// kind: type/correct/wrong/select/match/pop/hit/miss/win
function playSfx(kind = 'type') {
  if (window._sfxMuted) return;
  switch (kind) {
    case 'correct': _beep(880, 1320, 0.18, 'sine', 0.25); break;
    case 'wrong':   _beep(220, 140, 0.15, 'square', 0.16); break;
    case 'select':  _beep(520, 620, 0.06, 'triangle', 0.12); break;
    case 'match':   _beep(660, 990, 0.10, 'sine', 0.22); _beep(990, 1320, 0.12, 'sine', 0.20, 0.10); break;
    case 'pop':     _beep(180, 90, 0.22, 'sawtooth', 0.28); break;
    case 'hit':     _beep(1000, 500, 0.09, 'square', 0.18); _beep(500, 1200, 0.10, 'sine', 0.16, 0.05); break;
    case 'miss':    _beep(200, 120, 0.18, 'sawtooth', 0.18); break;
    case 'win':     _beep(660, 660, 0.12, 'sine', 0.22); _beep(880, 880, 0.12, 'sine', 0.22, 0.12); _beep(1320, 1320, 0.2, 'sine', 0.22, 0.24); break;
    default:        _beep(700, 400, 0.07, 'triangle', 0.12); break;
  }
}

// 旧名の互換（タイピングから呼ばれる）
function playTypeSound(kind = 'type') { playSfx(kind); }

function startTypingHint(words) {
  state.screen = 'typing-hint';
  const list = shuffle(words);
  state.typingHintState = {
    list, index: 0, correct: 0, wrong: 0,
    revealing: false, lastLen: 0
  };
  renderTypingHint();
}

function renderTypingHint() {
  const ts = state.typingHintState;
  if (ts.index >= ts.list.length) { showTypingHintResult(); return; }
  const word = ts.list[ts.index];
  ts.lastLen = 0;
  ts.lastGood = '';
  ts.misTyped = false;

  const currentTyped = ''; // 新しい単語では常に空からスタート

  render(`
    <style>
      .th-wrap {
        position: fixed; inset: 0;
        background: linear-gradient(160deg, #c62828 0%, #e57373 55%, #f48fb1 100%);
        display: flex; flex-direction: column;
        font-family: 'Hiragino Sans','Meiryo',sans-serif;
        overflow: hidden;
      }
      .th-header {
        display: flex; justify-content: space-between; align-items: flex-start;
        padding: 14px 18px 0;
      }
      .th-counter {
        font-size: 2rem; font-weight: 900; color: white;
        text-shadow: 2px 2px 0 rgba(0,0,0,.3);
        font-family: 'Impact','Arial Black',sans-serif; letter-spacing: 2px;
      }
      .th-card {
        background: white; border-radius: 18px;
        margin: 10px 14px 6px; padding: 16px 20px 12px;
        box-shadow: 0 6px 24px rgba(0,0,0,.2); text-align: center;
      }
      .th-word-color {
        font-size: 1.4rem; font-family: 'Courier New',monospace;
        letter-spacing: 4px; margin-bottom: 6px; font-weight: 700;
      }
      .th-word-ja { font-size: 1.4rem; font-weight: 800; color: #1e293b; margin-bottom: 8px; }
      .th-typed-row {
        font-size: 1.1rem; font-family: 'Courier New',monospace;
        letter-spacing: 4px; min-height: 28px; color: #1e293b; font-weight: 700;
      }
      .th-cursor {
        display: inline-block; color: #f97316; font-weight: 900;
        animation: th-blink .7s step-end infinite;
      }
      @keyframes th-blink { 0%,100%{opacity:1} 50%{opacity:0} }
      .th-keyboard { padding: 2px 10px 0; flex: 1; }
      .th-kb-row { display: flex; justify-content: center; gap: 4px; margin-bottom: 4px; }
      .th-key {
        display: flex; align-items: center; justify-content: center;
        background: rgba(255,255,255,.82); border-radius: 7px;
        font-size: .72rem; font-weight: 800; color: #374151;
        box-shadow: 0 3px 0 rgba(0,0,0,.22);
        min-width: 32px; height: 36px; padding: 0 4px;
        transition: background .1s;
      }
      .th-key.next {
        background: linear-gradient(135deg,#fb923c,#f97316);
        color: white; box-shadow: 0 3px 0 rgba(180,70,0,.5);
        transform: translateY(-2px);
      }
      .th-key.typed { background: rgba(255,255,255,.35); color: rgba(255,255,255,.6); }
      .th-input-area { position: absolute; top: -100px; }
      #type-input { position: absolute; opacity: 0; width: 1px; height: 1px; }
      .th-skip {
        background: rgba(255,255,255,.25); border: 2px solid rgba(255,255,255,.5);
        color: white; border-radius: 10px; padding: 7px 12px;
        font-size: .82rem; font-weight: 700; cursor: pointer;
      }
      .th-quit {
        background: transparent; border: none; color: rgba(255,255,255,.7);
        font-size: .8rem; cursor: pointer; padding: 6px 10px;
      }
    </style>
    <div class="th-wrap" onclick="document.getElementById('type-input')?.focus()">
      <div class="th-header">
        <div class="th-counter">${ts.index + 1}/${ts.list.length}</div>
        <div style="display:flex;gap:8px;align-items:center">
          <button class="th-skip" onclick="skipTypingHint()">スキップ</button>
          <button class="th-quit" onclick="showHome()">✕</button>
        </div>
        <div class="th-counter">${ts.correct}</div>
      </div>
      <div class="th-card">
        <div class="th-word-color" id="word-color-area">${buildWordColorHTML(word, currentTyped)}</div>
        <div class="th-word-ja">${word.ja}</div>
        <div class="th-typed-row" id="typed-row-area">${buildTypedRowHTML(word, currentTyped)}</div>
      </div>
      <div class="th-input-area">
        <input id="type-input" type="text"
          autocomplete="off" autocorrect="off" spellcheck="false"
          ${ts.revealing ? 'disabled' : ''}
          oninput="checkTypingHint()" onkeydown="handleTypingHintKey(event)">
      </div>
      <div class="th-keyboard" id="keyboard-area">
        ${buildKeyboardHTML(word, currentTyped)}
      </div>
    </div>
  `);
  setTimeout(() => document.getElementById('type-input')?.focus(), 50);
}

window.checkTypingHint = () => {
  const ts = state.typingHintState;
  if (ts.revealing) return;
  const word = ts.list[ts.index];
  const inp  = document.getElementById('type-input');
  if (!inp) return;
  let raw      = inp.value.trim();
  let val      = raw.toLowerCase();
  const target = word.en.toLowerCase();

  // ❌ 間違った文字は入力させない（直前の正しい状態に戻す）
  if (val && !target.startsWith(val)) {
    playSfx('wrong');
    if (!ts.misTyped) {           // この単語で初めてのミスだけ記録
      ts.misTyped = true;
      ts.wrong++;
      recordWeak(word);
    }
    raw = ts.lastGood || '';
    val = raw.toLowerCase();
    inp.value = raw;
  } else {
    ts.lastGood = raw;            // 正しい途中経過を保存
  }

  // バックスペース（削除）判定
  const isDelete = raw.length < (ts.lastLen || 0);
  ts.lastLen = raw.length;

  // リアルタイムUI更新
  const kbArea        = document.getElementById('keyboard-area');
  const wordColorArea = document.getElementById('word-color-area');
  const typedRowArea  = document.getElementById('typed-row-area');
  if (kbArea)        kbArea.innerHTML        = buildKeyboardHTML(word, raw);
  if (wordColorArea) wordColorArea.innerHTML = buildWordColorHTML(word, raw);
  if (typedRowArea)  typedRowArea.innerHTML  = buildTypedRowHTML(word, raw);

  // 正解
  if (val === target) {
    playTypeSound('correct');
    speakWord(word.en);   // 発音を聞いて定着
    weakCorrect(word);
    bumpDaily();
    ts.correct++;
    inp.disabled = true;
    addPoints(state.student.id, CONFIG.points.typingCorrect); // 即時・待たない
    setTimeout(() => {
      ts.index++;
      ts.revealing = false;
      renderTypingHint();
    }, 350);
    return;
  }

  // バックスペースは無音
  if (isDelete) return;

  // 直前に打った文字が正しいかで音を変える
  const lastIdx = raw.length - 1;
  const wrong = lastIdx >= 0 && raw[lastIdx].toLowerCase() !== (target[lastIdx] || '').toLowerCase();
  playTypeSound(wrong ? 'wrong' : 'type');
};

window.handleTypingHintKey = (e) => {
  if (e.key !== 'Enter') return;
  const ts = state.typingHintState;
  if (ts.revealing) return;
  const word = ts.list[ts.index];
  const val  = document.getElementById('type-input')?.value.trim().toLowerCase();
  if (val === word.en.toLowerCase()) return; // 正解は checkTypingHint 側で処理

  // 不正解 → 正解を表示してから次へ
  ts.wrong++;
  ts.revealing = true;
  recordWeak(word);
  playTypeSound('wrong');

  const wordColorArea = document.getElementById('word-color-area');
  const typedRowArea  = document.getElementById('typed-row-area');
  if (wordColorArea) {
    wordColorArea.innerHTML = word.en.split('')
      .map(ch => `<span style="color:#1e293b">${ch}</span>`).join(' ');
  }
  if (typedRowArea) {
    typedRowArea.innerHTML = `<span style="color:#ef4444;font-weight:800">正解: ${word.en}</span>`;
  }

  setTimeout(() => {
    ts.index++;
    ts.revealing = false;
    renderTypingHint();
  }, 1600);
};

window.skipTypingHint = () => {
  state.typingHintState.index++;
  state.typingHintState.revealing = false;
  renderTypingHint();
};

async function showTypingHintResult() {
  const ts = state.typingHintState;
  const bonus = ts.correct === ts.list.length ? CONFIG.points.typingLesson : 0;
  if (bonus > 0) await addPoints(state.student.id, bonus);
  render(`
    <div class="overlay"></div>
    <div class="score-popup">
      <h2>練習おわり！</h2>
      <div class="big">✏️</div>
      <p>${ts.list.length}問中 <strong>${ts.correct}問</strong> 正解</p>
      ${bonus > 0 ? `<p style="color:var(--accent);font-weight:700">パーフェクトボーナス +${bonus}pt 🎉</p>` : ''}
      <div class="pts-earned">+${ts.correct * CONFIG.points.typingCorrect + bonus} pt</div>
      <p style="color:var(--muted);font-size:.85rem;margin-bottom:20px">合計 ${state.student.points} pt</p>
      <div style="display:flex;gap:10px">
        <button class="btn-secondary" onclick="showLessonSelect('typing-hint')">もう一度</button>
        <button class="btn-primary" onclick="showHome()">ホームへ</button>
      </div>
    </div>
  `);
}

// --- ミニテスト ---
function startQuiz(words) {
  state.screen = 'quiz';
  const list = shuffle(words);
  state.quizState = { list, index: 0, correct: 0, answered: false };
  renderQuiz();
}

function renderQuiz() {
  const qs = state.quizState;
  if (qs.index >= qs.list.length) { clearQuizKeys(); showQuizResult(); return; }
  qs.answered = false;
  const word = qs.list[qs.index];

  // 不正解の選択肢を3つ作る（意味が重複しないように）
  const others = shuffle(qs.list.filter(w => w.ja !== word.ja)).slice(0, 3).map(w => w.ja);
  const choices = shuffle([word.ja, ...others]);
  const pct = Math.round((qs.index / qs.list.length) * 100);
  const attr = s => String(s).replace(/"/g, '&quot;');

  render(`
    ${header()}
    <div class="container" style="max-width:560px">
      <div class="typing-progress">
        <span>${qs.index + 1} / ${qs.list.length}</span>
        <span>✅ ${qs.correct}</span>
      </div>
      <div class="progress-bar" style="margin-bottom:16px">
        <div class="progress-fill" style="width:${pct}%;background:linear-gradient(90deg,#7c3aed,#c026d3)"></div>
      </div>
      <div class="quiz-question">
        <p style="color:var(--muted);margin-bottom:8px">意味は？</p>
        <div class="q-word">${word.en}</div>
      </div>
      <div class="quiz-choices">
        ${choices.map((c, i) => `<button class="choice-btn" data-idx="${i}" data-ja="${attr(c)}" onclick="answerQuiz(this)">
          <span style="display:inline-block;min-width:22px;height:22px;line-height:22px;border-radius:6px;background:#ede9fe;color:#7c3aed;font-size:.8rem;margin-right:8px">${i + 1}</span>${c}</button>`).join('')}
      </div>
      <div id="quiz-feedback" style="text-align:center;font-weight:700;min-height:28px;margin-bottom:12px;font-size:1.05rem"></div>
      <p style="text-align:center;color:var(--muted);font-size:.8rem">キーボードの 1〜4 でも答えられるよ</p>
    </div>
  `);
  setupQuizKeys();
}

function setupQuizKeys() {
  clearQuizKeys();
  window._quizKeys = (e) => {
    const n = parseInt(e.key, 10);
    if (n >= 1 && n <= 4) {
      const b = document.querySelector(`.choice-btn[data-idx="${n - 1}"]`);
      if (b && !b.disabled) b.click();
    }
  };
  document.addEventListener('keydown', window._quizKeys);
}
function clearQuizKeys() {
  if (window._quizKeys) { document.removeEventListener('keydown', window._quizKeys); window._quizKeys = null; }
}

window.answerQuiz = async (btn) => {
  const qs = state.quizState;
  if (qs.answered) return;
  qs.answered = true;
  const word   = qs.list[qs.index];
  const chosen = btn.dataset.ja;
  document.querySelectorAll('.choice-btn').forEach(b => b.disabled = true);
  const fb = document.getElementById('quiz-feedback');
  const isCorrect = chosen === word.ja;

  speakWord(word.en); // 正誤にかかわらず発音を聞く
  if (isCorrect) {
    btn.classList.add('selected-correct');
    fb.textContent = '✨ 正解！';
    fb.style.color = 'var(--success)';
    qs.correct++;
    playSfx('correct');
    weakCorrect(word);
    bumpDaily();
    addPoints(state.student.id, CONFIG.points.quizCorrect);
  } else {
    btn.classList.add('selected-wrong');
    fb.textContent = `❌ 正解は「${word.ja}」`;
    fb.style.color = 'var(--danger)';
    playSfx('wrong');
    recordWeak(word);
    document.querySelectorAll('.choice-btn').forEach(b => {
      if (b.dataset.ja === word.ja) b.classList.add('show-correct');
    });
  }
  setTimeout(() => nextQuiz(), isCorrect ? 900 : 1700);
};

window.nextQuiz = () => {
  clearQuizKeys();
  state.quizState.index++;
  renderQuiz();
};

async function showQuizResult() {
  const qs = state.quizState;
  clearQuizKeys();
  playSfx('win');
  const perfect = qs.correct === qs.list.length;
  const bonus = perfect ? CONFIG.points.quizPerfect : 0;
  if (bonus > 0) await addPoints(state.student.id, bonus);

  render(`
    <div class="overlay"></div>
    <div class="score-popup">
      <h2>テスト終了！</h2>
      <div class="big">${perfect ? '🏆' : '🧠'}</div>
      <p>${qs.list.length}問中 <strong>${qs.correct}問</strong> 正解</p>
      ${perfect ? `<p style="color:var(--accent);font-weight:700">パーフェクト！ +${bonus}pt 🎉</p>` : ''}
      <div class="pts-earned">+${qs.correct * CONFIG.points.quizCorrect + bonus} pt</div>
      <p style="color:var(--muted);font-size:.85rem;margin-bottom:20px">合計 ${state.student.points} pt</p>
      <div style="display:flex;gap:10px">
        <button class="btn-secondary" onclick="showLessonSelect('quiz')">もう一度</button>
        <button class="btn-primary" onclick="showHome()">ホームへ</button>
      </div>
    </div>
  `);
}

// --- ランキング ---
async function showRanking(scope = 'class') {
  state.screen = 'ranking';
  render(`${header()}<div class="container"><p style="color:var(--muted)">読み込み中…</p></div>`);
  let students = await getAllStudents();
  const me = state.student;
  if (scope === 'class' && me) {
    students = students.filter(s => s.grade === me.grade && s.class === me.class);
  }
  const myRank = students.findIndex(s => s.id === me?.id) + 1;
  const tabBtn = (sc, label) => `<button class="btn-${scope === sc ? 'primary' : 'secondary'} btn-sm" onclick="showRanking('${sc}')">${label}</button>`;

  render(`
    ${header()}
    <div class="container">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
        <h2>🏆 ランキング</h2>
        <button class="btn-secondary btn-sm" onclick="showHome()">← 戻る</button>
      </div>
      <div style="display:flex;gap:8px;margin-bottom:14px">
        ${tabBtn('class', `👥 ${me ? me.grade + ' ' + me.class : 'クラス'}内`)}
        ${tabBtn('all', '🌏 全体')}
      </div>
      ${myRank > 0 ? `<p style="margin-bottom:12px;color:var(--primary);font-weight:600">あなたは ${myRank} 位！</p>` : ''}
      <div class="card" style="padding:0;overflow:hidden">
        <table class="ranking-table">
          <thead><tr><th>順位</th><th>名前</th><th>ランク</th><th>ポイント</th></tr></thead>
          <tbody>
            ${students.map((s, i) => {
              const rank = getRank(s.points);
              const isMe = s.id === state.student?.id;
              return `<tr style="${isMe ? 'background:#eff6ff !important;font-weight:700' : ''}">
                <td class="rank-no">${i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}`}</td>
                <td>${s.name}${isMe ? ' 👈' : ''}</td>
                <td>${rank.emoji} ${rank.name}</td>
                <td>${s.points} pt</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `);
}

// ===== ワードシューター（1問ずつ方式・西部劇テーマ） =====
const SHOOTER_LIVES        = 3;
const SHOOTER_TOTAL_TARGETS = 12; // 画面に並ぶ的の総数（3列×4行）
const SHOOTER_COLS         = 3;
const TARGET_COLORS = ['#fbbf24','#f87171','#34d399','#60a5fa','#a78bfa','#f472b6','#fb923c','#4ade80'];

function startShooter(words) {
  state.screen = 'shooter';
  if (words.length < 3) { toast('単語が3語以上必要です'); showHome(); return; }
  state.shooterState = {
    words: shuffle([...words]),
    wordIndex: 0,       // 現在の問題インデックス
    answered: 0,        // 正解した数
    score: 0,
    lives: SHOOTER_LIVES,
    hits: 0,
    misses: 0,
    noMiss: true,
    running: true,
    targets: [],
    _interval: null,
    timeLeft: 90,
  };
  buildShooterUI();
  buildShooterTargets();
  startShooterTimer();
}

function buildShooterUI() {
  // 西部劇フルスクリーンUI
  app.innerHTML = `
    <div id="sh-wrap" style="
      position:fixed;inset:0;overflow:hidden;user-select:none;cursor:crosshair;
      background:linear-gradient(180deg,
        #87CEEB 0%, #87CEEB 30%,
        #E8A44A 30%, #E8A44A 55%,
        #C8873A 55%, #C8873A 70%,
        #8B5E3C 70%, #8B5E3C 100%
      );
    ">
      <!-- 空の雲 -->
      <div style="position:absolute;top:4%;left:8%;font-size:2.5rem;opacity:.7;pointer-events:none">☁️</div>
      <div style="position:absolute;top:6%;left:55%;font-size:3rem;opacity:.6;pointer-events:none">☁️</div>
      <div style="position:absolute;top:2%;left:30%;font-size:2rem;opacity:.5;pointer-events:none">☁️</div>
      <!-- 太陽 -->
      <div style="position:absolute;top:3%;right:12%;font-size:3rem;pointer-events:none">☀️</div>
      <!-- サボテン -->
      <div style="position:absolute;bottom:2%;left:3%;font-size:3rem;pointer-events:none;z-index:2">🌵</div>
      <div style="position:absolute;bottom:2%;right:3%;font-size:3.5rem;pointer-events:none;z-index:2">🌵</div>
      <div style="position:absolute;bottom:2%;left:18%;font-size:2rem;pointer-events:none;z-index:2">🌵</div>
      <!-- 小屋 -->
      <div style="position:absolute;bottom:5%;left:40%;font-size:4rem;pointer-events:none">🏚️</div>

      <!-- HUD -->
      <div style="position:absolute;top:0;left:0;right:0;z-index:30;
        background:linear-gradient(180deg,rgba(0,0,0,.65),transparent);
        padding:10px 16px 18px;display:flex;align-items:center;justify-content:space-between">
        <div style="display:flex;align-items:center;gap:10px">
          <div id="sh-lives" style="font-size:1.3rem"></div>
          <div id="sh-score" style="color:#fbbf24;font-weight:900;font-size:1.2rem;
            text-shadow:0 0 8px #fbbf24;font-family:monospace">0</div>
        </div>
        <div style="text-align:center">
          <div id="sh-progress" style="color:#fde68a;font-size:.8rem;font-weight:700;letter-spacing:1px"></div>
          <div id="sh-timer" style="font-size:1.8rem;font-weight:900;color:white;
            text-shadow:0 2px 6px rgba(0,0,0,.6);min-width:44px"></div>
        </div>
        <button onclick="stopShooter()" style="background:rgba(255,255,255,.2);color:white;
          border:2px solid rgba(255,255,255,.3);border-radius:8px;padding:6px 14px;
          font-size:.85rem;cursor:pointer">終了</button>
      </div>

      <!-- お題バナー -->
      <div style="position:absolute;top:62px;left:0;right:0;z-index:30;text-align:center;pointer-events:none">
        <div style="display:inline-block;
          background:linear-gradient(135deg,#92400e,#b45309);
          border:3px solid #fbbf24;border-radius:12px;padding:8px 28px;
          box-shadow:0 4px 16px rgba(0,0,0,.4)">
          <div style="font-size:.72rem;color:#fde68a;letter-spacing:2px;margin-bottom:2px">🤠 この意味の英単語を撃て！</div>
          <div id="sh-target" style="font-size:1.6rem;font-weight:900;color:white;
            text-shadow:0 2px 4px rgba(0,0,0,.5)"></div>
        </div>
      </div>

      <!-- 的フィールド -->
      <div id="sh-field" style="position:absolute;inset:0;z-index:10"></div>

      <!-- エフェクト層 -->
      <div id="sh-fx" style="position:absolute;inset:0;pointer-events:none;z-index:40"></div>

      <!-- 照準 -->
      <div id="sh-crosshair" style="position:fixed;width:44px;height:44px;pointer-events:none;
        z-index:50;transform:translate(-50%,-50%);display:none">
        <svg viewBox='0 0 44 44' fill='none' xmlns='http://www.w3.org/2000/svg'>
          <circle cx='22' cy='22' r='10' stroke='white' stroke-width='2.5' stroke-dasharray='4 2'/>
          <circle cx='22' cy='22' r='3' fill='white'/>
          <line x1='22' y1='2' x2='22' y2='10' stroke='white' stroke-width='2.5' stroke-linecap='round'/>
          <line x1='22' y1='34' x2='22' y2='42' stroke='white' stroke-width='2.5' stroke-linecap='round'/>
          <line x1='2' y1='22' x2='10' y2='22' stroke='white' stroke-width='2.5' stroke-linecap='round'/>
          <line x1='34' y1='22' x2='42' y2='22' stroke='white' stroke-width='2.5' stroke-linecap='round'/>
        </svg>
      </div>
    </div>
  `;

  // 照準追従
  const crosshair = document.getElementById('sh-crosshair');
  document.getElementById('sh-wrap').addEventListener('mousemove', e => {
    crosshair.style.display = 'block';
    crosshair.style.left = e.clientX + 'px';
    crosshair.style.top  = e.clientY + 'px';
  });
}

// 的を全部配置（ゲーム開始時のみ呼ぶ）
function buildShooterTargets() {
  const ss    = state.shooterState;
  const field = document.getElementById('sh-field');
  if (!field) return;
  field.innerHTML = '';
  ss.targets = [];

  const W = window.innerWidth;
  const H = window.innerHeight;
  const topOff = 148, botOff = 55;
  const availH = H - topOff - botOff;
  const total  = SHOOTER_TOTAL_TARGETS;
  const cols   = SHOOTER_COLS;
  const rows   = Math.ceil(total / cols);
  const cellW  = W / cols;
  const cellH  = availH / rows;
  const animals = ['🐄','🐔','🐷','🐎','🐑','🦆','🐇','🦎','🐓','🐑','🦌','🐂'];

  for (let idx = 0; idx < total; idx++) {
    const col = idx % cols;
    const row = Math.floor(idx / cols);
    const cx  = Math.max(60, Math.min(W - 60, cellW * col + cellW / 2));
    const cy  = Math.max(topOff + 30, Math.min(H - botOff - 40, topOff + cellH * row + cellH / 2));
    const emoji = animals[idx % animals.length];

    const wrap = document.createElement('div');
    wrap.style.cssText = `position:absolute;left:${cx}px;top:${cy}px;transform:translate(-50%,-50%);
      text-align:center;cursor:crosshair;z-index:10;
      animation:shTargetIn .3s ${idx * 40}ms both cubic-bezier(.34,1.56,.64,1);`;

    const animalEl = document.createElement('div');
    animalEl.style.cssText = `font-size:2rem;line-height:1;pointer-events:none;`;
    animalEl.textContent = emoji;

    const plate = document.createElement('div');
    plate.style.cssText = `background:linear-gradient(135deg,#fef3c7,#fde68a);
      border:2.5px solid #92400e;border-radius:8px;padding:5px 10px;
      font-weight:900;font-size:.88rem;color:#78350f;
      box-shadow:2px 3px 8px rgba(0,0,0,.4);white-space:nowrap;min-width:68px;`;

    wrap.appendChild(animalEl);
    wrap.appendChild(plate);

    const t = { el: wrap, plate, alive: true, wordEn: '' };

    let touched = false;
    wrap.addEventListener('touchstart', e => {
      e.preventDefault(); e.stopPropagation();
      touched = true;
      hitShooterTarget(t, e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: false });
    wrap.addEventListener('click', e => {
      e.stopPropagation();
      if (touched) { touched = false; return; }
      hitShooterTarget(t, e.clientX, e.clientY);
    });

    field.appendChild(wrap);
    ss.targets.push(t);
  }

  assignShooterWords(); // 各的に単語を割り当て
  updateShooterQuestion(); // お題表示
}

// 的に単語を割り当てる（正解1つ＋デコイ）
function assignShooterWords() {
  const ss = state.shooterState;
  if (!ss.running || ss.wordIndex >= ss.words.length) return;

  const currentWord = ss.words[ss.wordIndex];
  const wrongs = shuffle(ss.words.filter(w => w.en !== currentWord.en));
  const pool = [currentWord, ...wrongs];

  // 各的にシャッフルして単語を割り当て（正解が必ず1つ含まれる）
  const assignments = shuffle([
    currentWord,
    ...Array.from({ length: SHOOTER_TOTAL_TARGETS - 1 }, (_, i) =>
      wrongs[i % Math.max(1, wrongs.length)]
    )
  ]);

  ss.targets.forEach((t, i) => {
    t.wordEn = assignments[i] ? assignments[i].en : wrongs[0].en;
    t.plate.textContent = t.wordEn;
    t.alive = true;
    t.el.style.opacity = '1';
    t.el.style.pointerEvents = 'auto';
  });
}

// お題（日本語）を更新
function updateShooterQuestion() {
  const ss = state.shooterState;
  if (!ss.running) return;
  const currentWord = ss.words[ss.wordIndex];
  const targetEl   = document.getElementById('sh-target');
  const progressEl = document.getElementById('sh-progress');
  if (targetEl) {
    targetEl.style.animation = 'none';
    targetEl.offsetHeight;
    targetEl.textContent = currentWord.ja;
    targetEl.style.animation = 'shTargetPop .3s ease';
  }
  if (progressEl) progressEl.textContent = `${ss.answered + 1} / ${ss.words.length}`;
}

function hitShooterTarget(targetObj, cx, cy) {
  const ss = state.shooterState;
  if (!ss || !ss.running || !targetObj.alive) return;

  const currentWord = ss.words[ss.wordIndex];
  if (!currentWord) return;
  const isCorrect = targetObj.wordEn === currentWord.en;

  if (isCorrect) {
    targetObj.alive = false;
    targetObj.el.style.pointerEvents = 'none';
    targetObj.el.style.opacity = '0.3';
    ss.hits++;
    ss.answered++;
    ss.score += 100;
    bumpDaily();
    playSfx('hit');
    showShooterFX(cx, cy, true, '✓ ' + currentWord.en);
    updateShooterHUD();

    // 全問終了？
    if (ss.answered >= ss.words.length) {
      setTimeout(() => endShooter(), 800);
      return;
    }

    // 次の問題へ
    ss.wordIndex++;
    // 次の正解単語を各的に再割り当て
    assignShooterWords();
    updateShooterQuestion();
  } else {
    ss.misses++;
    ss.noMiss = false;
    ss.lives--;
    playSfx('miss');
    showShooterFX(cx, cy, false, 'MISS!');
    updateShooterHUD();
    const wrap = document.getElementById('sh-wrap');
    if (wrap) { wrap.style.outline = '8px solid #ef4444'; setTimeout(() => { if (wrap) wrap.style.outline = 'none'; }, 300); }
    if (ss.lives <= 0) setTimeout(() => endShooter(), 500);
  }
}

function showShooterFX(x, y, success, label) {
  const layer = document.getElementById('sh-fx');
  if (!layer) return;

  // 爆発リング
  const ring = document.createElement('div');
  ring.style.cssText = `
    position:absolute;left:${x-30}px;top:${y-30}px;
    width:60px;height:60px;border-radius:50%;
    border:4px solid ${success ? '#fbbf24' : '#ef4444'};
    animation:shRing .4s forwards;pointer-events:none;
  `;
  layer.appendChild(ring);
  setTimeout(() => ring.remove(), 400);

  // スコアポップアップ
  const txt = document.createElement('div');
  txt.textContent = label;
  txt.style.cssText = `
    position:absolute;left:${x}px;top:${y - 20}px;
    transform:translateX(-50%);
    font-size:1.4rem;font-weight:900;
    color:${success ? '#fbbf24' : '#ef4444'};
    text-shadow:0 2px 6px rgba(0,0,0,.8);
    animation:shScore .7s forwards;pointer-events:none;
  `;
  layer.appendChild(txt);
  setTimeout(() => txt.remove(), 700);

  // パーティクル（正解時）
  if (success) {
    for (let i = 0; i < 8; i++) {
      const p = document.createElement('div');
      const angle = (i / 8) * Math.PI * 2;
      const dist  = 40 + Math.random() * 30;
      const tx = Math.cos(angle) * dist;
      const ty = Math.sin(angle) * dist;
      p.style.cssText = `
        position:absolute;left:${x}px;top:${y}px;
        width:8px;height:8px;border-radius:50%;
        background:${TARGET_COLORS[i % TARGET_COLORS.length]};
        animation:shParticle .5s forwards;
        --tx:${tx}px;--ty:${ty}px;
        pointer-events:none;
      `;
      layer.appendChild(p);
      setTimeout(() => p.remove(), 500);
    }
  }
}

function updateShooterHUD() {
  const ss = state.shooterState;
  const livesEl = document.getElementById('sh-lives');
  const scoreEl = document.getElementById('sh-score');
  if (livesEl) livesEl.textContent = '❤️'.repeat(ss.lives) + '🖤'.repeat(Math.max(0, SHOOTER_LIVES - ss.lives));
  if (scoreEl) scoreEl.textContent = ss.score.toLocaleString();
}

function startShooterTimer() {
  const ss = state.shooterState;
  const el = document.getElementById('sh-timer');
  if (el) el.textContent = ss.timeLeft;
  const interval = setInterval(() => {
    if (!state.shooterState?.running) { clearInterval(interval); return; }
    state.shooterState.timeLeft--;
    const el = document.getElementById('sh-timer');
    if (el) {
      el.textContent = state.shooterState.timeLeft;
      el.style.color = state.shooterState.timeLeft <= 10 ? '#ef4444' : 'white';
      if (state.shooterState.timeLeft <= 10) el.style.animation = 'shTimerPulse 1s infinite';
    }
    if (state.shooterState.timeLeft <= 0) { clearInterval(interval); endShooter(); }
  }, 1000);
  state.shooterState._interval = interval;
}

window.stopShooter = () => { if (confirm('ゲームを終了しますか？')) endShooter(); };

async function endShooter() {
  const ss = state.shooterState;
  if (!ss) return;
  ss.running = false;
  if (ss._interval) clearInterval(ss._interval);

  const bonus = ss.noMiss ? CONFIG.points.shooterBonus * 10 : 0;
  const pts   = Math.floor(ss.score / 10) + bonus;
  if (pts > 0) await addPoints(state.student.id, pts);

  render(`
    <div class="overlay"></div>
    <div class="score-popup">
      <h2>ゲーム終了！</h2>
      <div class="big">🎯</div>
      <p>正解 <strong>${ss.answered}</strong> 問 ／ ミス <strong>${ss.misses}</strong> 回</p>
      ${bonus > 0 ? `<p style="color:var(--accent);font-weight:700">ノーミスボーナス +${bonus}pt 🎉</p>` : ''}
      <div class="pts-earned">+${pts} pt</div>
      <p style="color:var(--muted);font-size:.85rem;margin-bottom:20px">合計 ${state.student.points} pt</p>
      <div style="display:flex;gap:10px">
        <button class="btn-secondary" onclick="showLessonSelect('shooter')">もう一度</button>
        <button class="btn-primary" onclick="showHome()">ホームへ</button>
      </div>
    </div>
  `);
}

// ===== 神経衰弱（全カード表示・タイムアタック） =====
const MEMORY_PAIRS = 8;

function startMemory(words) {
  state.screen = 'memory';
  const pairCount = Math.min(MEMORY_PAIRS, words.length);
  const selected = shuffle(words).slice(0, pairCount);

  const enCards = selected.map((w, i) => ({ id: `en-${i}`, pairId: i, type: 'en', text: w.en }));
  const jaCards = selected.map((w, i) => ({ id: `ja-${i}`, pairId: i, type: 'ja', text: w.ja }));

  state.memoryState = {
    allCards: shuffle([...enCards, ...jaCards]), // 英語・日本語を混ぜてシャッフル
    enCards,
    jaCards,
    matched: new Set(),
    selected: null,
    misses: 0,
    locked: false,
    wrongPair: null,
    startTime: Date.now(),
    timerInterval: null,
    lesson: selectedLessons.join('+'),
  };

  // タイマー開始
  state.memoryState.timerInterval = setInterval(() => {
    const el = document.getElementById('mem-timer');
    if (el) el.textContent = formatMemTime(Date.now() - state.memoryState.startTime);
  }, 100);

  renderMemory();
}

function formatMemTime(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const ss = (s % 60).toString().padStart(2, '0');
  const dec = Math.floor((ms % 1000) / 100);
  return `${m}:${ss}.${dec}`;
}

function renderMemory() {
  const ms = state.memoryState;
  const total   = ms.enCards.length;
  const matched = ms.matched.size;
  const pct     = Math.round((matched / total) * 100);

  const cardStyle = (card) => {
    const isMatched  = ms.matched.has(card.pairId);
    const isSelected = ms.selected === card.id;
    const isWrong    = ms.wrongPair && ms.wrongPair.includes(card.id);
    if (isMatched)  return `background:#f0fdf4;border-color:#86efac;color:#15803d;opacity:.45;cursor:default;pointer-events:none;`;
    if (isWrong)    return `background:#fef2f2;border-color:#f87171;color:#b91c1c;transform:scale(1.02);box-shadow:0 4px 16px rgba(248,113,113,.4);`;
    if (isSelected) return `background:#dbeafe;border-color:#3b82f6;color:#1d4ed8;transform:scale(1.04);box-shadow:0 4px 18px rgba(59,130,246,.35);`;
    return `background:white;border-color:#e2e8f0;color:var(--text);cursor:pointer;`;
  };

  render(`
    ${header()}
    <div class="container" style="max-width:860px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;flex-wrap:wrap;gap:8px">
        <h2 style="color:#0891b2">🎴 神経衰弱</h2>
        <div style="display:flex;gap:14px;align-items:center">
          <span style="font-size:1.3rem;font-weight:800;color:#0891b2;font-variant-numeric:tabular-nums" id="mem-timer">0:00.0</span>
          <span style="font-size:.9rem;color:var(--muted)">✅ ${matched}/${total}</span>
          <span style="font-size:.9rem;color:#ef4444">❌ ${ms.misses}</span>
        </div>
      </div>
      <div class="progress-bar" style="margin-bottom:14px">
        <div class="progress-fill" style="width:${pct}%;background:linear-gradient(90deg,#0891b2,#06b6d4)"></div>
      </div>

      <!-- 英語・日本語混合グリッド -->
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px">
        ${ms.allCards.map(card => `
          <div onclick="selectMemCard('${card.id}')"
            style="padding:16px 10px;border-radius:14px;border:2px solid;text-align:center;
              font-weight:700;font-size:${card.type==='en' ? '1rem' : '.9rem'};
              transition:all .15s;min-height:80px;
              display:flex;align-items:center;justify-content:center;
              ${cardStyle(card)}">
            ${card.text}
          </div>
        `).join('')}
      </div>

      <div style="text-align:center;margin-top:14px">
        <button class="btn-secondary btn-sm" onclick="quitMemory()">やめる</button>
      </div>
    </div>
  `);
}

window.quitMemory = () => {
  if (state.memoryState?.timerInterval) clearInterval(state.memoryState.timerInterval);
  showHome();
};

window.selectMemCard = (cardId) => {
  const ms = state.memoryState;
  if (ms.locked) return; // ミス表示中は操作不可
  const allCards = ms.allCards;
  const card = allCards.find(c => c.id === cardId);
  if (!card || ms.matched.has(card.pairId)) return;

  if (!ms.selected) {
    // 1枚目を選択
    ms.selected = cardId;
    playSfx('select');
    renderMemory();
    return;
  }

  if (ms.selected === cardId) {
    // 同じカードをタップ→選択解除
    ms.selected = null;
    renderMemory();
    return;
  }

  const first = allCards.find(c => c.id === ms.selected);
  // 同じ種類（英語同士・日本語同士）は選び直し
  if (first.type === card.type) {
    ms.selected = cardId;
    playSfx('select');
    renderMemory();
    return;
  }

  if (first.pairId === card.pairId) {
    // マッチ！
    ms.matched.add(card.pairId);
    ms.selected = null;
    bumpDaily();
    playSfx('match');
    renderMemory();
    if (ms.matched.size === ms.enCards.length) {
      // 全ペア完成
      clearInterval(ms.timerInterval);
      const timeMs = Date.now() - ms.startTime;
      setTimeout(() => showMemoryResult(timeMs), 450);
    }
  } else {
    // ミス → 両方を赤く見せてから戻す
    ms.misses++;
    ms.wrongPair = [ms.selected, cardId];
    ms.selected = null;
    ms.locked = true;
    playSfx('wrong');
    renderMemory();
    setTimeout(() => {
      ms.wrongPair = null;
      ms.locked = false;
      renderMemory();
    }, 650);
  }
};

async function showMemoryResult(timeMs) {
  const ms      = state.memoryState;
  const total   = ms.enCards.length;
  const timeStr = formatMemTime(timeMs);
  const timeSec = timeMs / 1000;
  const s       = state.student;
  playSfx('win');

  // まず結果画面を即表示（ローディング中）
  render(`
    ${header()}
    <div class="container" style="max-width:520px;padding-top:32px;text-align:center">
      <div style="font-size:3rem">🎴</div>
      <p style="color:var(--muted);margin-top:12px">記録を保存中…</p>
    </div>
  `);

  // Firestoreに記録を保存・ポイント付与（エラーが出ても画面が止まらないようtry/catch）
  const pts = CONFIG.points.memoryComplete + Math.max(0, total * CONFIG.points.memoryMatch - ms.misses * 2);
  let allRecords = [];
  try {
    await F.addDoc(F.collection(db, 'memoryRecords'), {
      studentId: s.id,
      name: s.name,
      grade: s.grade,
      class: s.class,
      lesson: ms.lesson,
      timeSec,
      misses: ms.misses,
      createdAt: Date.now(),
    });
    await addPoints(state.student.id, pts);

    // ランキング取得（全体 - フィルタなし、全学年・全組・全レッスン）
    const snap = await F.getDocs(F.collection(db, 'memoryRecords'));
    allRecords = snap.docs.map(d => d.data());
  } catch(e) {
    // エラー内容を結果画面に一時表示して原因特定
    render(`
      ${header()}
      <div class="container" style="max-width:520px">
        <div class="card" style="border-left:4px solid #ef4444">
          <h3 style="color:#ef4444">保存エラー（先生に見せてください）</h3>
          <p style="font-family:monospace;font-size:.8rem;background:#f1f5f9;padding:12px;border-radius:8px;word-break:break-all">${e?.message || String(e)}</p>
          <div style="margin-top:16px;background:#ecfdf5;border-radius:8px;padding:12px">
            <p style="font-size:.9rem;color:#065f46">タイム: <strong>${timeStr}</strong>　ミス: <strong>${ms.misses}回</strong>　+${pts}pt</p>
          </div>
          <div style="display:flex;gap:10px;margin-top:16px">
            <button class="btn-secondary" style="flex:1" onclick="showLessonSelect('memory')">もう一度</button>
            <button class="btn-primary" style="flex:1" onclick="showHome()">ホームへ</button>
          </div>
        </div>
      </div>
    `);
    return;
  }

  // 生徒ごとに最速タイムだけ残す
  const bestMap = {};
  allRecords.forEach(r => {
    if (!bestMap[r.studentId] || r.timeSec < bestMap[r.studentId].timeSec) {
      bestMap[r.studentId] = r;
    }
  });
  const records = Object.values(bestMap).sort((a, b) => a.timeSec - b.timeSec);

  // 自分の順位
  const myRank = records.findIndex(r => r.studentId === s.id) + 1;
  const isNewRecord = myRank === 1;

  render(`
    ${header()}
    <div class="container" style="max-width:520px">

      <!-- タイム結果カード -->
      <div style="background:linear-gradient(135deg,#ecfdf5,#d1fae5);border-radius:20px;
        padding:32px 24px;text-align:center;margin-bottom:20px;box-shadow:var(--shadow)">
        <div style="font-size:3.5rem;margin-bottom:4px">🎴</div>
        <h2 style="color:#059669;font-size:1.6rem;margin-bottom:16px">全部マッチ！クリア！</h2>

        <!-- タイム大きく -->
        <div style="background:white;border-radius:16px;padding:16px 24px;margin-bottom:12px;
          box-shadow:0 2px 12px rgba(8,145,178,.15)">
          <div style="font-size:.8rem;color:var(--muted);letter-spacing:2px;margin-bottom:4px">YOUR TIME</div>
          <div style="font-size:3rem;font-weight:900;color:#0891b2;
            font-variant-numeric:tabular-nums;letter-spacing:2px">${timeStr}</div>
          <div style="font-size:.9rem;color:var(--muted);margin-top:4px">ミス ${ms.misses} 回</div>
        </div>

        ${isNewRecord
          ? `<div style="font-size:1.2rem;font-weight:800;color:#f59e0b;margin-bottom:8px">🥇 このクラスで1位！</div>`
          : `<div style="font-size:1rem;color:var(--muted);margin-bottom:8px">${myRank} 位 / ${records.length} 人中</div>`
        }
        <div style="font-size:1.8rem;font-weight:800;color:var(--accent)">+${pts} pt</div>
      </div>

      <!-- タイムランキング -->
      <div class="card" style="padding:0;overflow:hidden;margin-bottom:20px">
        <div style="background:#0891b2;color:white;padding:12px 16px;font-weight:700;font-size:1rem">
          ⏱️ 神経衰弱 タイムランキング TOP10（全体）
        </div>
        <table class="ranking-table">
          <thead>
            <tr><th>順位</th><th>名前</th><th>学年・組</th><th>レッスン</th><th>タイム</th><th>ミス</th></tr>
          </thead>
          <tbody>
            ${records.slice(0, 10).map((r, i) => {
              const isMe = r.studentId === s.id;
              return `<tr style="${isMe ? 'background:#e0f2fe !important;font-weight:700' : ''}">
                <td class="rank-no">${i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}`}</td>
                <td>${r.name}${isMe ? ' 👈' : ''}</td>
                <td style="font-size:.75rem;color:var(--muted)">${r.grade || ''} ${r.class || ''}</td>
                <td style="font-size:.75rem;color:var(--muted)">${r.lesson || ''}</td>
                <td style="font-variant-numeric:tabular-nums;font-weight:600;color:#0891b2">
                  ${formatMemTime(r.timeSec * 1000)}</td>
                <td style="color:${r.misses === 0 ? 'var(--success)' : 'var(--muted)'}">
                  ${r.misses === 0 ? '✨ 0' : r.misses}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>

      <div style="display:flex;gap:10px">
        <button class="btn-secondary" style="flex:1" onclick="showLessonSelect('memory')">もう一度</button>
        <button class="btn-primary" style="flex:1" onclick="showHome()">ホームへ</button>
      </div>
    </div>
  `);
}

// ===== POP ゲーム =====
const POP_COUNT = 3; // POPカードの枚数

// --- プレイヤー設定画面 ---
function showPOPSetup(words) {
  state.screen = 'pop';
  state.popWords = words;
  render(`
    ${header()}
    <div class="container" style="max-width:520px">
      <div class="card">
        <h2 style="color:#e11d48;margin-bottom:4px">🃏 POP ゲーム</h2>
        <p style="color:var(--muted);margin-bottom:20px">プレイヤーの名前を入力してね（2〜5人）</p>
        <div id="player-inputs">
          ${[1,2,3,4,5].map(i => `
            <div class="form-group" style="margin-bottom:12px">
              <label>プレイヤー ${i} ${i <= 2 ? '（必須）' : '（任意）'}</label>
              <input type="text" id="player-${i}" placeholder="${i <= 2 ? '名前を入力' : '参加しない場合は空欄'}" maxlength="10">
            </div>
          `).join('')}
        </div>
        <div class="note" style="background:#fff1f2;border-color:#e11d48;margin-bottom:16px">
          <p style="color:#9f1239;font-size:.85rem">
            📌 ルール：<br>
            ① カードを1枚引いて単語を読む<br>
            ② 読めたら自分のカードに。読めなかったら「練習カード」へ<br>
            ③ 💥POPカードを引いたら手持ちカードを全部没収！<br>
            ④ 山札がなくなったら終了。一番多くカードを持っている人の勝ち！
          </p>
        </div>
        <div style="display:flex;gap:10px">
          <button class="btn-secondary" style="flex:1" onclick="showLessonSelect('pop')">← 戻る</button>
          <button class="btn-primary" style="flex:2" onclick="startPOP()">ゲームスタート！🃏</button>
        </div>
        <p id="pop-setup-error" style="color:#ef4444;margin-top:10px;font-size:.9rem;min-height:18px"></p>
      </div>
    </div>
  `);
}

window.startPOP = () => {
  const players = [];
  for (let i = 1; i <= 5; i++) {
    const val = document.getElementById(`player-${i}`)?.value.trim();
    if (val) players.push({ name: val, cards: [], canRead: 0 });
  }
  if (players.length < 2) {
    document.getElementById('pop-setup-error').textContent = '2人以上の名前を入力してください';
    return;
  }

  // デッキ作成：単語カード＋POPカード
  const wordCards = shuffle(state.popWords).map(w => ({ type: 'word', en: w.en, ja: w.ja }));
  const popCards  = Array.from({ length: POP_COUNT }, () => ({ type: 'pop' }));
  const deck = shuffle([...wordCards, ...popCards]);

  state.popState = {
    deck,
    players,
    currentPlayer: 0,
    practiceCards: [],   // 読めなかったカード
    drawnCard: null,
    phase: 'draw',       // draw | reveal | result
  };
  renderPOP();
};

// --- メインゲーム画面 ---
function renderPOP() {
  const ps = state.popState;
  const player = ps.players[ps.currentPlayer];
  const remaining = ps.deck.length;
  const totalCards = ps.players.reduce((s, p) => s + p.cards.length, 0);

  render(`
    ${header()}
    <div class="container" style="max-width:560px">
      <!-- スコアボード -->
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px">
        ${ps.players.map((p, i) => `
          <div style="background:${i === ps.currentPlayer ? '#fef3c7' : 'white'};border:2px solid ${i === ps.currentPlayer ? '#f59e0b' : '#e2e8f0'};
            border-radius:10px;padding:8px 14px;flex:1;min-width:80px;text-align:center">
            <div style="font-size:.8rem;color:var(--muted)">${p.name}</div>
            <div style="font-weight:800;font-size:1.1rem;color:${i === ps.currentPlayer ? '#d97706' : 'var(--text)'}">🃏 ${p.cards.length}枚</div>
          </div>
        `).join('')}
      </div>

      <!-- 山札情報 -->
      <div style="text-align:center;margin-bottom:12px;color:var(--muted);font-size:.9rem">
        山札残り <strong>${remaining}</strong> 枚
        ${ps.practiceCards.length > 0 ? ` ／ 練習カード ${ps.practiceCards.length}枚` : ''}
      </div>

      <!-- カードエリア -->
      <div style="background:linear-gradient(135deg,#fdf2f8,#fce7f3);border-radius:20px;padding:32px 20px;text-align:center;margin-bottom:20px;min-height:180px;display:flex;align-items:center;justify-content:center;flex-direction:column">
        ${ps.phase === 'draw' ? `
          <p style="font-size:1.1rem;font-weight:700;margin-bottom:16px;color:#be185d">
            ${player.name} さんの番！
          </p>
          <div style="font-size:5rem;margin-bottom:8px">🂠</div>
          <button class="btn-primary" style="background:linear-gradient(135deg,#e11d48,#be123c);font-size:1.1rem;padding:14px 32px" onclick="drawCard()">
            カードを引く！
          </button>
        ` : ps.drawnCard.type === 'pop' ? `
          <div style="font-size:4rem;animation:popIn .4s cubic-bezier(.34,1.56,.64,1)">💥</div>
          <div style="font-size:2rem;font-weight:900;color:#e11d48;margin:8px 0">POP！！</div>
          <p style="color:#be185d;font-weight:600;margin-bottom:16px">${player.name} さんの手持ちカードが没収！</p>
          <button class="btn-primary" style="background:linear-gradient(135deg,#e11d48,#be123c)" onclick="resolvePOP()">OK</button>
        ` : `
          <p style="color:var(--muted);margin-bottom:8px;font-size:.9rem">${player.name} さんが引いたカード</p>
          <div style="font-size:2.6rem;font-weight:900;letter-spacing:2px;color:#1e293b;margin-bottom:20px">${ps.drawnCard.en}</div>
          <p style="color:#be185d;font-size:.9rem;margin-bottom:16px">読めるか確認してから発音を聞いてみよう！</p>
          <button onclick="speakWord('${ps.drawnCard.en.replace(/'/g,"\\\'")}')"
            style="background:linear-gradient(135deg,#6366f1,#4f46e5);color:white;border:none;border-radius:12px;
            padding:12px 28px;font-size:1rem;font-weight:700;cursor:pointer;margin-bottom:20px;display:block;margin-left:auto;margin-right:auto">
            🔊 正解の発音
          </button>
          <div style="display:flex;gap:12px;justify-content:center">
            <button class="btn-success" style="font-size:1rem;padding:12px 24px" onclick="cardResult(true)">✅ 読めた！</button>
            <button class="btn-danger"  style="font-size:1rem;padding:12px 24px" onclick="cardResult(false)">❌ 読めなかった</button>
          </div>
        `}
      </div>

      <button class="btn-secondary btn-sm" onclick="if(confirm('ゲームを終了しますか？'))showPOPResult()">ゲームを終わらせる</button>
    </div>
  `);
}

window.speakWord = (word) => {
  if (window._sfxMuted) return;
  if (!window.speechSynthesis) { toast('このブラウザは音声未対応です'); return; }
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(word);
  utter.lang = 'en-US';
  utter.rate = 0.85;
  window.speechSynthesis.speak(utter);
};

window.drawCard = () => {
  const ps = state.popState;
  if (ps.deck.length === 0) { showPOPResult(); return; }
  ps.drawnCard = ps.deck.pop();
  ps.phase = 'reveal';
  playSfx(ps.drawnCard.type === 'pop' ? 'pop' : 'select');
  renderPOP();
};

window.cardResult = (canRead) => {
  const ps = state.popState;
  const player = ps.players[ps.currentPlayer];
  if (canRead) {
    player.cards.push(ps.drawnCard);
    player.canRead++;
  } else {
    ps.practiceCards.push(ps.drawnCard);
  }
  ps.drawnCard = null;
  ps.phase = 'draw';
  // 次のプレイヤーへ
  ps.currentPlayer = (ps.currentPlayer + 1) % ps.players.length;
  if (ps.deck.length === 0) { showPOPResult(); return; }
  renderPOP();
};

window.resolvePOP = () => {
  const ps = state.popState;
  const player = ps.players[ps.currentPlayer];
  // 手持ちカードを山札に戻してシャッフル
  ps.deck = shuffle([...ps.deck, ...player.cards]);
  player.cards = [];
  ps.drawnCard = null;
  ps.phase = 'draw';
  ps.currentPlayer = (ps.currentPlayer + 1) % ps.players.length;
  if (ps.deck.length === 0) { showPOPResult(); return; }
  renderPOP();
};

// --- 結果画面 ---
function showPOPResult() {
  const ps = state.popState;
  const ranked = [...ps.players].sort((a, b) => b.cards.length - a.cards.length);
  const winner = ranked[0];
  playSfx('win');

  render(`
    ${header()}
    <div class="container" style="max-width:560px">
      <!-- 優勝発表 -->
      <div style="background:linear-gradient(135deg,#fffbeb,#fef3c7);border-radius:20px;padding:32px;text-align:center;margin-bottom:20px;box-shadow:var(--shadow)">
        <div style="font-size:3.5rem">🏆</div>
        <h2 style="color:#d97706;margin:8px 0">ゲーム終了！</h2>
        <p style="font-size:1.4rem;font-weight:800">${winner.name} さんの勝ち！</p>
        <p style="color:var(--muted)">${winner.cards.length}枚のカードを獲得</p>
      </div>

      <!-- 順位表 -->
      <div class="card" style="padding:0;overflow:hidden;margin-bottom:16px">
        <table class="ranking-table">
          <thead><tr><th>順位</th><th>名前</th><th>獲得カード</th></tr></thead>
          <tbody>
            ${ranked.map((p, i) => `
              <tr>
                <td class="rank-no">${i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i+1}`}</td>
                <td style="font-weight:${i===0?'800':'400'}">${p.name}</td>
                <td>🃏 ${p.cards.length}枚</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>

      <!-- 練習カード -->
      ${ps.practiceCards.length > 0 ? `
        <div class="card" style="margin-bottom:16px;border-left:4px solid #f59e0b">
          <h3 style="color:#d97706;margin-bottom:12px">📝 練習しよう！読めなかった単語（${ps.practiceCards.length}語）</h3>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
            ${ps.practiceCards.map(c => `
              <div style="background:#fffbeb;border-radius:8px;padding:8px 12px;font-size:.9rem">
                <strong>${c.en}</strong> <span style="color:var(--muted)">— ${c.ja}</span>
              </div>
            `).join('')}
          </div>
        </div>
      ` : `<div class="card" style="text-align:center;margin-bottom:16px;color:var(--success)">🎉 全員全ての単語を読めました！</div>`}

      <div style="display:flex;gap:10px">
        <button class="btn-secondary" style="flex:1" onclick="showPOPSetup(state.popWords)">もう一度</button>
        <button class="btn-primary" style="flex:1" onclick="showHome()">ホームへ</button>
      </div>
    </div>
  `);
}

// ===== 文型パズル（語順マスター） =====
const PATTERN_QUESTIONS = [
  { pattern: "S + V + O",       hint: "「私は野球をします。」", cards: [{text:"I",role:"S"},{text:"play",role:"V"},{text:"baseball.",role:"O"}], order: ["S","V","O"] },
  { pattern: "S + V + C",       hint: "「そのリンゴは甘い。」", cards: [{text:"The apple",role:"S"},{text:"is",role:"V"},{text:"sweet.",role:"C"}], order: ["S","V","C"] },
  { pattern: "S + V + O + O",   hint: "「彼は私にプレゼントをくれた。」", cards: [{text:"He",role:"S"},{text:"gave",role:"V"},{text:"me",role:"O"},{text:"a present.",role:"O"}], order: ["S","V","O","O"] },
  { pattern: "S + V + O + C",   hint: "「そのニュースは彼女を幸せにした。」", cards: [{text:"The news",role:"S"},{text:"made",role:"V"},{text:"her",role:"O"},{text:"happy.",role:"C"}], order: ["S","V","O","C"] },
  { pattern: "V + O",           hint: "【命令文】「窓を開けなさい。」", cards: [{text:"Open",role:"V"},{text:"the window.",role:"O"}], order: ["V","O"] },
  { pattern: "S + AUX + V + O", hint: "【否定文】「私はテニスをしません。」", cards: [{text:"I",role:"S"},{text:"do not",role:"AUX"},{text:"play",role:"V"},{text:"tennis.",role:"O"}], order: ["S","AUX","V","O"] },
  { pattern: "S + AUX + V + O", hint: "【現在進行形】「彼は今、昼食を食べているところです。」", cards: [{text:"He",role:"S"},{text:"is",role:"AUX"},{text:"eating",role:"V"},{text:"lunch now.",role:"O"}], order: ["S","AUX","V","O"] },
  { pattern: "S + AUX + V + O", hint: "【現在完了形】「私はちょうど宿題を終えたところです。」", cards: [{text:"I",role:"S"},{text:"have",role:"AUX"},{text:"finished",role:"V"},{text:"my homework.",role:"O"}], order: ["S","AUX","V","O"] },
  { pattern: "S + AUX + V + O", hint: "【助動詞の文】「あなたは英語を話すことができる。」", cards: [{text:"You",role:"S"},{text:"can",role:"AUX"},{text:"speak",role:"V"},{text:"English.",role:"O"}], order: ["S","AUX","V","O"] },
  { pattern: "S + V + O + C",   hint: "【最後の挑戦】「私たちは彼をトムと呼びます。」", cards: [{text:"We",role:"S"},{text:"call",role:"V"},{text:"him",role:"O"},{text:"Tom.",role:"C"}], order: ["S","V","O","C"] },
];

const PAT_COLOR  = { S:'#ef4444', V:'#22c55e', O:'#3b82f6', C:'#a855f7', AUX:'#eab308' };
const PAT_BORDER = { S:'#b91c1c', V:'#15803d', O:'#1d4ed8', C:'#7e22ce', AUX:'#a16207' };
const PAT_LABEL  = { S:'主語', V:'動詞', O:'目的語', C:'補語', AUX:'助動詞/否定' };

// ===== 第1〜第5文型の英文プール（毎回ここからランダム出題） =====
const S = t => ({ text: t, role: 'S' });
const V = t => ({ text: t, role: 'V' });
const O = t => ({ text: t, role: 'O' });
const C = t => ({ text: t, role: 'C' });

const PATTERN_BANK = {
  // 第1文型 S + V（〜が…する）
  '1': [
    { hint: '鳥は飛ぶ。',           cards: [S('Birds'), V('fly.')] },
    { hint: '赤ちゃんが泣いた。',    cards: [S('The baby'), V('cried.')] },
    { hint: '太陽は昇る。',         cards: [S('The sun'), V('rises.')] },
    { hint: '犬は走る。',           cards: [S('Dogs'), V('run.')] },
    { hint: '彼女はほほ笑んだ。',    cards: [S('She'), V('smiled.')] },
    { hint: 'その犬は眠っている。',  cards: [S('The dog'), V('sleeps.')] },
    { hint: '私たちは歩いた。',      cards: [S('We'), V('walked.')] },
    { hint: '彼らは泳いだ。',        cards: [S('They'), V('swam.')] },
    { hint: '電車が止まった。',      cards: [S('The train'), V('stopped.')] },
    { hint: '父は働いている。',      cards: [S('My father'), V('works.')] },
    { hint: '星が輝く。',           cards: [S('The stars'), V('shine.')] },
    { hint: 'みんなが笑った。',      cards: [S('Everyone'), V('laughed.')] },
  ],
  // 第2文型 S + V + C（〜は…だ／になる）
  '2': [
    { hint: '彼女は先生だ。',        cards: [S('She'), V('is'), C('a teacher.')] },
    { hint: '彼は幸せそうに見える。', cards: [S('He'), V('looks'), C('happy.')] },
    { hint: 'このリンゴは甘い。',    cards: [S('This apple'), V('is'), C('sweet.')] },
    { hint: '彼らは生徒だ。',        cards: [S('They'), V('are'), C('students.')] },
    { hint: 'スープが冷めた。',      cards: [S('The soup'), V('got'), C('cold.')] },
    { hint: '父は医者だ。',          cards: [S('My father'), V('is'), C('a doctor.')] },
    { hint: '彼女は有名になった。',   cards: [S('She'), V('became'), C('famous.')] },
    { hint: 'あなたは疲れて見える。', cards: [S('You'), V('look'), C('tired.')] },
    { hint: 'その話は面白そうだ。',   cards: [S('The story'), V('sounds'), C('interesting.')] },
    { hint: '今日は寒い。',          cards: [S('It'), V('is'), C('cold.')] },
  ],
  // 第3文型 S + V + O（〜は…を〜する）
  '3': [
    { hint: '私はテニスをする。',     cards: [S('I'), V('play'), O('tennis.')] },
    { hint: '彼女は本を読む。',       cards: [S('She'), V('reads'), O('books.')] },
    { hint: '私たちは英語を勉強する。', cards: [S('We'), V('study'), O('English.')] },
    { hint: '彼は音楽が好きだ。',     cards: [S('He'), V('likes'), O('music.')] },
    { hint: '彼らは映画を見た。',     cards: [S('They'), V('watched'), O('a movie.')] },
    { hint: '私は昼食を食べた。',     cards: [S('I'), V('ate'), O('lunch.')] },
    { hint: 'トムはサッカーをする。', cards: [S('Tom'), V('plays'), O('soccer.')] },
    { hint: '彼女は猫を飼っている。',  cards: [S('She'), V('has'), O('a cat.')] },
    { hint: '私たちは京都を訪れた。',  cards: [S('We'), V('visited'), O('Kyoto.')] },
    { hint: '彼はドアを開けた。',     cards: [S('He'), V('opened'), O('the door.')] },
  ],
  // 第4文型 S + V + O + O（〜は(人)に(物)を…する）
  '4': [
    { hint: '彼は私にプレゼントをくれた。', cards: [S('He'), V('gave'), O('me'), O('a present.')] },
    { hint: '彼女は彼に手紙を送った。',    cards: [S('She'), V('sent'), O('him'), O('a letter.')] },
    { hint: '私は彼女にアルバムを見せた。', cards: [S('I'), V('showed'), O('her'), O('my album.')] },
    { hint: '母は私に昼食を作ってくれた。', cards: [S('My mother'), V('made'), O('me'), O('lunch.')] },
    { hint: '彼は私たちに話をしてくれた。', cards: [S('He'), V('told'), O('us'), O('a story.')] },
    { hint: '先生は私たちに英語を教えた。', cards: [S('The teacher'), V('taught'), O('us'), O('English.')] },
    { hint: '彼女は彼に時計を買った。',    cards: [S('She'), V('bought'), O('him'), O('a watch.')] },
    { hint: '私は犬に食べ物をあげた。',    cards: [S('I'), V('gave'), O('the dog'), O('some food.')] },
    { hint: '彼は私にメールを送った。',    cards: [S('He'), V('sent'), O('me'), O('an email.')] },
    { hint: '彼らは私たちに道を教えた。',  cards: [S('They'), V('showed'), O('us'), O('the way.')] },
  ],
  // 第5文型 S + V + O + C（〜は(人・物)を…にする／と呼ぶ）
  '5': [
    { hint: '私たちは彼をトムと呼ぶ。',     cards: [S('We'), V('call'), O('him'), C('Tom.')] },
    { hint: 'その知らせは彼女を幸せにした。', cards: [S('The news'), V('made'), O('her'), C('happy.')] },
    { hint: '彼らは赤ちゃんをエマと名付けた。', cards: [S('They'), V('named'), O('the baby'), C('Emma.')] },
    { hint: '彼女は部屋をきれいに保つ。',    cards: [S('She'), V('keeps'), O('the room'), C('clean.')] },
    { hint: '私はその本が簡単だと分かった。', cards: [S('I'), V('found'), O('the book'), C('easy.')] },
    { hint: '私たちは壁を白く塗った。',      cards: [S('We'), V('painted'), O('the wall'), C('white.')] },
    { hint: 'その映画は私を悲しくさせた。',  cards: [S('The movie'), V('made'), O('me'), C('sad.')] },
    { hint: '私たちはその犬をポチと呼ぶ。',  cards: [S('We'), V('call'), O('the dog'), C('Pochi.')] },
    { hint: '彼の言葉は私たちを怒らせた。',  cards: [S('His words'), V('made'), O('us'), C('angry.')] },
    { hint: '彼女はドアを開けたままにした。', cards: [S('She'), V('left'), O('the door'), C('open.')] },
  ],
};

const PATTERN_MODE_LABEL = {
  '1': '第1文型（S+V）',
  '2': '第2文型（S+V+C）',
  '3': '第3文型（S+V+O）',
  '4': '第4文型（S+V+O+O）',
  '5': '第5文型（S+V+O+C）',
  'mix': 'ごちゃまぜ',
  'textbook': '教科書本文',
};

function buildPatternItem(raw) {
  const order = raw.cards.map(c => c.role);
  return { hint: raw.hint, cards: raw.cards, order, pattern: order.join(' + ') };
}

// --- 選択メニュー ---
const PATTERN_NICKNAME = {
  '1': { name: 'スティッチ構文', ex: '「スティッチ、寝る」' },
  '2': { name: '「僕はクマ〜♪」構文', ex: '「僕は＝クマ」' },
  '3': { name: 'マッシュル構文', ex: '「俺の握力は全てを破壊する」' },
  '4': { name: 'サンタさん構文', ex: '「サンタは子どもにプレゼントをあげる」' },
  '5': { name: 'あだ名構文', ex: '「みんなは俺をキングと呼ぶ」' },
};

function startPattern() {
  state.screen = 'pattern';
  const btn = (mode, sub, color) => {
    const nick = PATTERN_NICKNAME[mode];
    return `
    <button class="menu-card" style="text-align:center;cursor:pointer;border:none;width:100%"
      onclick="patternMode('${mode}')">
      <div class="icon" style="font-size:1.6rem">${color}</div>
      ${nick ? `
        <div style="font-weight:800;font-size:1.02rem;color:var(--primary);margin:4px 0 2px">${nick.name}</div>
        <div style="font-size:.78rem;color:var(--accent);margin-bottom:6px">${nick.ex}</div>
        <h3 style="margin:2px 0;font-size:.95rem">${PATTERN_MODE_LABEL[mode]}</h3>
      ` : `<h3 style="margin:4px 0">${PATTERN_MODE_LABEL[mode]}</h3>`}
      <p>${sub}</p>
    </button>`;
  };
  render(`
    ${header()}
    <div class="container" style="max-width:720px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
        <h2 style="color:var(--primary)">🧩 文型パズル</h2>
        <button class="btn-secondary btn-sm" onclick="showHome()">← 戻る</button>
      </div>
      <p style="color:var(--muted);margin-bottom:16px">学びたい「型」を選んでね。第1〜第5・ごちゃまぜは毎回ランダムに出題されます。</p>
      <div class="menu-grid">
        ${btn('1', '主語＋動詞', '①')}
        ${btn('2', '主語＋動詞＋補語', '②')}
        ${btn('3', '主語＋動詞＋目的語', '③')}
        ${btn('4', '主語＋動詞＋目的語＋目的語', '④')}
        ${btn('5', '主語＋動詞＋目的語＋補語', '⑤')}
        ${btn('mix', '第1〜第5をまぜて出題', '🎲')}
        ${btn('textbook', '先生が登録した文で練習', '📖')}
      </div>
    </div>
  `);
}

window.patternMode = async (mode) => {
  let list = [];

  if (mode === 'textbook') {
    showPatternLessonSelect();
    return;
  } else if (mode === 'mix') {
    const all = [].concat(...Object.keys(PATTERN_BANK).map(k => PATTERN_BANK[k]));
    list = shuffle(all).slice(0, 12).map(buildPatternItem);
  } else {
    const pool = PATTERN_BANK[mode] || [];
    list = shuffle([...pool]).slice(0, 10).map(buildPatternItem);
  }

  state.patternState = { list: shuffle(list), index: 0, correct: 0, solved: false, mode };
  renderPattern();
};

// --- 教科書本文：レッスン選択（複数選択OK） ---
let patternLessons = [];

function showPatternLessonSelect() {
  patternLessons = [];
  render(`
    ${header()}
    <div class="container" style="max-width:560px">
      <div class="card">
        <h2 style="color:var(--primary);margin-bottom:4px">📖 教科書本文</h2>
        <p style="color:var(--muted);margin-bottom:4px">${state.student.grade} ${state.student.class} のレッスンを選んでね</p>
        <p style="color:var(--accent);font-size:.85rem;margin-bottom:16px">複数選択OK！タップで選択／解除</p>
        <div class="form-group">
          <label>レッスン</label>
          <div class="select-grid">
            ${CONFIG.lessons.map(l => `<button class="select-btn" onclick="togglePatternLesson('${l}',this)">${l}</button>`).join('')}
          </div>
        </div>
        <div id="pat-lesson-count" style="text-align:center;color:var(--muted);font-size:.85rem;margin-bottom:12px"></div>
        <div style="display:flex;gap:10px">
          <button class="btn-secondary" style="flex:1" onclick="startPattern()">← 戻る</button>
          <button class="btn-primary" style="flex:2" onclick="startPatternTextbook()">スタート！</button>
        </div>
        <p id="pat-lesson-error" style="color:#ef4444;margin-top:10px;font-size:.9rem;min-height:18px"></p>
      </div>
    </div>
  `);
}

window.togglePatternLesson = (l, btn) => {
  const idx = patternLessons.indexOf(l);
  if (idx === -1) { patternLessons.push(l); btn.classList.add('active'); }
  else            { patternLessons.splice(idx, 1); btn.classList.remove('active'); }
  const el = document.getElementById('pat-lesson-count');
  if (el) el.textContent = patternLessons.length > 0 ? `${patternLessons.length}レッスン選択中` : '';
};

window.startPatternTextbook = async () => {
  const errEl = document.getElementById('pat-lesson-error');
  if (patternLessons.length === 0) {
    if (errEl) errEl.textContent = 'レッスンを選んでください';
    return;
  }
  if (errEl) errEl.textContent = '読み込み中…';

  // 選んだレッスンの文を並列取得
  const results = await Promise.all(
    patternLessons.map(l =>
      getPatternsByLesson(state.student.grade, state.student.class, l).catch(() => [])
    )
  );
  const pats = [].concat(...results);
  const list = pats.map(p => ({ hint: p.ja, cards: p.chunks, order: p.chunks.map(c => c.role), pattern: p.pattern }));

  if (list.length === 0) {
    if (errEl) errEl.textContent = 'このレッスンには文が登録されていません。先生に登録してもらおう！';
    return;
  }

  state.patternState = { list: shuffle(list), index: 0, correct: 0, solved: false, mode: 'textbook' };
  renderPattern();
};

function renderPattern() {
  const st = state.patternState;
  if (st.index >= st.list.length) { showPatternResult(); return; }
  st.solved = false;
  const q = st.list[st.index];
  const shuffled = shuffle([...q.cards]);

  const cardHTML = (c) => {
    const dark = c.role === 'AUX';
    return `<div class="pat-card" data-role="${c.role}" onclick="patternMove(this)"
      style="background:${PAT_COLOR[c.role]};color:${dark ? '#1e293b' : 'white'};border-bottom:4px solid ${PAT_BORDER[c.role]}">${c.text}</div>`;
  };
  const legend = Object.keys(PAT_LABEL).map(r =>
    `<span style="display:inline-flex;align-items:center;gap:4px">
      <span style="width:12px;height:12px;border-radius:3px;background:${PAT_COLOR[r]};display:inline-block"></span>${PAT_LABEL[r]}</span>`).join('');

  render(`
    <style>
      .pat-mission { background:#eff6ff; border-left:6px solid var(--primary); border-radius:12px; padding:16px 18px; margin:14px 0 10px; text-align:center; }
      .pat-badge { display:inline-block; background:var(--primary); color:white; padding:4px 16px; border-radius:8px; font-weight:800; font-size:1rem; margin-bottom:8px; }
      .pat-hint { font-size:1.35rem; font-weight:800; color:#1e293b; line-height:1.4; }
      .pat-legend { font-size:.8rem; color:var(--muted); margin-bottom:12px; display:flex; gap:12px; flex-wrap:wrap; justify-content:center; }
      .pat-section { text-align:left; font-weight:700; color:var(--muted); margin:6px 2px; font-size:.88rem; }
      .pat-pool, .pat-zone { display:flex; flex-wrap:wrap; gap:12px; justify-content:center; padding:16px; border-radius:12px; min-height:74px; }
      .pat-pool { background:#fafafa; border:2px dashed #cbd5e1; margin-bottom:14px; }
      .pat-zone { background:#eef2f7; border:2px solid #cbd5e1; margin-bottom:12px; }
      .pat-card { padding:12px 20px; font-size:1.25rem; font-weight:800; border-radius:10px; cursor:pointer; user-select:none; box-shadow:0 4px 10px rgba(0,0,0,.15); transition:transform .12s; }
      .pat-card:hover { transform:translateY(-3px); }
      .pat-result { font-size:1.35rem; font-weight:800; min-height:40px; text-align:center; margin:6px 0 14px; }
    </style>
    ${header()}
    <div class="container" style="max-width:820px">
      <div class="typing-progress">
        <span>${st.index + 1} / ${st.list.length}</span>
        <span>✅ ${st.correct}</span>
      </div>
      <div class="pat-mission">
        <div class="pat-badge">目標の型：${q.pattern}</div>
        <div class="pat-hint">${q.hint}</div>
      </div>
      <div class="pat-legend">${legend}</div>
      <div class="pat-section">▼ 単語（タップで下へ移動）</div>
      <div id="pat-pool" class="pat-pool">${shuffled.map(cardHTML).join('')}</div>
      <div class="pat-section">▼ 組み立てた英文（タップで戻す）</div>
      <div id="pat-zone" class="pat-zone"></div>
      <div id="pat-result" class="pat-result"></div>
      <div style="display:flex;gap:10px;justify-content:center">
        <button class="btn-secondary btn-sm" onclick="renderPattern()">やり直す</button>
        <button class="btn-secondary btn-sm" onclick="showHome()">やめる</button>
        <button id="pat-next" class="btn-primary" style="display:none" onclick="patternNext()">次へ →</button>
      </div>
    </div>
  `);
}

window.patternMove = (card) => {
  const pool = document.getElementById('pat-pool');
  const zone = document.getElementById('pat-zone');
  if (!pool || !zone) return;
  if (card.parentNode === pool) {
    zone.appendChild(card);
  } else {
    pool.appendChild(card);
    document.getElementById('pat-result').textContent = '';
    document.getElementById('pat-next').style.display = 'none';
  }
  patternCheck();
};

function patternCheck() {
  const st = state.patternState;
  const q  = st.list[st.index];
  const zone   = document.getElementById('pat-zone');
  const result = document.getElementById('pat-result');
  const nextBtn = document.getElementById('pat-next');
  const cards = [...zone.children];
  if (cards.length !== q.order.length) { result.textContent = ''; nextBtn.style.display = 'none'; return; }

  const ok = cards.every((c, i) => c.dataset.role === q.order[i]);
  if (ok) {
    result.textContent = '⭕ 正解！ Excellent!! ✨';
    result.style.color = 'var(--success)';
    nextBtn.style.display = 'inline-block';
    if (!st.solved) {
      st.solved = true;
      st.correct++;
      playSfx('correct');
      addPoints(state.student.id, CONFIG.points.patternCorrect);
    }
  } else {
    result.textContent = '❌ 「型」がちがうよ。もう一度！';
    result.style.color = 'var(--danger)';
    nextBtn.style.display = 'none';
    playSfx('wrong');
  }
}

window.patternNext = () => {
  state.patternState.index++;
  renderPattern();
};

async function showPatternResult() {
  const st = state.patternState;
  const perfect = st.correct === st.list.length;
  const bonus = perfect ? CONFIG.points.patternPerfect : 0;
  if (bonus > 0) await addPoints(state.student.id, bonus);
  playSfx('win');
  render(`
    <div class="overlay"></div>
    <div class="score-popup">
      <h2>全問クリア！</h2>
      <div class="big">🧩</div>
      <p>${st.list.length}問中 <strong>${st.correct}問</strong> 正解</p>
      ${perfect ? `<p style="color:var(--accent);font-weight:700">パーフェクト！ +${bonus}pt 🎉</p>` : ''}
      <div class="pts-earned">+${st.correct * CONFIG.points.patternCorrect + bonus} pt</div>
      <p style="color:var(--muted);font-size:.85rem;margin-bottom:20px">合計 ${state.student.points} pt</p>
      <div style="display:flex;gap:10px">
        <button class="btn-secondary" onclick="patternMode('${st.mode}')">もう一度</button>
        <button class="btn-secondary" onclick="startPattern()">型を選び直す</button>
        <button class="btn-primary" onclick="showHome()">ホームへ</button>
      </div>
    </div>
  `);
}

// --- ランクアップ演出 ---
function showRankUp(rank) {
  const el = document.createElement('div');
  el.className = 'rankup-popup';
  el.innerHTML = `
    <div class="overlay" onclick="this.parentElement.remove()"></div>
    <div class="rankup-inner">
      <div class="big-emoji">${rank.emoji}</div>
      <h2>ランクアップ！</h2>
      <p style="font-size:1.2rem;font-weight:700;margin:8px 0">${rank.name} になったよ！</p>
      <p style="color:var(--muted);margin-bottom:20px">おめでとう🎉</p>
      <button class="btn-primary" onclick="this.closest('.rankup-popup').remove()">やったー！</button>
    </div>
  `;
  document.body.appendChild(el);
}

// --- 先生ダッシュボード ---
function showTeacher() {
  state.screen = 'teacher';
  renderTeacher();
}

async function renderTeacher() {
  const tab = state.teacherTab;
  const header = `
    <div class="header" style="background:linear-gradient(135deg,#7c3aed,#9333ea)">
      <h1>👩‍🏫 先生ダッシュボード</h1>
      <button class="btn-secondary btn-sm" onclick="state.role=null;showLogin()">ログアウト</button>
    </div>`;

  let content = '';
  if (tab === 'words') {
    content = await renderTeacherWords();
  } else if (tab === 'pattern') {
    content = renderTeacherPattern();
  } else if (tab === 'analysis') {
    content = await renderTeacherAnalysis();
  } else if (tab === 'students') {
    content = await renderTeacherStudents();
  } else if (tab === 'settings') {
    content = renderTeacherSettings();
  }

  render(`
    ${header}
    <div class="container">
      <div class="teacher-tabs">
        <button class="${tab === 'words' ? 'active' : 'inactive'}" onclick="teacherTab('words')">単語管理</button>
        <button class="${tab === 'pattern' ? 'active' : 'inactive'}" onclick="teacherTab('pattern')">文型パズル</button>
        <button class="${tab === 'analysis' ? 'active' : 'inactive'}" onclick="teacherTab('analysis')">苦手分析</button>
        <button class="${tab === 'students' ? 'active' : 'inactive'}" onclick="teacherTab('students')">生徒一覧</button>
        <button class="${tab === 'settings' ? 'active' : 'inactive'}" onclick="teacherTab('settings')">設定</button>
      </div>
      ${content}
    </div>
  `);
  if (tab === 'pattern') loadPatternList();
}

window.teacherTab = (tab) => {
  state.teacherTab = tab;
  renderTeacher();
};

async function renderTeacherWords() {
  return `
    <div class="card" style="margin-bottom:20px">
      <h3 style="margin-bottom:16px;color:#7c3aed">📖 単語を追加</h3>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:12px">
        <div class="form-group" style="margin:0">
          <label>学年</label>
          <select id="add-grade">
            ${CONFIG.grades.map(g => `<option value="${g}">${g}</option>`).join('')}
          </select>
        </div>
        <div class="form-group" style="margin:0">
          <label>クラス</label>
          <select id="add-class">
            ${CONFIG.classes.map(c => `<option value="${c}">${c}</option>`).join('')}
          </select>
        </div>
        <div class="form-group" style="margin:0">
          <label>レッスン</label>
          <select id="add-lesson">
            ${CONFIG.lessons.map(l => `<option value="${l}">${l}</option>`).join('')}
          </select>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
        <div class="form-group" style="margin:0">
          <label>英語</label>
          <input type="text" id="add-en" placeholder="例: apple">
        </div>
        <div class="form-group" style="margin:0">
          <label>日本語訳</label>
          <input type="text" id="add-ja" placeholder="例: リンゴ">
        </div>
      </div>
      <div style="display:flex;gap:10px;align-items:center">
        <button class="btn-primary" onclick="addWord()">➕ 追加</button>
        <button class="btn-danger" onclick="deleteLesson()">🗑️ このレッスンを一括削除</button>
      </div>
      <p id="add-msg" style="margin-top:8px;font-size:.9rem;min-height:18px"></p>

      <hr style="margin:20px 0;border:none;border-top:1px solid #f1f5f9">
      <h4 style="color:#7c3aed;margin-bottom:8px">📂 他のクラスからコピー</h4>
      <p style="color:var(--muted);font-size:.85rem;margin-bottom:8px">別のクラス・レッスンに登録済みの単語をそのままコピーできます</p>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr auto;gap:10px;align-items:end">
        <div class="form-group" style="margin:0">
          <label>コピー元 学年</label>
          <select id="copy-grade">
            ${CONFIG.grades.map(g => `<option value="${g}">${g}</option>`).join('')}
          </select>
        </div>
        <div class="form-group" style="margin:0">
          <label>コピー元 クラス</label>
          <select id="copy-class">
            ${CONFIG.classes.map(c => `<option value="${c}">${c}</option>`).join('')}
          </select>
        </div>
        <div class="form-group" style="margin:0">
          <label>コピー元 レッスン</label>
          <select id="copy-lesson">
            ${CONFIG.lessons.map(l => `<option value="${l}">${l}</option>`).join('')}
          </select>
        </div>
        <button class="btn-primary" style="white-space:nowrap" onclick="copyWords()">コピー実行</button>
      </div>
      <p id="copy-msg" style="margin-top:8px;font-size:.9rem;min-height:18px"></p>

      <hr style="margin:20px 0;border:none;border-top:1px solid #f1f5f9">
      <h4 style="color:#7c3aed;margin-bottom:8px">📋 まとめて貼り付け</h4>
      <p style="color:var(--muted);font-size:.85rem;margin-bottom:8px">1行に「英語,日本語」の形式で複数行まとめて入力できます</p>
      <textarea id="bulk-input" rows="5" placeholder="apple,リンゴ&#10;book,本&#10;cat,ネコ"></textarea>
      <button class="btn-primary" style="margin-top:8px" onclick="addBulkWords()">まとめて追加</button>
      <p id="bulk-msg" style="margin-top:8px;font-size:.9rem;min-height:18px"></p>
    </div>

    <div class="card">
      <h3 style="margin-bottom:16px;color:#7c3aed">📚 登録済み単語一覧</h3>
      <div id="word-list-container">読み込み中…</div>
    </div>
  `;
}

window.addWord = async () => {
  const grade = document.getElementById('add-grade').value;
  const cls   = document.getElementById('add-class').value;
  const lesson = document.getElementById('add-lesson').value;
  const en = document.getElementById('add-en').value.trim();
  const ja = document.getElementById('add-ja').value.trim();
  const msg = document.getElementById('add-msg');
  if (!en || !ja) { msg.textContent = '英語と日本語を入力してください'; msg.style.color = 'red'; return; }
  await F.addDoc(F.collection(db, 'words'), { grade, class: cls, lesson, en, ja, createdAt: Date.now() });
  _wordsCache.clear();
  msg.textContent = `「${en}」を追加しました！`;
  msg.style.color = 'green';
  document.getElementById('add-en').value = '';
  document.getElementById('add-ja').value = '';
  document.getElementById('add-en').focus();
  loadWordList();
};

window.deleteLesson = async () => {
  const grade  = document.getElementById('add-grade').value;
  const cls    = document.getElementById('add-class').value;
  const lesson = document.getElementById('add-lesson').value;
  const words  = await getWords(grade, cls, lesson);
  if (words.length === 0) {
    document.getElementById('add-msg').textContent = 'この条件に単語が登録されていません';
    document.getElementById('add-msg').style.color = 'orange';
    return;
  }
  if (!confirm(`${grade} ${cls} ${lesson} の単語 ${words.length}件を全て削除しますか？\nこの操作は元に戻せません。`)) return;
  const del = F.deleteDoc
    ? F.deleteDoc
    : (await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js")).deleteDoc;
  await Promise.all(words.map(w => del(F.doc(db, 'words', w.id)))); // 並列削除で高速化
  _wordsCache.clear();
  const msg = document.getElementById('add-msg');
  msg.textContent = `${words.length}件を削除しました`;
  msg.style.color = 'green';
  loadWordList();
};

window.copyWords = async () => {
  const fromGrade  = document.getElementById('copy-grade').value;
  const fromClass  = document.getElementById('copy-class').value;
  const fromLesson = document.getElementById('copy-lesson').value;
  const toGrade    = document.getElementById('add-grade').value;
  const toClass    = document.getElementById('add-class').value;
  const toLesson   = document.getElementById('add-lesson').value;
  const msg = document.getElementById('copy-msg');

  if (fromGrade === toGrade && fromClass === toClass && fromLesson === toLesson) {
    msg.textContent = 'コピー元とコピー先が同じです'; msg.style.color = 'red'; return;
  }

  const words = await getWords(fromGrade, fromClass, fromLesson);
  if (words.length === 0) {
    msg.textContent = 'コピー元に単語が登録されていません'; msg.style.color = 'red'; return;
  }

  // 既存の単語と重複チェック
  const existing = await getWords(toGrade, toClass, toLesson);
  const existingSet = new Set(existing.map(w => w.en.toLowerCase()));

  const toCopy = words.filter(w => !existingSet.has(w.en.toLowerCase()));
  await Promise.all(toCopy.map(w => F.addDoc(F.collection(db, 'words'), {
    grade: toGrade, class: toClass, lesson: toLesson,
    en: w.en, ja: w.ja, createdAt: Date.now()
  }))); // 並列コピーで高速化
  const count = toCopy.length;
  _wordsCache.clear();

  msg.textContent = count > 0
    ? `${count}件コピーしました！（重複${words.length - count}件はスキップ）`
    : '全て重複のためスキップしました';
  msg.style.color = count > 0 ? 'green' : 'orange';
  loadWordList();
};

window.addBulkWords = async () => {
  const grade = document.getElementById('add-grade').value;
  const cls   = document.getElementById('add-class').value;
  const lesson = document.getElementById('add-lesson').value;
  const lines = document.getElementById('bulk-input').value.trim().split('\n');
  const msg = document.getElementById('bulk-msg');
  const items = [];
  for (const line of lines) {
    const parts = line.split(',');
    if (parts.length >= 2) {
      const en = parts[0].trim();
      const ja = parts[1].trim();
      if (en && ja) items.push({ grade, class: cls, lesson, en, ja, createdAt: Date.now() });
    }
  }
  await Promise.all(items.map(it => F.addDoc(F.collection(db, 'words'), it))); // 並列追加で高速化
  const count = items.length;
  _wordsCache.clear();
  msg.textContent = `${count}件追加しました！`;
  msg.style.color = 'green';
  document.getElementById('bulk-input').value = '';
  loadWordList();
};

async function loadWordList() {
  const container = document.getElementById('word-list-container');
  if (!container) return;
  const words = await getAllWords();
  if (words.length === 0) { container.innerHTML = '<p style="color:var(--muted)">まだ単語が登録されていません</p>'; return; }

  // グループ化
  const groups = {};
  words.forEach(w => {
    const key = `${w.grade} ${w.class} ${w.lesson}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(w);
  });

  container.innerHTML = Object.entries(groups).sort(([a],[b]) => a.localeCompare(b)).map(([key, ws]) => `
    <div class="lesson-group">
      <h4>${key} (${ws.length}語)</h4>
      <table class="word-list-table">
        <thead><tr><th>英語</th><th>日本語</th><th></th></tr></thead>
        <tbody>
          ${ws.map(w => `
            <tr>
              <td><strong>${w.en}</strong></td>
              <td>${w.ja}</td>
              <td><button class="btn-danger btn-sm" onclick="removeWord('${w.id}')">削除</button></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `).join('');
}

window.removeWord = async (id) => {
  if (!confirm('この単語を削除しますか？')) return;
  await deleteWord(id);
  toast('削除しました');
  loadWordList();
};

// ===== 先生：苦手分析（生徒がよく間違う単語） =====
async function renderTeacherAnalysis() {
  let rows = '';
  try {
    const snap = await F.getDocs(F.collection(db, 'mistakes'));
    const recs = snap.docs.map(d => d.data());
    if (recs.length === 0) {
      rows = `<p style="color:var(--muted)">まだ記録がありません。生徒が間違えると自動でたまります。</p>`;
    } else {
      // 単語ごとに集計
      const agg = new Map();
      for (const r of recs) {
        const k = `${r.en}|${r.grade}|${r.class}`;
        if (!agg.has(k)) agg.set(k, { en: r.en, ja: r.ja, grade: r.grade, class: r.class, n: 0 });
        agg.get(k).n++;
      }
      const top = [...agg.values()].sort((a, b) => b.n - a.n).slice(0, 30);
      rows = `
        <table class="ranking-table">
          <thead><tr><th>順位</th><th>単語</th><th>意味</th><th>学年・組</th><th>間違い回数</th></tr></thead>
          <tbody>
            ${top.map((w, i) => `<tr>
              <td class="rank-no">${i + 1}</td>
              <td style="font-weight:700">${w.en}</td>
              <td>${w.ja}</td>
              <td>${w.grade} ${w.class}</td>
              <td style="color:#ef4444;font-weight:700">${w.n}回</td>
            </tr>`).join('')}
          </tbody>
        </table>`;
    }
  } catch(e) {
    rows = `
      <div class="note" style="background:#fef2f2;border-color:#ef4444">
        <p style="color:#991b1b;font-size:.9rem;line-height:1.7">
          ⚠️ データを読み込めませんでした。Firebaseのルールに以下を追加してください：<br>
          <code style="display:block;background:#fff;padding:8px;border-radius:6px;margin-top:6px">match /mistakes/{docId} {<br>&nbsp;&nbsp;allow read, write: if true;<br>}</code>
        </p>
      </div>`;
  }
  return `
    <div class="card">
      <h3 style="margin-bottom:6px;color:#7c3aed">📊 よく間違われる単語 TOP30</h3>
      <p style="color:var(--muted);font-size:.85rem;margin-bottom:16px">生徒がタイピング・ミニテストで間違えた単語の集計です。授業の重点指導に活用できます。</p>
      ${rows}
    </div>
  `;
}

// ===== 先生：文型パズル管理 =====
function renderTeacherPattern() {
  return `
    <div class="card" style="margin-bottom:20px">
      <h3 style="margin-bottom:12px;color:#7c3aed">🧩 文型パズルの文を追加</h3>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:12px">
        <div class="form-group" style="margin:0">
          <label>学年</label>
          <select id="pat-grade">${CONFIG.grades.map(g => `<option value="${g}">${g}</option>`).join('')}</select>
        </div>
        <div class="form-group" style="margin:0">
          <label>クラス</label>
          <select id="pat-class">${CONFIG.classes.map(c => `<option value="${c}">${c}</option>`).join('')}</select>
        </div>
        <div class="form-group" style="margin:0">
          <label>レッスン</label>
          <select id="pat-lesson">${CONFIG.lessons.map(l => `<option value="${l}">${l}</option>`).join('')}</select>
        </div>
      </div>

      <div class="note" style="background:#f5f3ff;border-color:#7c3aed;margin-bottom:12px">
        <p style="color:#5b21b6;font-size:.85rem;line-height:1.7">
          📌 <strong>入力のしかた</strong>：1行に1文。<br>
          <code>日本語の意味 | 単語[役割] 単語[役割] …</code><br>
          役割は <strong>S</strong>（主語）／<strong>V</strong>（動詞）／<strong>O</strong>（目的語）／<strong>C</strong>（補語）／<strong>AUX</strong>（助動詞・否定・be動詞）<br>
          複数の単語をまとめて1枚にできます（例：<code>The apple[S]</code>）。
        </p>
      </div>

      <p style="color:var(--muted);font-size:.85rem;margin-bottom:6px">記入例：</p>
      <pre style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px;font-size:.82rem;overflow-x:auto;margin-bottom:12px">私は野球をします。 | I[S] play[V] baseball.[O]
そのリンゴは甘い。 | The apple[S] is[V] sweet.[C]
私はテニスをしません。 | I[S] do not[AUX] play[V] tennis.[O]</pre>

      <textarea id="pat-input" rows="6" placeholder="私は野球をします。 | I[S] play[V] baseball.[O]"></textarea>
      <button class="btn-primary" style="margin-top:8px" onclick="addPatternSentences()">➕ まとめて追加</button>
      <p id="pat-msg" style="margin-top:8px;font-size:.9rem;min-height:18px"></p>

      <hr style="margin:20px 0;border:none;border-top:1px solid #f1f5f9">
      <h4 style="color:#7c3aed;margin-bottom:8px">📂 他のクラスからコピー</h4>
      <p style="color:var(--muted);font-size:.85rem;margin-bottom:8px">別のクラス・レッスンに登録済みの文を、上で選んだ「学年・クラス・レッスン」へそのままコピーします</p>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr auto;gap:10px;align-items:end">
        <div class="form-group" style="margin:0">
          <label>コピー元 学年</label>
          <select id="pat-copy-grade">${CONFIG.grades.map(g => `<option value="${g}">${g}</option>`).join('')}</select>
        </div>
        <div class="form-group" style="margin:0">
          <label>コピー元 クラス</label>
          <select id="pat-copy-class">${CONFIG.classes.map(c => `<option value="${c}">${c}</option>`).join('')}</select>
        </div>
        <div class="form-group" style="margin:0">
          <label>コピー元 レッスン</label>
          <select id="pat-copy-lesson">${CONFIG.lessons.map(l => `<option value="${l}">${l}</option>`).join('')}</select>
        </div>
        <button class="btn-primary" style="white-space:nowrap" onclick="copyPatterns()">コピー実行</button>
      </div>
      <p id="pat-copy-msg" style="margin-top:8px;font-size:.9rem;min-height:18px"></p>
    </div>

    <div class="card">
      <h3 style="margin-bottom:16px;color:#7c3aed">📚 登録済みの文（このレッスン）</h3>
      <p style="color:var(--muted);font-size:.85rem;margin-bottom:10px">上の「学年・クラス・レッスン」を切り替えて「一覧を更新」を押すと、その内容が表示されます</p>
      <button class="btn-secondary btn-sm" onclick="loadPatternList()" style="margin-bottom:12px">🔄 一覧を更新</button>
      <div id="pattern-list-container">読み込み中…</div>
    </div>
  `;
}

// 1行をパース： "日本語 | I[S] play[V] baseball.[O]"
function parsePatternLine(line) {
  const parts = line.split('|');
  if (parts.length < 2) return null;
  const hint = parts[0].trim();
  const body = parts.slice(1).join('|').trim();
  if (!hint || !body) return null;

  const chunks = [];
  const re = /([^\[]+)\[([A-Za-z]+)\]/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const text = m[1].trim();
    const role = m[2].toUpperCase();
    if (!text) return null;
    if (!['S','V','O','C','AUX'].includes(role)) return null;
    chunks.push({ text, role });
  }
  if (chunks.length < 2) return null;
  const pattern = chunks.map(c => c.role).join(' + ');
  return { hint, chunks, pattern };
}

window.addPatternSentences = async () => {
  const grade  = document.getElementById('pat-grade').value;
  const cls    = document.getElementById('pat-class').value;
  const lesson = document.getElementById('pat-lesson').value;
  const raw    = document.getElementById('pat-input').value;
  const msg    = document.getElementById('pat-msg');
  const lines  = raw.split('\n').map(l => l.trim()).filter(Boolean);

  if (lines.length === 0) { msg.textContent = '文を入力してください'; msg.style.color = 'red'; return; }

  let ok = 0; const errors = [];
  for (const line of lines) {
    const parsed = parsePatternLine(line);
    if (!parsed) { errors.push(line); continue; }
    await F.addDoc(F.collection(db, 'words'), {
      kind: 'pattern',
      grade, class: cls, lesson,
      ja: parsed.hint,
      chunks: parsed.chunks,
      pattern: parsed.pattern,
      createdAt: Date.now(),
    });
    ok++;
  }

  if (errors.length === 0) {
    msg.textContent = `${ok}文を追加しました！`;
    msg.style.color = 'green';
    document.getElementById('pat-input').value = '';
  } else {
    msg.innerHTML = `${ok}文を追加。${errors.length}行は形式エラーでスキップ：<br><span style="color:#b91c1c;font-size:.8rem">${errors.map(e=>e.replace(/</g,'&lt;')).join('<br>')}</span>`;
    msg.style.color = '#b45309';
  }
  loadPatternList();
};

async function loadPatternList() {
  const container = document.getElementById('pattern-list-container');
  if (!container) return;
  const grade  = document.getElementById('pat-grade')?.value;
  const cls    = document.getElementById('pat-class')?.value;
  const lesson = document.getElementById('pat-lesson')?.value;
  if (!grade) return;
  container.textContent = '読み込み中…';
  const pats = await getPatternsByLesson(grade, cls, lesson);
  if (pats.length === 0) {
    container.innerHTML = `<p style="color:var(--muted)">まだ登録されていません</p>`;
    return;
  }
  container.innerHTML = pats.map(p => {
    const sentence = (p.chunks || []).map(c => c.text).join(' ');
    return `<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;border-bottom:1px solid #f1f5f9">
      <div style="text-align:left">
        <div style="font-weight:700">${sentence}</div>
        <div style="font-size:.8rem;color:var(--muted)">${p.ja} ／ 型：${p.pattern}</div>
      </div>
      <button class="btn-danger btn-sm" onclick="deletePattern('${p.id}')">削除</button>
    </div>`;
  }).join('');
}

window.copyPatterns = async () => {
  const fromGrade  = document.getElementById('pat-copy-grade').value;
  const fromClass  = document.getElementById('pat-copy-class').value;
  const fromLesson = document.getElementById('pat-copy-lesson').value;
  const toGrade    = document.getElementById('pat-grade').value;
  const toClass    = document.getElementById('pat-class').value;
  const toLesson   = document.getElementById('pat-lesson').value;
  const msg = document.getElementById('pat-copy-msg');

  if (fromGrade === toGrade && fromClass === toClass && fromLesson === toLesson) {
    msg.textContent = 'コピー元とコピー先が同じです'; msg.style.color = 'red'; return;
  }

  const pats = await getPatternsByLesson(fromGrade, fromClass, fromLesson);
  if (pats.length === 0) {
    msg.textContent = 'コピー元に文が登録されていません'; msg.style.color = 'red'; return;
  }

  // コピー先の既存文と重複チェック（日本語＋英文で判定）
  const existing = await getPatternsByLesson(toGrade, toClass, toLesson);
  const keyOf = p => `${p.ja}|${(p.chunks || []).map(c => c.text).join(' ')}`;
  const existingSet = new Set(existing.map(keyOf));

  const toCopy = pats.filter(p => !existingSet.has(keyOf(p)));
  await Promise.all(toCopy.map(p => F.addDoc(F.collection(db, 'words'), {
    kind: 'pattern',
    grade: toGrade, class: toClass, lesson: toLesson,
    ja: p.ja, chunks: p.chunks, pattern: p.pattern,
    createdAt: Date.now(),
  })));
  _wordsCache.clear();

  msg.textContent = toCopy.length > 0
    ? `${toCopy.length}文コピーしました！（重複${pats.length - toCopy.length}文はスキップ）`
    : '全て重複のためスキップしました';
  msg.style.color = toCopy.length > 0 ? 'green' : 'orange';
  loadPatternList();
};

window.deletePattern = async (id) => {
  if (!confirm('この文を削除しますか？')) return;
  await deleteWord(id);
  toast('削除しました');
  loadPatternList();
};

async function renderTeacherStudents() {
  const students = await getAllStudents();
  return `
    <div class="card">
      <h3 style="margin-bottom:16px;color:#7c3aed">👥 生徒一覧 (${students.length}名)</h3>
      <table class="ranking-table">
        <thead><tr><th>順位</th><th>名前</th><th>学年・クラス</th><th>ランク</th><th>ポイント</th><th></th></tr></thead>
        <tbody>
          ${students.map((s, i) => {
            const rank = getRank(s.points);
            return `<tr>
              <td class="rank-no">${i + 1}</td>
              <td>${s.name}</td>
              <td><span class="tag tag-grade">${s.grade}</span> <span class="tag tag-class">${s.class}</span></td>
              <td>${rank.emoji} ${rank.name}</td>
              <td>${s.points} pt</td>
              <td><button class="btn-danger btn-sm" onclick="deleteStudent('${s.id.replace(/'/g, "\\'")}', '${s.name.replace(/'/g, "\\'")}')">削除</button></td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;
}

window.deleteStudent = async (id, name) => {
  if (!confirm(`「${name}」さんのアカウントを削除しますか？\nポイントや登録情報が消え、元に戻せません。`)) return;
  const del = F.deleteDoc
    ? F.deleteDoc
    : (await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js")).deleteDoc;
  await del(F.doc(db, 'students', id));
  toast(`「${name}」さんを削除しました`);
  renderTeacher(); // 一覧を再表示
};

function renderTeacherSettings() {
  return `
    <div class="card">
      <h3 style="margin-bottom:16px;color:#7c3aed">⚙️ 設定</h3>
      <p style="color:var(--muted);margin-bottom:20px">パスワードやランク設定は <code>app.js</code> の先頭にある <code>CONFIG</code> を編集してください。</p>

      <h4 style="margin-bottom:8px">現在のパスワード</h4>
      <table class="word-list-table" style="margin-bottom:20px">
        <tbody>
          <tr><td>生徒用パスワード</td><td><strong>${CONFIG.studentPassword}</strong></td></tr>
          <tr><td>先生用パスワード</td><td><strong>${CONFIG.teacherPassword}</strong></td></tr>
        </tbody>
      </table>

      <h4 style="margin-bottom:8px">ランク設定</h4>
      <table class="word-list-table">
        <thead><tr><th>ランク</th><th>必要ポイント</th></tr></thead>
        <tbody>
          ${CONFIG.ranks.map(r => `<tr><td>${r.emoji} ${r.name}</td><td>${r.min} pt〜</td></tr>`).join('')}
        </tbody>
      </table>

      <hr style="margin:24px 0;border:none;border-top:1px solid #f1f5f9">
      <h4 style="margin-bottom:8px;color:#ef4444">⚠️ 危険な操作</h4>
      <p style="color:var(--muted);font-size:.85rem;margin-bottom:12px">全生徒のポイントを0に戻します（名前や登録情報は残ります）。元に戻せません。</p>
      <button class="btn-danger" onclick="resetAllPoints()">🔄 全生徒のポイントを0にリセット</button>
      <p id="reset-msg" style="margin-top:10px;font-size:.9rem;min-height:18px"></p>
    </div>
  `;
}

window.resetAllPoints = async () => {
  const students = await getAllStudents();
  if (students.length === 0) { toast('生徒がいません'); return; }
  if (!confirm(`全生徒 ${students.length}人 のポイントを0にリセットします。\nこの操作は元に戻せません。よろしいですか？`)) return;
  if (!confirm('本当に実行しますか？（最終確認）')) return;

  const msg = document.getElementById('reset-msg');
  if (msg) { msg.textContent = 'リセット中…'; msg.style.color = 'orange'; }
  await Promise.all(students.map(s =>
    F.updateDoc(F.doc(db, 'students', s.id), { points: 0, updatedAt: Date.now() }).catch(() => {})
  ));
  if (msg) { msg.textContent = `${students.length}人のポイントを0にリセットしました`; msg.style.color = 'green'; }
  toast('リセット完了！');
};

// --- 共通ヘッダー ---
function header() {
  const s = state.student;
  const rank = s ? getRank(s.points) : null;
  return `
    <div class="header">
      <h1 onclick="showHome()" style="cursor:pointer">📚 英単語チャレンジ</h1>
      <div class="header-right">
        ${rank ? `<span class="rank-badge">${rank.emoji} ${s.name}</span>` : ''}
        <button id="mute-btn" class="btn-secondary btn-sm" onclick="toggleMute()" title="サウンド切替">${window._sfxMuted ? '🔇' : '🔊'}</button>
        <button class="btn-secondary btn-sm" onclick="localStorage.removeItem('eitanStudentId');state.student=null;state.role=null;showLogin()">ログアウト</button>
      </div>
    </div>
  `;
}

// ===== 初期化 =====
// Firebaseの設定が未入力かチェック
if (typeof window.__db === 'undefined') {
  document.getElementById('app').innerHTML = `
    <div class="page-center">
      <div class="card" style="max-width:500px;text-align:center">
        <div style="font-size:3rem;margin-bottom:12px">⚠️</div>
        <h2 style="color:#ef4444;margin-bottom:8px">Firebase未設定</h2>
        <p>index.html にFirebaseの設定を貼り付けてください。</p>
        <p style="margin-top:8px"><a href="setup-guide.html">セットアップガイドを見る →</a></p>
      </div>
    </div>`;
} else {
  // 前回の生徒情報があれば自動ログイン
  (async () => {
    const savedId = localStorage.getItem('eitanStudentId');
    if (savedId) {
      try {
        const student = await getStudent(savedId);
        if (student) {
          state.student = student;
          state.role = 'student';
          showHome();
          return;
        }
      } catch(e) {}
      localStorage.removeItem('eitanStudentId');
    }
    showLogin();
  })();

  // 先生ダッシュボードの単語一覧を遅延ロード
  document.addEventListener('click', (e) => {
    if (state.screen === 'teacher' && state.teacherTab === 'words') {
      setTimeout(() => loadWordList(), 100);
    }
  });
}

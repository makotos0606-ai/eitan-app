// ===== 設定 =====
const CONFIG = {
  studentPassword: 'eigo2024',    // 生徒用パスワード（後で変更可）
  teacherPassword: 'sensei2024',  // 先生用パスワード（後で変更可）
  grades: ['1年', '2年', '3年'],
  classes: ['1組', '2組', '3組', '4組', '5組', '6組'],
  lessons: Array.from({length: 12}, (_, i) => `Lesson ${i + 1}`),
  ranks: [
    { name: 'ペンギンちゃん',   emoji: '🐧', min: 0,    max: 599  },
    { name: 'イルカちゃん',     emoji: '🐬', min: 600,  max: 899  },
    { name: 'パンダちゃん',     emoji: '🐼', min: 900,  max: 1499 },
    { name: 'トラちゃん',       emoji: '🐯', min: 1500, max: 4999 },
    { name: 'ユニコーンちゃん', emoji: '🦄', min: 5000, max: Infinity },
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

async function addPoints(studentId, pts) {
  const student = await getStudent(studentId);
  if (!student) return;
  const oldRank = getRank(student.points);
  const newPoints = student.points + pts;
  await F.updateDoc(F.doc(db, 'students', studentId), {
    points: newPoints,
    updatedAt: Date.now(),
  });
  state.student.points = newPoints;
  const newRank = getRank(newPoints);
  if (newRank.name !== oldRank.name) showRankUp(newRank);
  return newPoints;
}

async function getWords(grade, cls, lesson) {
  const q = F.query(
    F.collection(db, 'words'),
    F.where('grade', '==', grade),
    F.where('class', '==', cls),
    F.where('lesson', '==', lesson)
  );
  const snap = await F.getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
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
  const { deleteDoc } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");
  await deleteDoc(F.doc(db, 'words', id));
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
  showHome();
};

// --- ホーム ---
function showHome() {
  state.screen = 'home';
  const s = state.student;
  const rank = getRank(s.points);
  const next = getNextRank(s.points);
  const prog = rankProgress(s.points);

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

    let words = [];
    for (const l of selectedLessons) {
      try {
        const w = await getWords(state.student.grade, state.student.class, l);
        words = words.concat(w);
      } catch(e) { /* このレッスンはスキップ */ }
    }

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
    setTimeout(async () => {
      await addPoints(state.student.id, CONFIG.points.typingCorrect);
      ts.index++;
      ts.hintLevel = 0;
      renderTyping();
    }, 600);
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

// ===== 単語の色分け表示（打済=グレー / 次=オレンジ / 残り=黒） =====
function buildWordColorHTML(word, typed) {
  return word.en.split('').map((ch, i) => {
    if (i < typed.length) {
      return `<span style="color:#94a3b8">${ch}</span>`;
    } else if (i === typed.length) {
      return `<span style="color:#f97316;font-weight:900;text-decoration:underline">${ch}</span>`;
    } else {
      return `<span style="color:#1e293b">${ch}</span>`;
    }
  }).join(' ');
}

// ===== タイプした文字を1つずつ表示 =====
function buildTypedRowHTML(typed) {
  if (!typed) return '<span style="color:#94a3b8;font-style:italic">ここに入力してね</span>';
  return `<span style="color:#1e293b">${typed.split('').join(' ')}</span><span class="th-cursor">|</span>`;
}

// ===== タイプ音（Web Audio API） =====
let _audioCtx = null;
function playTypeSound(isCorrect = false) {
  try {
    if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const ctx = _audioCtx;
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    if (isCorrect) {
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(1320, ctx.currentTime + 0.12);
      gain.gain.setValueAtTime(0.25, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.18);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.18);
    } else {
      osc.frequency.setValueAtTime(600, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(300, ctx.currentTime + 0.06);
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.08);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.08);
    }
  } catch(e) {}
}

function startTypingHint(words) {
  state.screen = 'typing-hint';
  const list = shuffle(words);
  state.typingHintState = {
    list, index: 0, correct: 0, wrong: 0,
    revealStep: 0,
    revealing: false
  };
  renderTypingHint();
}

function renderTypingHint() {
  const ts = state.typingHintState;
  if (ts.index >= ts.list.length) { showTypingHintResult(); return; }
  const word = ts.list[ts.index];

  const revealStr = ts.revealStep > 0
    ? word.en.slice(0, ts.revealStep) + '_'.repeat(Math.max(0, word.en.length - ts.revealStep))
    : word.en[0] + '_'.repeat(word.en.length - 1);

  const currentTyped = ts.revealing ? '' : (document.getElementById('type-input')?.value || '');

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
      .th-input-area {
        display: flex; align-items: center; justify-content: center;
        gap: 8px; padding: 6px 14px 10px;
      }
      #type-input {
        width: 1px; height: 1px; opacity: 0; position: absolute;
      }
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
        <div class="th-counter">${ts.correct}</div>
      </div>
      <div class="th-card">
        <div class="th-word-color" id="word-color-area">${buildWordColorHTML(word, currentTyped)}</div>
        <div class="th-word-ja">${word.ja}</div>
        <div class="th-typed-row" id="typed-row-area">${buildTypedRowHTML(currentTyped)}</div>
      </div>
      <div class="th-keyboard" id="keyboard-area">
        ${buildKeyboardHTML(word, currentTyped)}
      </div>
      <div class="th-input-area">
        <input id="type-input" type="text"
          autocomplete="off" autocorrect="off" spellcheck="false"
          ${ts.revealing ? 'disabled' : ''}
          oninput="checkTypingHint()" onkeydown="handleTypingHintKey(event)">
        <button class="th-skip" onclick="skipTypingHint()">スキップ</button>
        <button class="th-quit" onclick="showHome()">✕</button>
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
  const val    = inp.value.trim().toLowerCase();
  const target = word.en.toLowerCase();

  // リアルタイムUI更新
  const kbArea        = document.getElementById('keyboard-area');
  const wordColorArea = document.getElementById('word-color-area');
  const typedRowArea  = document.getElementById('typed-row-area');
  if (kbArea)        kbArea.innerHTML        = buildKeyboardHTML(word, inp.value.trim());
  if (wordColorArea) wordColorArea.innerHTML  = buildWordColorHTML(word, inp.value.trim());
  if (typedRowArea)  typedRowArea.innerHTML   = buildTypedRowHTML(inp.value.trim());

  // タイプ音
  const isWrong = val.length > 0 && !target.startsWith(val);
  playTypeSound(false);

  if (val === target) {
    playTypeSound(true);
    ts.correct++;
    inp.disabled = true;
    setTimeout(async () => {
      await addPoints(state.student.id, CONFIG.points.typingCorrect);
      ts.index++;
      ts.revealStep = 0;
      ts.revealing  = false;
      renderTypingHint();
    }, 600);
  }
};

window.handleTypingHintKey = (e) => {
  if (e.key !== 'Enter') return;
  const ts = state.typingHintState;
  if (ts.revealing) return;
  const word = ts.list[ts.index];
  const val  = document.getElementById('type-input')?.value.trim().toLowerCase();
  if (val === word.en.toLowerCase()) return;

  ts.wrong++;
  ts.revealing  = true;
  ts.revealStep = 1;
  renderTypingHint();
  revealNextLetter();
};

function revealNextLetter() {
  const ts = state.typingHintState;
  const word = ts.list[ts.index];
  if (ts.revealStep > word.en.length) {
    const hintEl = document.getElementById('hint-area');
    if (hintEl) hintEl.textContent = word.en;
    setTimeout(() => {
      ts.index++;
      ts.revealStep = 0;
      ts.revealing  = false;
      renderTypingHint();
    }, 1500);
    return;
  }
  const hintEl = document.getElementById('hint-area');
  if (hintEl) {
    hintEl.textContent = word.en.slice(0, ts.revealStep) + '_'.repeat(Math.max(0, word.en.length - ts.revealStep));
  }
  ts.revealStep++;
  setTimeout(revealNextLetter, 350);
}

window.skipTypingHint = () => {
  state.typingHintState.index++;
  state.typingHintState.revealStep = 0;
  state.typingHintState.revealing  = false;
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
  if (qs.index >= qs.list.length) { showQuizResult(); return; }
  const word = qs.list[qs.index];

  // 不正解の選択肢を3つ作る
  const others = shuffle(qs.list.filter(w => w.id !== word.id)).slice(0, 3).map(w => w.ja);
  const choices = shuffle([word.ja, ...others]);
  const pct = Math.round((qs.index / qs.list.length) * 100);

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
        ${choices.map(c => `<button class="choice-btn" onclick="answerQuiz(this,'${c.replace(/'/g,"\\'")}','${word.ja.replace(/'/g,"\\'")}','${word.id}')">${c}</button>`).join('')}
      </div>
      <div id="quiz-feedback" style="text-align:center;font-weight:700;min-height:28px;margin-bottom:12px;font-size:1.05rem"></div>
      <div id="next-btn-wrap" style="text-align:center"></div>
    </div>
  `);
}

window.answerQuiz = async (btn, chosen, correct, wordId) => {
  const qs = state.quizState;
  document.querySelectorAll('.choice-btn').forEach(b => b.disabled = true);
  const fb = document.getElementById('quiz-feedback');
  if (chosen === correct) {
    btn.classList.add('selected-correct');
    fb.textContent = '✨ 正解！';
    fb.style.color = 'var(--success)';
    qs.correct++;
    await addPoints(state.student.id, CONFIG.points.quizCorrect);
  } else {
    btn.classList.add('selected-wrong');
    fb.textContent = `❌ 正解は「${correct}」`;
    fb.style.color = 'var(--danger)';
    document.querySelectorAll('.choice-btn').forEach(b => {
      if (b.textContent === correct) b.classList.add('show-correct');
    });
  }
  document.getElementById('next-btn-wrap').innerHTML =
    `<button class="btn-primary" onclick="nextQuiz()">次へ →</button>`;
};

window.nextQuiz = () => {
  state.quizState.index++;
  renderQuiz();
};

async function showQuizResult() {
  const qs = state.quizState;
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
async function showRanking() {
  state.screen = 'ranking';
  render(`${header()}<div class="container"><p style="color:var(--muted)">読み込み中…</p></div>`);
  const students = await getAllStudents();
  const myRank = students.findIndex(s => s.id === state.student?.id) + 1;

  render(`
    ${header()}
    <div class="container">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
        <h2>🏆 ランキング</h2>
        <button class="btn-secondary btn-sm" onclick="showHome()">← 戻る</button>
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
    if (isMatched)  return `background:#f0fdf4;border-color:#86efac;color:#15803d;opacity:.45;cursor:default;pointer-events:none;`;
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
  const allCards = ms.allCards;
  const card = allCards.find(c => c.id === cardId);
  if (!card || ms.matched.has(card.pairId)) return;

  if (!ms.selected) {
    // 1枚目を選択
    ms.selected = cardId;
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
  // 同じ種類（英語同士・日本語同士）はNG
  if (first.type === card.type) {
    ms.selected = cardId;
    renderMemory();
    return;
  }

  if (first.pairId === card.pairId) {
    // マッチ！
    ms.matched.add(card.pairId);
    ms.selected = null;
    renderMemory();
    if (ms.matched.size === ms.enCards.length) {
      // 全ペア完成
      clearInterval(ms.timerInterval);
      const timeMs = Date.now() - ms.startTime;
      showMemoryResult(timeMs);
    }
  } else {
    // ミス
    ms.misses++;
    ms.selected = null;
    renderMemory();
  }
};

async function showMemoryResult(timeMs) {
  const ms      = state.memoryState;
  const total   = ms.enCards.length;
  const timeStr = formatMemTime(timeMs);
  const timeSec = timeMs / 1000;
  const s       = state.student;

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
        <button class="${tab === 'students' ? 'active' : 'inactive'}" onclick="teacherTab('students')">生徒一覧</button>
        <button class="${tab === 'settings' ? 'active' : 'inactive'}" onclick="teacherTab('settings')">設定</button>
      </div>
      ${content}
    </div>
  `);
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
  const { deleteDoc } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");
  for (const w of words) {
    await deleteDoc(F.doc(db, 'words', w.id));
  }
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

  let count = 0;
  for (const w of words) {
    if (!existingSet.has(w.en.toLowerCase())) {
      await F.addDoc(F.collection(db, 'words'), {
        grade: toGrade, class: toClass, lesson: toLesson,
        en: w.en, ja: w.ja, createdAt: Date.now()
      });
      count++;
    }
  }

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
  let count = 0;
  for (const line of lines) {
    const parts = line.split(',');
    if (parts.length >= 2) {
      const en = parts[0].trim();
      const ja = parts[1].trim();
      if (en && ja) {
        await F.addDoc(F.collection(db, 'words'), { grade, class: cls, lesson, en, ja, createdAt: Date.now() });
        count++;
      }
    }
  }
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

async function renderTeacherStudents() {
  const students = await getAllStudents();
  return `
    <div class="card">
      <h3 style="margin-bottom:16px;color:#7c3aed">👥 生徒一覧 (${students.length}名)</h3>
      <table class="ranking-table">
        <thead><tr><th>順位</th><th>名前</th><th>学年・クラス</th><th>ランク</th><th>ポイント</th></tr></thead>
        <tbody>
          ${students.map((s, i) => {
            const rank = getRank(s.points);
            return `<tr>
              <td class="rank-no">${i + 1}</td>
              <td>${s.name}</td>
              <td><span class="tag tag-grade">${s.grade}</span> <span class="tag tag-class">${s.class}</span></td>
              <td>${rank.emoji} ${rank.name}</td>
              <td>${s.points} pt</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;
}

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
    </div>
  `;
}

// --- 共通ヘッダー ---
function header() {
  const s = state.student;
  const rank = s ? getRank(s.points) : null;
  return `
    <div class="header">
      <h1 onclick="showHome()" style="cursor:pointer">📚 英単語チャレンジ</h1>
      <div class="header-right">
        ${rank ? `<span class="rank-badge">${rank.emoji} ${s.name}</span>` : ''}
        <button class="btn-secondary btn-sm" onclick="state.student=null;state.role=null;showLogin()">ログアウト</button>
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
  showLogin();

  // 先生ダッシュボードの単語一覧を遅延ロード
  document.addEventListener('click', (e) => {
    if (state.screen === 'teacher' && state.teacherTab === 'words') {
      setTimeout(() => loadWordList(), 100);
    }
  });
}

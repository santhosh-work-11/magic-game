/**
 * Magic Square - Cursed Puzzle
 * Horror Theme with Firebase Auth + Firestore
 */

// ===================== UTILS =====================
function shuffleArray(array) {
  const s = [...array];
  for (let i = s.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [s[i], s[j]] = [s[j], s[i]];
  }
  return s;
}

function generateOddMagicSquare(N) {
  const grid = Array(N * N).fill(0);
  let r = 0, c = Math.floor(N / 2);
  for (let num = 1; num <= N * N; num++) {
    grid[r * N + c] = num;
    let nr = (r - 1 + N) % N, nc = (c + 1) % N;
    if (grid[nr * N + nc] !== 0) r = (r + 1) % N;
    else { r = nr; c = nc; }
  }
  return grid;
}

function formatTime(s) {
  return `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
}

// ===================== LEVEL CONFIG =====================
const levelSizes = [3,5,7,9,11,13,15,17,19,21];
const levels = {};
levelSizes.forEach((size, idx) => {
  const lvl = idx + 1;
  levels[lvl] = {
    size,
    target: (size * (size * size + 1)) / 2,
    numbers: Array.from({length: size*size}, (_,i) => i+1),
    get solution() {
      if (!this._solution) this._solution = generateOddMagicSquare(this.size);
      return this._solution;
    },
    unlocked: lvl === 1
  };
});

const starLimits = {
  1:{three:600,two:900}, 2:{three:900,two:1200}, 3:{three:1200,two:1500},
  4:{three:1500,two:1800}, 5:{three:1800,two:2100}, 6:{three:1800,two:2100},
  7:{three:2100,two:2400}, 8:{three:2100,two:2400}, 9:{three:2400,two:2700},
  10:{three:2700,two:3000}
};

function getStars(lvl, secs) {
  const l = starLimits[lvl];
  if (!l) return 1;
  return secs <= l.three ? 3 : secs <= l.two ? 2 : 1;
}

// ===================== GAME STATE =====================
let currentUser = null;
let currentLevel = 1;
let gridState = [];
let selectedCell = null;
let moves = 0;
let timeElapsed = 0;
let timerInterval = null;
let gameActive = false;
let soundEnabled = true;
let autoTransition = null;
let audioCtx = null;

// Confetti
let confettiActive = false;
let confettiParticles = [];
const confettiColors = ['#8a2be2','#ff1493','#da70d6','#4b0082','#ff00ff','#ee82ee'];

// ===================== DOM REFS =====================
const screenLogin = document.getElementById('screen-login');
const screenHome = document.getElementById('screen-home');
const screenLevels = document.getElementById('screen-levels');
const screenGame = document.getElementById('screen-game');
const grid = document.getElementById('grid');
const toast = document.getElementById('toast');
const modalHelp = document.getElementById('modal-help');
const modalVictory = document.getElementById('modal-victory');
const modalConfirm = document.getElementById('modal-confirm');
const modalLeaderboard = document.getElementById('modal-leaderboard');
const modalSettings = document.getElementById('modal-settings');
const victoryCanvas = document.getElementById('victory-canvas');
const victoryCtx = victoryCanvas.getContext('2d');

// ===================== SCREEN MANAGEMENT =====================
function showScreen(id) {
  [screenLogin, screenHome, screenLevels, screenGame].forEach(s => s.classList.add('hidden'));
  document.getElementById(id).classList.remove('hidden');
  if (id === 'screen-home') initMenuBg();
}

// ===================== FIREBASE INIT =====================
window.addEventListener('firebase-ready', () => {
  const { auth, onAuthStateChanged } = window._firebase;

  onAuthStateChanged(auth, (user) => {
    if (user) {
      currentUser = user;
      document.getElementById('user-name').textContent = user.displayName || user.email;
      const avatar = document.getElementById('user-avatar');
      if (user.photoURL) { avatar.src = user.photoURL; avatar.style.display = 'block'; }
      loadProgressFromFirestore();
      showScreen('screen-home');
    } else {
      currentUser = null;
      showScreen('screen-login');
    }
  });

  // Google Login
  document.getElementById('btn-google-login').addEventListener('click', async () => {
    const { auth, GoogleAuthProvider, signInWithPopup } = window._firebase;
    const provider = new GoogleAuthProvider();
    try {
      await signInWithPopup(auth, provider);
    } catch (e) {
      const err = document.getElementById('login-error');
      err.textContent = 'Login failed: ' + e.message;
      err.classList.remove('hidden');
    }
  });

  // Sign Out
  document.getElementById('btn-logout').addEventListener('click', async () => {
    const { auth, signOut } = window._firebase;
    await signOut(auth);
    showScreen('screen-login');
  });
});

// ===================== FIRESTORE SAVE/LOAD =====================
async function saveToFirestore(levelNum, score, movesCount, seconds, stars) {
  if (!currentUser) return;
  if (currentUser.uid === 'guest_user') {
    const records = window._localRecords || {};
    const prev = records[`level_${levelNum}`] || null;
    const prevStars = prev ? (prev.stars || 0) : 0;
    const newStars = Math.max(prevStars, stars);
    const newScore = prev ? Math.max(prev.score || 0, score) : score;
    
    records[`level_${levelNum}`] = {
      level: levelNum,
      score: newScore,
      moves: prev ? Math.min(prev.moves || movesCount, movesCount) : movesCount,
      time: prev ? Math.min(prev.time || seconds, seconds) : seconds,
      stars: newStars,
      displayName: currentUser.displayName,
      uid: currentUser.uid,
      date: new Date().toISOString()
    };
    
    window._localRecords = records;
    localStorage.setItem('guest_scores', JSON.stringify(records));
    
    if (levels[levelNum + 1]) {
      levels[levelNum + 1].unlocked = true;
      const currentHighest = parseInt(localStorage.getItem('guest_unlocked') || '1');
      localStorage.setItem('guest_unlocked', Math.max(currentHighest, levelNum + 1));
    }
    return;
  }
  const { db, doc, setDoc, getDoc } = window._firebase;
  const ref = doc(db, 'users', currentUser.uid, 'scores', `level_${levelNum}`);
  
  try {
    const existing = await getDoc(ref);
    const prev = existing.exists() ? existing.data() : null;
    const prevStars = prev ? (prev.stars || 0) : 0;
    const newStars = Math.max(prevStars, stars);
    const newScore = prev ? Math.max(prev.score || 0, score) : score;
    
    await setDoc(ref, {
      level: levelNum,
      score: newScore,
      moves: prev ? Math.min(prev.moves || movesCount, movesCount) : movesCount,
      time: prev ? Math.min(prev.time || seconds, seconds) : seconds,
      stars: newStars,
      displayName: currentUser.displayName || 'Unknown',
      uid: currentUser.uid,
      date: new Date().toISOString()
    });

    // Also save to global leaderboard
    const lbRef = doc(db, 'leaderboard', `${currentUser.uid}_level_${levelNum}`);
    await setDoc(lbRef, {
      uid: currentUser.uid,
      displayName: currentUser.displayName || 'Unknown',
      level: levelNum,
      score: newScore,
      stars: newStars,
      date: new Date().toISOString()
    });

    // Unlock next level in Firestore
    if (levels[levelNum + 1]) {
      const unlockRef = doc(db, 'users', currentUser.uid, 'progress', 'unlocked');
      const unlocked = levelNum + 1;
      await setDoc(unlockRef, { highestUnlocked: unlocked }, { merge: true });
    }
  } catch (e) {
    console.error('Save error:', e);
  }
}

function loadProgressFromLocal() {
  try {
    const highestUnlocked = parseInt(localStorage.getItem('guest_unlocked') || '1');
    const savedScores = localStorage.getItem('guest_scores');
    const records = savedScores ? JSON.parse(savedScores) : {};
    
    for (let l = 1; l <= 10; l++) {
      if (levels[l]) levels[l].unlocked = (l <= highestUnlocked);
    }
    window._localRecords = records;
    
    updateMenuStats();
    buildLevelsGrid();
    renderLeaderboard();
  } catch(e) {
    console.error('Local progress load error:', e);
  }
}

async function loadProgressFromFirestore() {
  if (!currentUser) return;
  if (currentUser.uid === 'guest_user') {
    loadProgressFromLocal();
    return;
  }
  const { db, doc, getDoc, collection, getDocs } = window._firebase;

  try {
    // Load unlocked progress
    const progressRef = doc(db, 'users', currentUser.uid, 'progress', 'unlocked');
    const progressDoc = await getDoc(progressRef);
    let highestUnlocked = 1;
    if (progressDoc.exists()) {
      highestUnlocked = progressDoc.data().highestUnlocked || 1;
    }

    // Check scores to determine highest completed
    const scoresRef = collection(db, 'users', currentUser.uid, 'scores');
    const scoresSnap = await getDocs(scoresRef);
    const records = {};
    scoresSnap.forEach(d => { records[d.id] = d.data(); });
    
    // Unlock levels based on progress
    for (let l = 1; l <= 10; l++) {
      if (levels[l]) levels[l].unlocked = (l <= highestUnlocked);
    }
    
    // Store records locally for quick access
    window._localRecords = records;
    
    updateMenuStats();
    buildLevelsGrid();
    renderLeaderboard();
  } catch (e) {
    console.error('Load error:', e);
    // Fallback to level 1
    levels[1].unlocked = true;
    window._localRecords = {};
    buildLevelsGrid();
  }
}

async function renderLeaderboard() {
  const { db, collection, getDocs, query, orderBy, limit } = window._firebase;
  const list = document.getElementById('leaderboard-list');
  if (!list) return;

  try {
    const q = query(collection(db, 'leaderboard'), orderBy('score', 'desc'), limit(10));
    const snap = await getDocs(q);
    list.innerHTML = '';
    
    if (snap.empty) {
      list.innerHTML = '<div style="color:var(--bone-dim);font-style:italic;text-align:center;padding:20px">No cursed players yet...</div>';
      return;
    }
    
    let rank = 1;
    snap.forEach(d => {
      const data = d.data();
      const item = document.createElement('div');
      item.className = 'lb-item';
      item.innerHTML = `
        <span class="lb-rank">#${rank}</span>
        <span class="lb-name">${data.displayName || 'Unknown'}</span>
        <span class="lb-score">${data.score} pts</span>
      `;
      list.appendChild(item);
      rank++;
    });
  } catch (e) {
    list.innerHTML = '<div style="color:var(--bone-dim);font-style:italic;text-align:center;padding:20px">Could not load...</div>';
  }
}

// ===================== MENU STATS =====================
function updateMenuStats() {
  const records = window._localRecords || {};
  let completed = 0, totalTime = 0;
  for (let l = 1; l <= 10; l++) {
    if (records[`level_${l}`]) {
      completed++;
      totalTime += records[`level_${l}`].time || 0;
    }
  }
  const el1 = document.getElementById('stat-completed');
  const el2 = document.getElementById('stat-time');
  if (el1) el1.textContent = `${completed}/10`;
  if (el2) el2.textContent = formatTime(totalTime);
}

// ===================== HOME MENU =====================
function bindHomeMenu() {
  const btns = [
    { id: 'btn-continue', action: () => { continueLast(); } },
    { id: 'btn-new-game', action: () => openModal(modalConfirm) },
    { id: 'btn-levels', action: () => showScreen('screen-levels') },
    { id: 'btn-leaderboard', action: () => openModal(modalLeaderboard) },
    { id: 'btn-settings', action: () => openModal(modalSettings) },
  ];

  btns.forEach(({ id, action }) => {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.addEventListener('mouseenter', () => {
      btns.forEach(b => document.getElementById(b.id)?.classList.remove('active'));
      btn.classList.add('active');
    });
    btn.addEventListener('click', () => {
      playSound('click');
      if (action) action();
    });
  });
}

function continueLast() {
  const records = window._localRecords || {};
  let highest = 0;
  for (let l = 1; l <= 10; l++) {
    if (records[`level_${l}`]) highest = l;
    else break;
  }
  const next = Math.min(10, highest + 1);
  initLevel(next);
  showScreen('screen-game');
}

// ===================== LEVELS GRID =====================
function buildLevelsGrid() {
  const container = document.getElementById('levels-grid');
  if (!container) return;
  container.innerHTML = '';
  const records = window._localRecords || {};

  for (let l = 1; l <= 10; l++) {
    const config = levels[l];
    const card = document.createElement('div');
    card.className = `level-card${config.unlocked ? '' : ' locked'}${l === currentLevel ? ' active' : ''}`;
    card.dataset.level = l;

    const isCompleted = !!records[`level_${l}`];
    const stars = isCompleted ? (records[`level_${l}`].stars || 0) : 0;
    const icon = config.unlocked ? (isCompleted ? 'check-circle' : 'play-circle') : 'lock';

    let starsHtml = '';
    if (config.unlocked) {
      for (let i = 1; i <= 3; i++) starsHtml += `<span>${i <= stars ? '⭐' : '☆'}</span>`;
    }

    card.innerHTML = `
      <div>
        <div class="level-num">Level ${l}</div>
        <div class="level-desc">${config.size}×${config.size} (Sum ${config.target})</div>
        <div class="level-stars">${starsHtml}</div>
      </div>
      <i data-lucide="${icon}" class="level-icon"></i>
    `;

    if (config.unlocked) {
      card.addEventListener('click', () => {
        playSound('click');
        initLevel(l);
        showScreen('screen-game');
      });
    }
    container.appendChild(card);
  }
  if (window.lucide) lucide.createIcons();
}

// ===================== INIT LEVEL =====================
function initLevel(lvl) {
  if (autoTransition) { clearTimeout(autoTransition); autoTransition = null; }
  currentLevel = lvl;
  const cfg = levels[lvl];

  document.getElementById('level-title').textContent = `Level ${lvl}: ${cfg.size}×${cfg.size}`;
  document.getElementById('stat-target').textContent = cfg.target;

  moves = 0;
  document.getElementById('stat-moves').textContent = 0;
  resetTimer();

  gridState = shuffleArray(cfg.numbers);
  selectedCell = null;

  buildGrid();
  updateStarTargets();
  gameActive = true;
  startTimer();
}

function resetBoard() {
  const cfg = levels[currentLevel];
  gridState = shuffleArray(cfg.numbers);
  moves = 0;
  document.getElementById('stat-moves').textContent = 0;
  resetTimer();
  selectedCell = null;
  buildGrid();
  gameActive = true;
  startTimer();
}

// ===================== GRID BUILDER =====================
function buildGrid() {
  const size = levels[currentLevel].size;
  grid.innerHTML = '';

  const fontSize = size > 17 ? '9px' : size > 13 ? '11px' : size > 9 ? '13px' : size > 6 ? '15px' : size > 4 ? '18px' : '26px';
  const gap = size > 15 ? '3px' : size > 9 ? '5px' : size > 5 ? '7px' : '10px';
  grid.style.setProperty('--cell-font-size', fontSize);
  grid.style.gap = gap;
  grid.style.gridTemplateColumns = `repeat(${size}, 1fr) auto`;
  grid.style.gridTemplateRows = `repeat(${size}, 1fr) auto`;

  for (let r = 0; r <= size; r++) {
    for (let c = 0; c <= size; c++) {
      if (r < size && c < size) {
        const idx = r * size + c;
        const cell = document.createElement('div');
        cell.className = 'grid-cell';
        cell.dataset.index = idx;
        cell.setAttribute('draggable', 'true');
        if (idx === selectedCell) cell.classList.add('selected');

        const val = document.createElement('div');
        val.className = 'cell-val';
        val.textContent = gridState[idx];
        cell.appendChild(val);
        grid.appendChild(cell);
      } else if (r < size && c === size) {
        const ind = document.createElement('div');
        ind.className = 'indicator-cell incorrect';
        ind.id = `row-${r}`;
        const lbl = size <= 7 ? `<span style="font-size:8px;opacity:0.6">R${r+1}</span>` : '';
        ind.innerHTML = `${lbl}<span class="sum-val">0</span>`;
        grid.appendChild(ind);
      } else if (r === size && c < size) {
        const ind = document.createElement('div');
        ind.className = 'indicator-cell incorrect';
        ind.id = `col-${c}`;
        const lbl = size <= 7 ? `<span style="font-size:8px;opacity:0.6">C${c+1}</span>` : '';
        ind.innerHTML = `${lbl}<span class="sum-val">0</span>`;
        grid.appendChild(ind);
      } else {
        const ind = document.createElement('div');
        ind.className = 'indicator-cell diagonal-indicator';
        ind.id = 'diag-corner';
        ind.innerHTML = `
          <div class="diag-sum" id="diag-main"><span style="opacity:0.5">↘</span><span class="sum-val">0</span></div>
          <div class="diag-sum" id="diag-anti" style="margin-top:3px"><span style="opacity:0.5">↙</span><span class="sum-val">0</span></div>
        `;
        grid.appendChild(ind);
      }
    }
  }

  highlightDuplicates();
  updateSums();
}

function highlightDuplicates() {
  const counts = {};
  gridState.forEach(v => { if (v !== null) counts[v] = (counts[v] || 0) + 1; });
  document.querySelectorAll('.grid-cell').forEach(cell => {
    const idx = parseInt(cell.dataset.index);
    if (!isNaN(idx)) {
      const dup = counts[gridState[idx]] > 1;
      cell.classList.toggle('duplicate', dup);
    }
  });
}

// ===================== SUMS =====================
function updateSums() {
  const size = levels[currentLevel].size;
  const target = levels[currentLevel].target;

  for (let r = 0; r < size; r++) {
    let sum = 0;
    for (let c = 0; c < size; c++) sum += gridState[r * size + c] || 0;
    const el = document.getElementById(`row-${r}`);
    if (el) {
      el.querySelector('.sum-val').textContent = sum;
      el.className = `indicator-cell ${sum === target ? 'correct' : 'incorrect'}`;
    }
  }

  for (let c = 0; c < size; c++) {
    let sum = 0;
    for (let r = 0; r < size; r++) sum += gridState[r * size + c] || 0;
    const el = document.getElementById(`col-${c}`);
    if (el) {
      el.querySelector('.sum-val').textContent = sum;
      el.className = `indicator-cell ${sum === target ? 'correct' : 'incorrect'}`;
    }
  }

  let mainSum = 0, antiSum = 0;
  for (let i = 0; i < size; i++) {
    mainSum += gridState[i * size + i] || 0;
    antiSum += gridState[i * size + (size - 1 - i)] || 0;
  }

  const dMain = document.getElementById('diag-main');
  const dAnti = document.getElementById('diag-anti');
  const dCorner = document.getElementById('diag-corner');

  if (dMain) {
    dMain.querySelector('.sum-val').textContent = mainSum;
    dMain.querySelector('.sum-val').style.color = mainSum === target ? 'var(--green-glow)' : '';
  }
  if (dAnti) {
    dAnti.querySelector('.sum-val').textContent = antiSum;
    dAnti.querySelector('.sum-val').style.color = antiSum === target ? 'var(--green-glow)' : '';
  }
  if (dCorner) {
    dCorner.className = `indicator-cell diagonal-indicator${mainSum === target && antiSum === target ? ' correct' : ''}`;
  }
}

// ===================== WIN CHECK =====================
function checkWin() {
  if (!gameActive) return;
  const size = levels[currentLevel].size;
  const target = levels[currentLevel].target;

  for (let r = 0; r < size; r++) {
    let sum = 0;
    for (let c = 0; c < size; c++) { const v = gridState[r*size+c]; if (v===null) return; sum+=v; }
    if (sum !== target) return;
  }
  for (let c = 0; c < size; c++) {
    let sum = 0;
    for (let r = 0; r < size; r++) sum += gridState[r*size+c];
    if (sum !== target) return;
  }
  let m = 0, a = 0;
  for (let i = 0; i < size; i++) { m += gridState[i*size+i]; a += gridState[i*size+(size-1-i)]; }
  if (m !== target || a !== target) return;

  handleWin();
}

function handleWin() {
  gameActive = false;
  stopTimer();
  playSound('victory');

  const score = calculateScore();
  const stars = getStars(currentLevel, timeElapsed);

  saveToFirestore(currentLevel, score, moves, timeElapsed, stars);

  if (levels[currentLevel + 1]) {
    levels[currentLevel + 1].unlocked = true;
    buildLevelsGrid();
  }

  // Victory modal
  document.getElementById('victory-title').textContent = `Level ${currentLevel} Complete!`;
  document.getElementById('v-time').textContent = formatTime(timeElapsed);
  document.getElementById('v-moves').textContent = moves;
  document.getElementById('v-score').textContent = score;

  const starsEl = document.getElementById('victory-stars');
  starsEl.innerHTML = '';
  for (let i = 1; i <= 3; i++) {
    const s = document.createElement('span');
    s.textContent = '⭐';
    if (i > stars) s.className = 'unfilled';
    starsEl.appendChild(s);
  }

  const nextBtn = document.getElementById('btn-next-level');
  nextBtn.style.display = levels[currentLevel + 1] ? 'block' : 'none';

  startConfetti();
  showToast('Curse lifted! Level complete!');

  setTimeout(() => openModal(modalVictory), 500);

  autoTransition = setTimeout(() => {
    if (levels[currentLevel + 1]) nextLevel();
    else { closeModal(modalVictory); showToast('All curses lifted! You are free!'); }
  }, 4000);
}

function calculateScore() {
  const base = 10000 + levels[currentLevel].size * 2000;
  return Math.max(100, base - timeElapsed * 10 - moves * 30);
}

// ===================== STAR TARGETS UI =====================
function updateStarTargets() {
  const container = document.getElementById('star-targets');
  if (!container) return;
  const l = starLimits[currentLevel];
  if (!l) { container.innerHTML = ''; return; }
  container.innerHTML = `
    <span class="star-badge">⭐⭐⭐ ≤${l.three/60}m</span>
    <span class="star-badge">⭐⭐ ≤${l.two/60}m</span>
    <span class="star-badge">⭐ >${l.two/60}m</span>
  `;
}

// ===================== TIMER =====================
function startTimer() {
  stopTimer();
  timerInterval = setInterval(() => {
    timeElapsed++;
    document.getElementById('stat-timer').textContent = formatTime(timeElapsed);
  }, 1000);
}
function stopTimer() { if (timerInterval) clearInterval(timerInterval); }
function resetTimer() {
  stopTimer();
  timeElapsed = 0;
  document.getElementById('stat-timer').textContent = '00:00';
}

// ===================== TOAST =====================
let toastTimer = null;
function showToast(msg, type = 'success') {
  if (toastTimer) clearTimeout(toastTimer);
  toast.querySelector('span').textContent = msg;
  toast.className = `toast${type === 'error' ? ' error' : ''}`;
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 3000);
}

// ===================== MODALS =====================
function openModal(modal) {
  modal.classList.remove('hidden');
  modal.style.display = 'flex';
}
function closeModal(modal) {
  modal.classList.add('hidden');
  if (modal === modalVictory) {
    confettiActive = false;
    if (autoTransition) { clearTimeout(autoTransition); autoTransition = null; }
  }
}

// ===================== SOUND =====================
function initAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
}
function playSound(type) {
  if (!soundEnabled) return;
  initAudio();
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  const now = audioCtx.currentTime;

  switch(type) {
    case 'click':
      osc.type = 'triangle'; osc.frequency.setValueAtTime(300, now);
      gain.gain.setValueAtTime(0.06, now); gain.gain.exponentialRampToValueAtTime(0.001, now+0.05);
      osc.start(now); osc.stop(now+0.05); break;
    case 'place':
      osc.type = 'sawtooth'; osc.frequency.setValueAtTime(200, now); osc.frequency.exponentialRampToValueAtTime(400, now+0.1);
      gain.gain.setValueAtTime(0.08, now); gain.gain.exponentialRampToValueAtTime(0.001, now+0.15);
      osc.start(now); osc.stop(now+0.15); break;
    case 'error':
      osc.type = 'sawtooth'; osc.frequency.setValueAtTime(100, now);
      gain.gain.setValueAtTime(0.1, now); gain.gain.exponentialRampToValueAtTime(0.001, now+0.3);
      osc.start(now); osc.stop(now+0.3); break;
    case 'victory':
      const notes = [220, 277, 330, 440];
      notes.forEach((f, i) => {
        const o = audioCtx.createOscillator(), g = audioCtx.createGain();
        o.type = 'sine'; o.frequency.value = f;
        o.connect(g); g.connect(audioCtx.destination);
        g.gain.setValueAtTime(0.08, now + i*0.1);
        g.gain.exponentialRampToValueAtTime(0.001, now + i*0.1 + 0.5);
        o.start(now + i*0.1); o.stop(now + i*0.1 + 0.5);
      }); break;
  }
}

function toggleSound() {
  soundEnabled = !soundEnabled;
  updateSoundUI();
  if (soundEnabled) playSound('click');
}

function updateSoundUI() {
  const label = soundEnabled ? 'Sound ON' : 'Sound OFF';
  const icon = soundEnabled ? 'volume-2' : 'volume-x';
  
  ['btn-sound-game', 'btn-sound-ctrl'].forEach(id => {
    const btn = document.getElementById(id);
    if (!btn) return;
    const i = btn.querySelector('i');
    if (i) i.setAttribute('data-lucide', icon);
  });

  const soundLabel = document.querySelector('.sound-label');
  if (soundLabel) soundLabel.textContent = soundEnabled ? 'Sound' : 'Muted';

  const toggle = document.getElementById('btn-sound-toggle');
  if (toggle) toggle.textContent = soundEnabled ? 'ON' : 'OFF';

  if (window.lucide) lucide.createIcons();
}

// ===================== CONFETTI =====================
function resizeVictoryCanvas() {
  victoryCanvas.width = window.innerWidth;
  victoryCanvas.height = window.innerHeight;
}
function startConfetti() {
  confettiActive = true;
  confettiParticles = [];
  resizeVictoryCanvas();
  for (let i = 0; i < 120; i++) {
    confettiParticles.push({
      x: Math.random() * victoryCanvas.width,
      y: Math.random() * victoryCanvas.height - victoryCanvas.height,
      r: Math.random() * 6 + 3,
      d: Math.random() * 100,
      color: confettiColors[Math.floor(Math.random() * confettiColors.length)],
      tiltAngle: 0,
      tiltInc: Math.random() * 0.07 + 0.02
    });
  }
  animateConfetti();
}
function animateConfetti() {
  if (!confettiActive) { victoryCtx.clearRect(0,0,victoryCanvas.width,victoryCanvas.height); return; }
  victoryCtx.clearRect(0,0,victoryCanvas.width,victoryCanvas.height);
  let rem = 0;
  confettiParticles.forEach(p => {
    p.tiltAngle += p.tiltInc;
    p.y += (Math.cos(p.d) + 3 + p.r/2) / 2;
    p.x += Math.sin(p.tiltAngle) * 0.5;
    p.tilt = Math.sin(p.tiltAngle - confettiParticles.indexOf(p)/3) * 12;
    if (p.y <= victoryCanvas.height) rem++;
    victoryCtx.beginPath();
    victoryCtx.lineWidth = p.r;
    victoryCtx.strokeStyle = p.color;
    victoryCtx.moveTo(p.x + p.tilt + p.r/2, p.y);
    victoryCtx.lineTo(p.x + p.tilt, p.y + p.tilt + p.r/2);
    victoryCtx.stroke();
  });
  if (rem > 0) requestAnimationFrame(animateConfetti);
  else confettiActive = false;
}

// ===================== MENU BACKGROUND =====================
let menuBgCanvas, menuBgCtx, menuBgParticles = [], menuBgAnim;
function initMenuBg() {
  menuBgCanvas = document.getElementById('menu-bg-canvas');
  if (!menuBgCanvas) return;
  menuBgCtx = menuBgCanvas.getContext('2d');
  menuBgCanvas.width = window.innerWidth;
  menuBgCanvas.height = window.innerHeight;
  menuBgParticles = [];
  for (let i = 0; i < 40; i++) {
    menuBgParticles.push({
      x: Math.random() * menuBgCanvas.width,
      y: Math.random() * menuBgCanvas.height,
      vx: (Math.random()-0.5)*0.3, vy: (Math.random()-0.5)*0.3,
      r: Math.random()*2+1,
      alpha: Math.random()*0.4+0.1,
      color: Math.random()>0.5 ? '#ff1493' : '#8a2be2'
    });
  }
  if (menuBgAnim) cancelAnimationFrame(menuBgAnim);
  animateMenuBg();
}
function animateMenuBg() {
  if (!menuBgCtx) return;
  menuBgCtx.fillStyle = 'rgba(12,2,20,0.15)';
  menuBgCtx.fillRect(0, 0, menuBgCanvas.width, menuBgCanvas.height);
  menuBgParticles.forEach((p,i) => {
    p.x += p.vx; p.y += p.vy;
    if (p.x < 0) p.x = menuBgCanvas.width;
    if (p.x > menuBgCanvas.width) p.x = 0;
    if (p.y < 0) p.y = menuBgCanvas.height;
    if (p.y > menuBgCanvas.height) p.y = 0;
    menuBgCtx.globalAlpha = p.alpha;
    menuBgCtx.beginPath();
    menuBgCtx.arc(p.x, p.y, p.r, 0, Math.PI*2);
    menuBgCtx.fillStyle = p.color;
    menuBgCtx.shadowBlur = 8; menuBgCtx.shadowColor = p.color;
    menuBgCtx.fill();
    menuBgParticles.slice(i+1).forEach(p2 => {
      const dx = p.x-p2.x, dy = p.y-p2.y, dist = Math.hypot(dx,dy);
      if (dist < 100) {
        menuBgCtx.beginPath();
        menuBgCtx.moveTo(p.x, p.y); menuBgCtx.lineTo(p2.x, p2.y);
        menuBgCtx.strokeStyle = `rgba(138,43,226,${(100-dist)/100*0.15})`;
        menuBgCtx.lineWidth = 0.5;
        menuBgCtx.globalAlpha = 1;
        menuBgCtx.stroke();
      }
    });
  });
  menuBgCtx.globalAlpha = 1;
  menuBgCtx.shadowBlur = 0;
  menuBgAnim = requestAnimationFrame(animateMenuBg);
}

// ===================== EVENT LISTENERS =====================
document.addEventListener('DOMContentLoaded', () => {
  resizeVictoryCanvas();
  window.addEventListener('resize', resizeVictoryCanvas);

  // Bind everything immediately for quick offline play
  bindHomeMenu();
  setupGameEvents();
  setupSettingsEvents();
  if (window.lucide) lucide.createIcons();

  // Guest Login click
  document.getElementById('btn-guest-login')?.addEventListener('click', () => {
    currentUser = {
      uid: 'guest_user',
      displayName: 'Guest Cursed One',
      photoURL: null
    };
    document.getElementById('user-name').textContent = currentUser.displayName;
    const avatar = document.getElementById('user-avatar');
    if (avatar) avatar.style.display = 'none';
    
    loadProgressFromLocal();
    showScreen('screen-home');
  });

  // Wait for Firebase
  window.addEventListener('firebase-ready', () => {
    const { auth, onAuthStateChanged } = window._firebase;

    onAuthStateChanged(auth, (user) => {
      if (user) {
        currentUser = user;
        document.getElementById('user-name').textContent = user.displayName || user.email;
        const avatar = document.getElementById('user-avatar');
        if (user.photoURL) { avatar.src = user.photoURL; avatar.style.display = 'block'; }
        loadProgressFromFirestore();
        showScreen('screen-home');
      } else {
        if (!currentUser || currentUser.uid !== 'guest_user') {
          currentUser = null;
          showScreen('screen-login');
        }
      }
    });

    // Google Login
    document.getElementById('btn-google-login')?.addEventListener('click', async () => {
      const { auth, GoogleAuthProvider, signInWithPopup } = window._firebase;
      const provider = new GoogleAuthProvider();
      try {
        await signInWithPopup(auth, provider);
      } catch (e) {
        const err = document.getElementById('login-error');
        if (err) {
          err.textContent = 'Login failed: ' + e.message;
          err.classList.remove('hidden');
        }
      }
    });

    // Sign Out
    document.getElementById('btn-logout')?.addEventListener('click', async () => {
      const { auth, signOut } = window._firebase;
      try {
        await signOut(auth);
      } catch(e) {}
      currentUser = null;
      showScreen('screen-login');
    });
  });
});

function setupGameEvents() {
  // Levels back
  document.getElementById('btn-levels-back')?.addEventListener('click', () => {
    playSound('click');
    showScreen('screen-home');
  });

  // Game controls
  document.getElementById('btn-next-top')?.addEventListener('click', () => {
    playSound('click');
    const next = currentLevel + 1;
    if (levels[next]?.unlocked) initLevel(next);
    else showToast('Next level is locked!', 'error');
  });
  document.getElementById('btn-reset')?.addEventListener('click', () => { playSound('click'); resetBoard(); });
  document.getElementById('btn-sound-ctrl')?.addEventListener('click', toggleSound);
  document.getElementById('btn-sound-game')?.addEventListener('click', toggleSound);
  document.getElementById('btn-back-levels')?.addEventListener('click', () => {
    playSound('click');
    stopTimer();
    gameActive = false;
    showScreen('screen-levels');
  });
  document.getElementById('btn-back-home')?.addEventListener('click', () => {
    playSound('click');
    stopTimer();
    gameActive = false;
    showScreen('screen-home');
  });
  document.getElementById('btn-help-game')?.addEventListener('click', () => { playSound('click'); openModal(modalHelp); });

  // Help modal
  document.getElementById('btn-close-help')?.addEventListener('click', () => closeModal(modalHelp));
  document.getElementById('btn-start')?.addEventListener('click', () => closeModal(modalHelp));

  // Victory modal
  document.getElementById('btn-next-level')?.addEventListener('click', () => { playSound('click'); nextLevel(); });
  document.getElementById('btn-play-again')?.addEventListener('click', () => { playSound('click'); closeModal(modalVictory); resetBoard(); });

  // Confirm reset
  document.getElementById('btn-confirm-yes')?.addEventListener('click', async () => {
    if (!currentUser) return;
    if (currentUser.uid === 'guest_user') {
      window._localRecords = {};
      for (let l = 1; l <= 10; l++) { if (levels[l]) levels[l].unlocked = (l === 1); }
      localStorage.removeItem('guest_unlocked');
      localStorage.removeItem('guest_scores');
      updateMenuStats();
      buildLevelsGrid();
      closeModal(modalConfirm);
      showToast('Progress wiped!');
      initLevel(1);
      showScreen('screen-game');
      return;
    }
    try {
      const { db, doc, setDoc } = window._firebase;
      // Note: just reset local and unlock
      window._localRecords = {};
      for (let l = 1; l <= 10; l++) { if (levels[l]) levels[l].unlocked = (l === 1); }
      
      // Reset progress in firestore
      const unlockRef = doc(db, 'users', currentUser.uid, 'progress', 'unlocked');
      await setDoc(unlockRef, { highestUnlocked: 1 }, { merge: true });

      // Wipe user scores collections in Firestore if needed, but local records reset + level 1 unlock is sufficient.
      updateMenuStats();
      buildLevelsGrid();
      closeModal(modalConfirm);
      showToast('Progress wiped!');
      initLevel(1);
      showScreen('screen-game');
    } catch(e) { console.error(e); }
  });
  document.getElementById('btn-confirm-no')?.addEventListener('click', () => closeModal(modalConfirm));

  // Grid click & drag
  setupGridInteraction();
}

function nextLevel() {
  closeModal(modalVictory);
  const next = currentLevel + 1;
  if (levels[next] && levels[next].unlocked) { initLevel(next); }
}

function setupGridInteraction() {
  // Click to select/swap
  grid.addEventListener('click', (e) => {
    if (!gameActive) return;
    const cell = e.target.closest('.grid-cell');
    if (!cell) return;
    e.stopPropagation();
    const idx = parseInt(cell.dataset.index);
    if (isNaN(idx)) return;

    if (selectedCell === null) {
      selectedCell = idx;
      buildGrid();
      playSound('click');
    } else if (selectedCell === idx) {
      selectedCell = null;
      buildGrid();
    } else {
      [gridState[selectedCell], gridState[idx]] = [gridState[idx], gridState[selectedCell]];
      selectedCell = null;
      moves++;
      document.getElementById('stat-moves').textContent = moves;
      playSound('place');
      buildGrid();
      checkWin();
    }
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.grid-cell') && selectedCell !== null) {
      selectedCell = null;
      buildGrid();
    }
  });

  // Drag & drop
  let dragIdx = null;
  grid.addEventListener('dragstart', (e) => {
    if (!gameActive) return;
    const cell = e.target.closest('.grid-cell');
    if (!cell) return;
    dragIdx = parseInt(cell.dataset.index);
    cell.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    playSound('click');
  });
  grid.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; });
  grid.addEventListener('dragenter', (e) => {
    const cell = e.target.closest('.grid-cell');
    if (cell && parseInt(cell.dataset.index) !== dragIdx) cell.classList.add('drag-hover');
  });
  grid.addEventListener('dragleave', (e) => {
    const cell = e.target.closest('.grid-cell');
    if (cell) cell.classList.remove('drag-hover');
  });
  grid.addEventListener('drop', (e) => {
    e.preventDefault();
    if (!gameActive) return;
    const cell = e.target.closest('.grid-cell');
    if (!cell) return;
    const targetIdx = parseInt(cell.dataset.index);
    if (isNaN(targetIdx) || dragIdx === null || targetIdx === dragIdx) return;
    [gridState[dragIdx], gridState[targetIdx]] = [gridState[targetIdx], gridState[dragIdx]];
    moves++;
    document.getElementById('stat-moves').textContent = moves;
    playSound('place');
    buildGrid();
    checkWin();
  });
  grid.addEventListener('dragend', () => {
    document.querySelectorAll('.grid-cell').forEach(c => {
      c.classList.remove('dragging', 'drag-hover');
    });
    dragIdx = null;
  });
}

function setupSettingsEvents() {
  document.getElementById('btn-sound-toggle')?.addEventListener('click', toggleSound);
  document.getElementById('btn-clear-progress')?.addEventListener('click', () => {
    playSound('click');
    openModal(modalConfirm);
  });
  document.getElementById('btn-show-rules')?.addEventListener('click', () => {
    playSound('click');
    openModal(modalHelp);
  });

  // Modal close handlers
  document.getElementById('btn-close-leaderboard')?.addEventListener('click', () => closeModal(modalLeaderboard));
  document.getElementById('btn-close-settings')?.addEventListener('click', () => closeModal(modalSettings));
}

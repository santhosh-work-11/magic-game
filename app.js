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
  return String(Math.floor(s/60)).padStart(2,'0') + ':' + String(s%60).padStart(2,'0');
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
const confettiColors = ['#9f5cf6','#d4af37','#ffe89e','#7c3aed','#ffd700','#a855f7'];

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
      const nameEl = document.getElementById('user-name');
      if (nameEl) nameEl.textContent = user.displayName || user.email;
      const avatar = document.getElementById('user-avatar');
      if (avatar && user.photoURL) { avatar.src = user.photoURL; avatar.style.display = 'block'; }
      loadProgressFromFirestore();
      showScreen('screen-home');
    } else {
      currentUser = null;
      showScreen('screen-login');
    }
  });

  // Google Login
  const loginBtn = document.getElementById('btn-google-login');
  if (loginBtn) {
    loginBtn.addEventListener('click', async () => {
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
  }

  // Sign Out
  const logoutBtn = document.getElementById('btn-logout');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      const { auth, signOut } = window._firebase;
      await signOut(auth);
      showScreen('screen-login');
    });
  }

  bindHomeMenu();
  setupGameEvents();
  setupSettingsEvents();
  if (window.lucide) lucide.createIcons();
});

// ===================== FIRESTORE SAVE/LOAD =====================
async function saveToFirestore(levelNum, score, movesCount, seconds, stars) {
  if (!currentUser) return;
  const { db, doc, setDoc, getDoc } = window._firebase;
  const ref = doc(db, 'users', currentUser.uid, 'scores', 'level_' + levelNum);
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
    if (levels[levelNum + 1]) {
      const unlockRef = doc(db, 'users', currentUser.uid, 'progress', 'unlocked');
      await setDoc(unlockRef, { highestUnlocked: levelNum + 1 }, { merge: true });
    }
    await updateGlobalLeaderboard();
  } catch (e) {
    console.error('Save error:', e);
  }
}

async function updateGlobalLeaderboard() {
  if (!currentUser) return;
  const { db, doc, setDoc, collection, getDocs } = window._firebase;
  try {
    const scoresRef = collection(db, 'users', currentUser.uid, 'scores');
    const snap = await getDocs(scoresRef);
    let totalScore = 0, totalStars = 0, levelsCompleted = 0;
    snap.forEach(d => {
      const data = d.data();
      totalScore += data.score || 0;
      totalStars += data.stars || 0;
      levelsCompleted++;
    });
    const lbRef = doc(db, 'leaderboard', currentUser.uid);
    await setDoc(lbRef, {
      uid: currentUser.uid,
      displayName: currentUser.displayName || 'Unknown',
      photoURL: currentUser.photoURL || '',
      totalScore,
      totalStars,
      levelsCompleted,
      date: new Date().toISOString()
    });
  } catch (e) {
    console.error('Leaderboard update error:', e);
  }
}

async function loadProgressFromFirestore() {
  if (!currentUser) return;
  const { db, doc, getDoc, collection, getDocs } = window._firebase;
  try {
    const progressRef = doc(db, 'users', currentUser.uid, 'progress', 'unlocked');
    const progressDoc = await getDoc(progressRef);
    let highestUnlocked = 1;
    if (progressDoc.exists()) {
      highestUnlocked = progressDoc.data().highestUnlocked || 1;
    }
    const scoresRef = collection(db, 'users', currentUser.uid, 'scores');
    const scoresSnap = await getDocs(scoresRef);
    const records = {};
    scoresSnap.forEach(d => { records[d.id] = d.data(); });
    for (let l = 1; l <= 10; l++) {
      if (levels[l]) levels[l].unlocked = (l <= highestUnlocked);
    }
    window._localRecords = records;
    updateMenuStats();
    buildLevelsGrid();
    renderLeaderboard();
  } catch (e) {
    console.error('Load error:', e);
    levels[1].unlocked = true;
    window._localRecords = {};
    buildLevelsGrid();
  }
}

async function renderLeaderboard() {
  const { db, collection, getDocs, query, orderBy, limit } = window._firebase;
  const list = document.getElementById('leaderboard-list');
  if (!list) return;
  list.innerHTML = '<div style="color:var(--text-dim);text-align:center;padding:20px;font-style:italic">Loading...</div>';
  try {
    const q = query(collection(db, 'leaderboard'), orderBy('totalScore', 'desc'), limit(10));
    const snap = await getDocs(q);
    list.innerHTML = '';
    if (snap.empty) {
      list.innerHTML = '<div style="color:var(--text-dim);font-style:italic;text-align:center;padding:20px">No players yet... Be the first!</div>';
      return;
    }
    const medals = ['🥇', '🥈', '🥉'];
    let rank = 1;
    snap.forEach(d => {
      const data = d.data();
      const isMe = data.uid === (currentUser && currentUser.uid);
      const item = document.createElement('div');
      item.className = 'lb-item' + (isMe ? ' lb-mine' : '');
      const medal = medals[rank-1] || '#' + rank;
      const avatarHtml = data.photoURL ? '<img src="' + data.photoURL + '" class="lb-avatar" onerror="this.style.display=\'none\'">' : '';
      const nameHtml = '<span class="lb-name">' + (data.displayName || 'Unknown') + (isMe ? ' (You)' : '') + '</span>';
      const rightHtml = '<div class="lb-right"><span class="lb-score">' + (data.totalScore||0).toLocaleString() + ' pts</span><span class="lb-levels">' + (data.levelsCompleted||0) + '/10 levels</span></div>';
      item.innerHTML = '<span class="lb-rank">' + medal + '</span>' + avatarHtml + nameHtml + rightHtml;
      list.appendChild(item);
      rank++;
    });
  } catch(e) {
    list.innerHTML = '<div style="color:var(--text-dim);font-style:italic;text-align:center;padding:20px">Could not load leaderboard</div>';
    console.error(e);
  }
}

// ===================== MENU STATS =====================
function updateMenuStats() {
  const records = window._localRecords || {};
  let completed = 0, totalTime = 0;
  for (let l = 1; l <= 10; l++) {
    if (records['level_' + l]) {
      completed++;
      totalTime += records['level_' + l].time || 0;
    }
  }
  const el1 = document.getElementById('stat-completed');
  const el2 = document.getElementById('stat-time');
  if (el1) el1.textContent = completed + '/10';
  if (el2) el2.textContent = formatTime(totalTime);
}

// ===================== HOME MENU =====================
function bindHomeMenu() {
  const btns = [
    { id: 'btn-continue', action: continueLast, section: null },
    { id: 'btn-new-game', action: () => openModal(modalConfirm), section: null },
    { id: 'btn-levels', action: () => showScreen('screen-levels'), section: null },
    { id: 'btn-leaderboard', action: null, section: 'details-leaderboard' },
    { id: 'btn-settings', action: null, section: 'details-settings' },
  ];

  btns.forEach(function(cfg) {
    const btn = document.getElementById(cfg.id);
    if (!btn) return;
    btn.addEventListener('mouseenter', function() {
      btns.forEach(function(b) {
        const el = document.getElementById(b.id);
        if (el) el.classList.remove('active');
      });
      btn.classList.add('active');
      showDetailSection(cfg.section || 'details-default');
    });
    btn.addEventListener('click', function() {
      playSound('click');
      if (cfg.action) cfg.action();
    });
  });
}

function showDetailSection(id) {
  document.querySelectorAll('.detail-sec').forEach(function(s) {
    s.classList.add('hidden');
    s.classList.remove('active');
  });
  const sec = document.getElementById(id);
  if (sec) { sec.classList.remove('hidden'); sec.classList.add('active'); }
}

function continueLast() {
  const records = window._localRecords || {};
  let highest = 0;
  for (let l = 1; l <= 10; l++) {
    if (records['level_' + l]) highest = l;
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
    card.className = 'level-card' + (config.unlocked ? '' : ' locked') + (l === currentLevel ? ' active' : '');
    card.dataset.level = l;

    const isCompleted = !!records['level_' + l];
    const stars = isCompleted ? (records['level_' + l].stars || 0) : 0;
    const icon = config.unlocked ? (isCompleted ? 'check-circle' : 'play-circle') : 'lock';

    let starsHtml = '';
    if (config.unlocked) {
      for (let i = 1; i <= 3; i++) starsHtml += '<span>' + (i <= stars ? '⭐' : '☆') + '</span>';
    }

    card.innerHTML = '<div><div class="level-num">Level ' + l + '</div><div class="level-desc">' + config.size + 'x' + config.size + ' (Sum ' + config.target + ')</div><div class="level-stars">' + starsHtml + '</div></div><i data-lucide="' + icon + '" class="level-icon"></i>';

    if (config.unlocked) {
      card.addEventListener('click', function() {
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

  document.getElementById('level-title').textContent = 'Level ' + lvl + ': ' + cfg.size + 'x' + cfg.size;
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
  grid.style.gridTemplateColumns = 'repeat(' + size + ', 1fr) auto';
  grid.style.gridTemplateRows = 'repeat(' + size + ', 1fr) auto';

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
        ind.id = 'row-' + r;
        const lbl = size <= 7 ? '<span style="font-size:8px;opacity:0.6">R' + (r+1) + '</span>' : '';
        ind.innerHTML = lbl + '<span class="sum-val">0</span>';
        grid.appendChild(ind);
      } else if (r === size && c < size) {
        const ind = document.createElement('div');
        ind.className = 'indicator-cell incorrect';
        ind.id = 'col-' + c;
        const lbl = size <= 7 ? '<span style="font-size:8px;opacity:0.6">C' + (c+1) + '</span>' : '';
        ind.innerHTML = lbl + '<span class="sum-val">0</span>';
        grid.appendChild(ind);
      } else {
        const ind = document.createElement('div');
        ind.className = 'indicator-cell diagonal-indicator';
        ind.id = 'diag-corner';
        ind.innerHTML = '<div class="diag-sum" id="diag-main"><span style="opacity:0.5">↘</span><span class="sum-val">0</span></div><div class="diag-sum" id="diag-anti" style="margin-top:3px"><span style="opacity:0.5">↙</span><span class="sum-val">0</span></div>';
        grid.appendChild(ind);
      }
    }
  }

  highlightDuplicates();
  updateSums();
}

function highlightDuplicates() {
  const counts = {};
  gridState.forEach(function(v) { if (v !== null) counts[v] = (counts[v] || 0) + 1; });
  document.querySelectorAll('.grid-cell').forEach(function(cell) {
    const idx = parseInt(cell.dataset.index);
    if (!isNaN(idx)) cell.classList.toggle('duplicate', counts[gridState[idx]] > 1);
  });
}

// ===================== SUMS =====================
function updateSums() {
  const size = levels[currentLevel].size;
  const target = levels[currentLevel].target;

  for (let r = 0; r < size; r++) {
    let sum = 0;
    for (let c = 0; c < size; c++) sum += gridState[r * size + c] || 0;
    const el = document.getElementById('row-' + r);
    if (el) {
      el.querySelector('.sum-val').textContent = sum;
      el.className = 'indicator-cell ' + (sum === target ? 'correct' : 'incorrect');
    }
  }

  for (let c = 0; c < size; c++) {
    let sum = 0;
    for (let r = 0; r < size; r++) sum += gridState[r * size + c] || 0;
    const el = document.getElementById('col-' + c);
    if (el) {
      el.querySelector('.sum-val').textContent = sum;
      el.className = 'indicator-cell ' + (sum === target ? 'correct' : 'incorrect');
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
    dMain.querySelector('.sum-val').style.color = mainSum === target ? 'var(--emerald-glow)' : '';
  }
  if (dAnti) {
    dAnti.querySelector('.sum-val').textContent = antiSum;
    dAnti.querySelector('.sum-val').style.color = antiSum === target ? 'var(--emerald-glow)' : '';
  }
  if (dCorner) {
    dCorner.className = 'indicator-cell diagonal-indicator' + (mainSum === target && antiSum === target ? ' correct' : '');
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

  document.getElementById('victory-title').textContent = 'Level ' + currentLevel + ' Complete!';
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
  if (nextBtn) nextBtn.style.display = levels[currentLevel + 1] ? 'block' : 'none';

  startConfetti();
  showToast('Level Complete! Well done!');

  setTimeout(function() { openModal(modalVictory); }, 500);

  autoTransition = setTimeout(function() {
    if (levels[currentLevel + 1]) nextLevel();
    else { closeModal(modalVictory); showToast('All levels complete! You are free!'); }
  }, 4000);
}

function calculateScore() {
  const base = 10000 + levels[currentLevel].size * 2000;
  return Math.max(100, base - timeElapsed * 10 - moves * 30);
}

function nextLevel() {
  closeModal(modalVictory);
  const next = currentLevel + 1;
  if (levels[next] && levels[next].unlocked) { initLevel(next); }
}

// ===================== STAR TARGETS UI =====================
function updateStarTargets() {
  const container = document.getElementById('star-targets');
  if (!container) return;
  const l = starLimits[currentLevel];
  if (!l) { container.innerHTML = ''; return; }
  container.innerHTML = '<span class="star-badge">⭐⭐⭐ &le;' + (l.three/60) + 'm</span><span class="star-badge">⭐⭐ &le;' + (l.two/60) + 'm</span><span class="star-badge">⭐ &gt;' + (l.two/60) + 'm</span>';
}

// ===================== TIMER =====================
function startTimer() {
  stopTimer();
  timerInterval = setInterval(function() {
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
function showToast(msg, type) {
  if (toastTimer) clearTimeout(toastTimer);
  toast.querySelector('span').textContent = msg;
  toast.className = 'toast' + (type === 'error' ? ' error' : '');
  toastTimer = setTimeout(function() { toast.classList.add('hidden'); }, 3000);
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
  if (type === 'click') {
    osc.type = 'triangle'; osc.frequency.setValueAtTime(300, now);
    gain.gain.setValueAtTime(0.06, now); gain.gain.exponentialRampToValueAtTime(0.001, now+0.05);
    osc.start(now); osc.stop(now+0.05);
  } else if (type === 'place') {
    osc.type = 'sawtooth'; osc.frequency.setValueAtTime(200, now); osc.frequency.exponentialRampToValueAtTime(400, now+0.1);
    gain.gain.setValueAtTime(0.08, now); gain.gain.exponentialRampToValueAtTime(0.001, now+0.15);
    osc.start(now); osc.stop(now+0.15);
  } else if (type === 'error') {
    osc.type = 'sawtooth'; osc.frequency.setValueAtTime(100, now);
    gain.gain.setValueAtTime(0.1, now); gain.gain.exponentialRampToValueAtTime(0.001, now+0.3);
    osc.start(now); osc.stop(now+0.3);
  } else if (type === 'victory') {
    osc.stop();
    const notes = [220, 277, 330, 440];
    notes.forEach(function(f, i) {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      o.connect(g); g.connect(audioCtx.destination);
      g.gain.setValueAtTime(0.08, now + i*0.1);
      g.gain.exponentialRampToValueAtTime(0.001, now + i*0.1 + 0.5);
      o.start(now + i*0.1); o.stop(now + i*0.1 + 0.5);
    });
  }
}

function toggleSound() {
  soundEnabled = !soundEnabled;
  updateSoundUI();
  if (soundEnabled) playSound('click');
}

function updateSoundUI() {
  const icon = soundEnabled ? 'volume-2' : 'volume-x';
  ['btn-sound-game', 'btn-sound-ctrl'].forEach(function(id) {
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
  confettiParticles.forEach(function(p) {
    p.tiltAngle += p.tiltInc;
    p.y += (Math.cos(p.d) + 3 + p.r/2) / 2;
    p.x += Math.sin(p.tiltAngle) * 0.5;
    p.tilt = Math.sin(p.tiltAngle) * 12;
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
  for (let i = 0; i < 50; i++) {
    menuBgParticles.push({
      x: Math.random() * menuBgCanvas.width,
      y: Math.random() * menuBgCanvas.height,
      vx: (Math.random()-0.5)*0.4, vy: (Math.random()-0.5)*0.4,
      r: Math.random()*2+1,
      alpha: Math.random()*0.4+0.1,
      color: Math.random()>0.5 ? '#9f5cf6' : '#d4af37'
    });
  }
  if (menuBgAnim) cancelAnimationFrame(menuBgAnim);
  animateMenuBg();
}
function animateMenuBg() {
  if (!menuBgCtx) return;
  menuBgCtx.fillStyle = 'rgba(8,4,18,0.15)';
  menuBgCtx.fillRect(0, 0, menuBgCanvas.width, menuBgCanvas.height);
  menuBgParticles.forEach(function(p, i) {
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
    menuBgParticles.slice(i+1).forEach(function(p2) {
      const dx = p.x-p2.x, dy = p.y-p2.y, dist = Math.hypot(dx,dy);
      if (dist < 120) {
        menuBgCtx.beginPath();
        menuBgCtx.moveTo(p.x, p.y); menuBgCtx.lineTo(p2.x, p2.y);
        menuBgCtx.strokeStyle = 'rgba(159,92,246,' + ((120-dist)/120*0.12) + ')';
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
document.addEventListener('DOMContentLoaded', function() {
  resizeVictoryCanvas();
  window.addEventListener('resize', resizeVictoryCanvas);
});

function setupGameEvents() {
  const levelsBack = document.getElementById('btn-levels-back');
  if (levelsBack) levelsBack.addEventListener('click', function() { playSound('click'); showScreen('screen-home'); });

  const nextTop = document.getElementById('btn-next-top');
  if (nextTop) nextTop.addEventListener('click', function() {
    playSound('click');
    const next = currentLevel + 1;
    if (levels[next] && levels[next].unlocked) initLevel(next);
    else showToast('Next level is locked!', 'error');
  });

  const resetBtn = document.getElementById('btn-reset');
  if (resetBtn) resetBtn.addEventListener('click', function() { playSound('click'); resetBoard(); });

  const soundCtrl = document.getElementById('btn-sound-ctrl');
  if (soundCtrl) soundCtrl.addEventListener('click', toggleSound);

  const soundGame = document.getElementById('btn-sound-game');
  if (soundGame) soundGame.addEventListener('click', toggleSound);

  const backLevels = document.getElementById('btn-back-levels');
  if (backLevels) backLevels.addEventListener('click', function() {
    playSound('click'); stopTimer(); gameActive = false; showScreen('screen-levels');
  });

  const helpGame = document.getElementById('btn-help-game');
  if (helpGame) helpGame.addEventListener('click', function() { playSound('click'); openModal(modalHelp); });

  const closeHelp = document.getElementById('btn-close-help');
  if (closeHelp) closeHelp.addEventListener('click', function() { closeModal(modalHelp); });

  const startBtn = document.getElementById('btn-start');
  if (startBtn) startBtn.addEventListener('click', function() { closeModal(modalHelp); });

  const nextLevel = document.getElementById('btn-next-level');
  if (nextLevel) nextLevel.addEventListener('click', function() { playSound('click'); nextLevelFn(); });

  const playAgain = document.getElementById('btn-play-again');
  if (playAgain) playAgain.addEventListener('click', function() { playSound('click'); closeModal(modalVictory); resetBoard(); });

  const confirmYes = document.getElementById('btn-confirm-yes');
  if (confirmYes) confirmYes.addEventListener('click', function() {
    window._localRecords = {};
    for (let l = 1; l <= 10; l++) { if (levels[l]) levels[l].unlocked = (l === 1); }
    updateMenuStats();
    buildLevelsGrid();
    closeModal(modalConfirm);
    showToast('Progress wiped!');
    initLevel(1);
    showScreen('screen-game');
  });

  const confirmNo = document.getElementById('btn-confirm-no');
  if (confirmNo) confirmNo.addEventListener('click', function() { closeModal(modalConfirm); });

  setupGridInteraction();
}

// Clean up name helper since the click handler had a shadow variable 'nextLevel'
function nextLevelFn() {
  closeModal(modalVictory);
  const next = currentLevel + 1;
  if (levels[next] && levels[next].unlocked) { initLevel(next); }
}

function setupGridInteraction() {
  grid.addEventListener('click', function(e) {
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
      const tmp = gridState[selectedCell];
      gridState[selectedCell] = gridState[idx];
      gridState[idx] = tmp;
      selectedCell = null;
      moves++;
      document.getElementById('stat-moves').textContent = moves;
      playSound('place');
      buildGrid();
      checkWin();
    }
  });

  document.addEventListener('click', function(e) {
    if (!e.target.closest('.grid-cell') && selectedCell !== null) {
      selectedCell = null;
      buildGrid();
    }
  });

  let dragIdx = null;
  grid.addEventListener('dragstart', function(e) {
    if (!gameActive) return;
    const cell = e.target.closest('.grid-cell');
    if (!cell) return;
    dragIdx = parseInt(cell.dataset.index);
    cell.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    playSound('click');
  });
  grid.addEventListener('dragover', function(e) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; });
  grid.addEventListener('dragenter', function(e) {
    const cell = e.target.closest('.grid-cell');
    if (cell && parseInt(cell.dataset.index) !== dragIdx) cell.classList.add('drag-hover');
  });
  grid.addEventListener('dragleave', function(e) {
    const cell = e.target.closest('.grid-cell');
    if (cell) cell.classList.remove('drag-hover');
  });
  grid.addEventListener('drop', function(e) {
    e.preventDefault();
    if (!gameActive) return;
    const cell = e.target.closest('.grid-cell');
    if (!cell) return;
    const targetIdx = parseInt(cell.dataset.index);
    if (isNaN(targetIdx) || dragIdx === null || targetIdx === dragIdx) return;
    const tmp = gridState[dragIdx];
    gridState[dragIdx] = gridState[targetIdx];
    gridState[targetIdx] = tmp;
    moves++;
    document.getElementById('stat-moves').textContent = moves;
    playSound('place');
    buildGrid();
    checkWin();
  });
  grid.addEventListener('dragend', function() {
    document.querySelectorAll('.grid-cell').forEach(function(c) {
      c.classList.remove('dragging', 'drag-hover');
    });
    dragIdx = null;
  });
}

function setupSettingsEvents() {
  const soundToggle = document.getElementById('btn-sound-toggle');
  if (soundToggle) soundToggle.addEventListener('click', toggleSound);

  const clearProgress = document.getElementById('btn-clear-progress');
  if (clearProgress) clearProgress.addEventListener('click', function() { playSound('click'); openModal(modalConfirm); });

  const showRules = document.getElementById('btn-show-rules');
  if (showRules) showRules.addEventListener('click', function() { playSound('click'); openModal(modalHelp); });
}

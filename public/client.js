const socket = io();

const state = {
  myId: null,
  isHost: false,
  roomCode: null,
  room: null, // آخر room:update
  secretWord: null, // {word, difficulty} - سر لبس اللي شافها (شارك فى المزاد / بيشرح دلوقتي)
  timers: { auction: null, explain: null },
};

const TEAM_COLORS = ["--team-1", "--team-2", "--team-3", "--team-4", "--team-5"];

// ---------- عناصر DOM ----------
const screens = {
  home: document.getElementById("screen-home"),
  lobby: document.getElementById("screen-lobby"),
  game: document.getElementById("screen-game"),
};

function showScreen(name) {
  Object.values(screens).forEach((s) => s.classList.remove("active"));
  screens[name].classList.add("active");
}

function log(msg) {
  document.getElementById("event-log").textContent = msg;
}

// ---------- الشاشة الرئيسية ----------
document.getElementById("btn-host").addEventListener("click", () => {
  const name = document.getElementById("input-name").value.trim();
  if (!name) return showHomeError("اكتب اسمك الأول.");
  socket.emit("host:create", { name });
});

document.getElementById("btn-join").addEventListener("click", () => {
  const name = document.getElementById("input-name").value.trim();
  const roomCode = document.getElementById("input-room-code").value.trim().toUpperCase();
  if (!name) return showHomeError("اكتب اسمك الأول.");
  if (!roomCode) return showHomeError("اكتب كود الغرفة.");
  socket.emit("player:join", { roomCode, name });
});

function showHomeError(msg) {
  document.getElementById("home-error").textContent = msg;
}

// ---------- Lobby actions ----------
document.getElementById("btn-create-team").addEventListener("click", () => {
  const input = document.getElementById("input-team-name");
  const teamName = input.value.trim();
  socket.emit("team:create", { teamName });
  input.value = "";
});

document.getElementById("btn-save-settings").addEventListener("click", () => {
  socket.emit("host:updateSettings", {
    auctionDuration: Number(document.getElementById("setting-auction").value),
    explainDuration: Number(document.getElementById("setting-explain").value),
    targetScore: Number(document.getElementById("setting-target").value),
    difficulty: document.getElementById("setting-difficulty").value,
  });
});

document.getElementById("btn-start-game").addEventListener("click", () => {
  socket.emit("host:startGame");
});

// ---------- Game actions ----------
document.querySelectorAll(".paddle").forEach((btn) => {
  btn.addEventListener("click", () => {
    const value = Number(btn.dataset.value);
    socket.emit("bid:submit", { value });
    document.querySelectorAll(".paddle").forEach((b) => {
      b.disabled = true;
      b.classList.remove("selected");
    });
    btn.classList.add("selected");
    document.getElementById("bid-status").textContent = `بعتّ Bid بـ ${value} كلمة/كلمات. مستنى الباقيين...`;
  });
});

document.getElementById("btn-correct").addEventListener("click", () => {
  socket.emit("host:correct");
});

document.getElementById("btn-withdraw").addEventListener("click", () => {
  if (!confirm("متأكد إنك عايز تنسحب؟ فريقك هيخسر نقطة والدور هيروح للفريق اللي بعده.")) return;
  socket.emit("explain:withdraw");
});

document.getElementById("btn-continue-yes").addEventListener("click", () => socket.emit("continue:vote", { vote: true }));
document.getElementById("btn-continue-no").addEventListener("click", () => socket.emit("continue:vote", { vote: false }));

document.getElementById("btn-next-round").addEventListener("click", () => socket.emit("host:nextRound"));

function leaveRoom() {
  socket.emit("player:leave");
  goHome();
}
function endGame() {
  if (!confirm("متأكد إنك عايز تنهي المباراة للكل؟")) return;
  socket.emit("host:endGame");
}
document.getElementById("btn-leave-lobby").addEventListener("click", leaveRoom);
document.getElementById("btn-leave-game").addEventListener("click", leaveRoom);
document.getElementById("btn-end-game-lobby").addEventListener("click", endGame);
document.getElementById("btn-end-game").addEventListener("click", endGame);

function goHome() {
  state.myId = null;
  state.isHost = false;
  state.roomCode = null;
  state.room = null;
  state.secretWord = null;
  Object.values(state.timers).forEach((t) => t && clearInterval(t));
  document.getElementById("input-room-code").value = "";
  showScreen("home");
}

// ---------- Socket events ----------
socket.on("you:joined", ({ roomCode, id, isHost }) => {
  state.myId = id;
  state.isHost = isHost;
  state.roomCode = roomCode;
  document.getElementById("lobby-room-code").textContent = roomCode;
  document.getElementById("lobby-you").textContent = isHost ? "إنت الـ Host 👑" : "إنت لاعب";
  document.getElementById("btn-end-game-lobby").classList.toggle("hidden", !isHost);
  document.getElementById("btn-end-game").classList.toggle("hidden", !isHost);
  showScreen("lobby");
});

socket.on("game:ended", ({ reason }) => {
  const msg = reason === "host_left" ? "الـ Host خرج من الغرفة، المباراة اتقفلت." : "الـ Host أنهى المباراة.";
  alert(msg);
  goHome();
});

socket.on("game:error", (msg) => {
  showHomeError(msg);
  document.getElementById("lobby-error").textContent = msg;
  log(msg);
});

socket.on("room:update", (room) => {
  state.room = room;
  if (room.phase === "lobby") {
    renderLobby(room);
    if (screens.lobby.classList.contains("active") === false && screens.game.classList.contains("active") === false) {
      // خلي الشاشة زى ما هي، you:joined بيتولى التنقل الأولي
    }
  } else {
    if (!screens.game.classList.contains("active")) showScreen("game");
    renderGame(room);
  }
});

socket.on("round:wordReveal", ({ word, difficulty }) => {
  state.secretWord = { word, difficulty };
});

socket.on("auction:start", ({ duration, endsAt }) => {
  resetBidButtons();
  runCountdown("auction-timer", endsAt, () => {});
});

socket.on("bid:acknowledged", () => {});

socket.on("auction:result", ({ bids, penalized = [] }) => {
  renderAuctionResult(bids, penalized);
});

socket.on("explain:start", ({ teamId, teamName, playerName, wordCount, duration, endsAt }) => {
  showPhaseBox("explain-box");
  renderExplainPhase(teamId, teamName, playerName, wordCount, state.secretWord ? state.secretWord.word : null);
  runCountdown("explain-timer", endsAt, () => {});
});

socket.on("explain:withdrawn", ({ teamName }) => {
  log(`🏳️ فريق ${teamName} انسحب من الشرح — الدور راح للفريق اللي بعده (-1 نقطة).`);
});

socket.on("explain:correct", ({ teamName }) => {
  log(`✅ إجابة صحيحة! نقطة لفريق ${teamName}`);
});

socket.on("explain:timeout", ({ teamName }) => {
  log(`⏱️ خلص وقت فريق ${teamName} من غير ما يعرفوا الكلمة.`);
});

socket.on("continue:ask", () => {
  showPhaseBox("continue-box");
});

socket.on("continue:result", ({ continue: cont }) => {
  log(cont ? "الفريق وافق على الاستمرار — مزاد جديد على نفس الكلمة." : "كل الفرق رفضت — كلمة جديدة جاية.");
});

socket.on("game:over", ({ ranking }) => {
  showPhaseBox("gameover-box");
  const box = document.getElementById("gameover-ranking");
  box.innerHTML = "";
  ranking.forEach((r, i) => {
    const row = document.createElement("div");
    row.className = "rank-row" + (i === 0 ? " winner" : "");
    row.innerHTML = `<span>${i === 0 ? "🏆 " : ""}${escapeHtml(r.teamName)}</span><span class="rank-score">${r.score}</span>`;
    box.appendChild(row);
  });
});

// ---------- Render helpers ----------
function renderLobby(room) {
  document.getElementById("lobby-room-code").textContent = room.roomCode;
  document.getElementById("host-settings-card").classList.toggle("hidden", !state.isHost);

  document.getElementById("create-team-row").classList.toggle("hidden", !state.isHost);
  document.getElementById("teams-waiting-msg").classList.toggle("hidden", state.isHost || Object.keys(room.teams).length > 0);

  const teamsList = document.getElementById("teams-list");
  teamsList.innerHTML = "";
  const teamIds = Object.keys(room.teams);
  if (teamIds.length === 0 && state.isHost) {
    teamsList.innerHTML = `<p class="hint-text">لسه مفيش فرق. اعمل فريق جديد.</p>`;
  }
  teamIds.forEach((teamId, idx) => {
    const team = room.teams[teamId];
    const row = document.createElement("div");
    row.className = "team-row";
    const chips = team.players
      .map((p) => `<span class="player-chip ${p.id === state.myId ? "me" : ""}">${escapeHtml(p.name)}</span>`)
      .join("");
    row.innerHTML = `
      <div class="team-row-head">
        <span class="team-name">${escapeHtml(team.name)}</span>
        <span class="team-count">${team.players.length}/5</span>
      </div>
      <div class="team-players">${chips}</div>
      <button class="btn-join-team" data-team="${teamId}" ${team.players.length >= 5 ? "disabled" : ""}>انضم للفريق ده</button>
    `;
    teamsList.appendChild(row);
  });

  teamsList.querySelectorAll(".btn-join-team").forEach((btn) => {
    btn.addEventListener("click", () => socket.emit("team:join", { teamId: btn.dataset.team }));
  });

  // تحديث قيم الإعدادات المعروضة
  document.getElementById("setting-auction").value = room.settings.auctionDuration;
  document.getElementById("setting-explain").value = room.settings.explainDuration;
  document.getElementById("setting-target").value = room.settings.targetScore;
  document.getElementById("setting-difficulty").value = room.settings.difficulty;
}

function renderGame(room) {
  renderScoreboard(room);

  const selBox = document.getElementById("round-selections");
  if (room.round && room.round.selections) {
    selBox.innerHTML = Object.entries(room.round.selections)
      .map(([teamId, sel]) => `<span class="selection-chip">${escapeHtml(room.teams[teamId].name)}: <b>${escapeHtml(sel.playerName)}</b></span>`)
      .join("");
  }

  // كلمة سرية
  const secretBox = document.getElementById("secret-word-box");
  if (room.phase === "auction" && state.secretWord) {
    secretBox.classList.remove("hidden");
    document.getElementById("secret-word-text").textContent = state.secretWord.word;
    document.getElementById("secret-word-diff").textContent = `Difficulty: ${state.secretWord.difficulty}/10`;
  } else {
    secretBox.classList.add("hidden");
  }

  if (room.phase === "auction") {
    showPhaseBox("auction-box");
  } else if (room.phase === "explain" && room.round && room.round.explain) {
    showPhaseBox("explain-box");
    const ex = room.round.explain;
    renderExplainPhase(ex.teamId, room.teams[ex.teamId] ? room.teams[ex.teamId].name : "؟", ex.playerName, ex.wordCount, state.secretWord ? state.secretWord.word : null);
  } else if (room.phase === "roundEnd") {
    showPhaseBox("roundend-box");
    const re = (room.round && room.round.roundEnd) || {};
    document.getElementById("roundend-msg").textContent =
      re.reason === "correct" ? `فريق ${re.teamName} خمّن صح واخد نقطة! 🎉` : "محدش عرف الكلمة — جاية كلمة جديدة.";
    document.getElementById("btn-next-round").classList.toggle("hidden", !state.isHost);
    document.getElementById("roundend-waiting").classList.toggle("hidden", state.isHost);
  } else if (room.phase === "continueVote") {
    showPhaseBox("continue-box");
    const votesBox = document.getElementById("continue-votes");
    const votes = room.round.continueVotes || {};
    votesBox.textContent = room.turnOrder
      .map((tid) => `${room.teams[tid].name}: ${votes[tid] === undefined ? "بينتظر" : votes[tid] ? "موافق ✅" : "رافض ✋"}`)
      .join(" | ");
  } else if (room.phase === "gameover") {
    showPhaseBox("gameover-box");
  }
}

function renderExplainPhase(teamId, teamName, playerName, wordCount, word) {
  const myTeamId = state.room && state.room.players[state.myId] ? state.room.players[state.myId].teamId : null;
  const isMyTeamExplaining = myTeamId === teamId;
  const isExplainer = state.room && state.room.round && state.room.round.explain && state.room.round.explain.playerId === state.myId;

  const box = document.getElementById("explain-box");
  box.classList.remove("theme-green", "theme-red");
  box.classList.add(isMyTeamExplaining ? "theme-green" : "theme-red");

  const ring = document.getElementById("explain-timer-ring");
  ring.classList.remove("theme-timer-green", "theme-timer-red", "timer-ring-small");
  if (isMyTeamExplaining) {
    ring.classList.add("theme-timer-green");
  } else {
    ring.classList.add("theme-timer-red", "timer-ring-small");
  }

  document.getElementById("explain-eyebrow").textContent = isMyTeamExplaining ? "دور فريقك — بيشرح دلوقتي" : `دور فريق ${teamName} — إنتوا مستنيين`;
  document.getElementById("explain-word").textContent = word || "—";

  const explainInfo = document.getElementById("explain-info");
  if (isExplainer) {
    explainInfo.innerHTML = `دورك تشرح! التزم بـ <b>${wordCount}</b> كلمة/كلمات بس.`;
  } else if (isMyTeamExplaining) {
    explainInfo.innerHTML = `<b>${escapeHtml(playerName)}</b> بيشرح لكم بـ <b>${wordCount}</b> كلمة/كلمات.`;
  } else {
    explainInfo.innerHTML = `فريق <b>${escapeHtml(teamName)}</b> بيشرح دلوقتي (<b>${escapeHtml(playerName)}</b>) بـ <b>${wordCount}</b> كلمة/كلمات.`;
  }

  document.getElementById("btn-correct").classList.toggle("hidden", !state.isHost);
  document.getElementById("btn-withdraw").classList.toggle("hidden", !isExplainer);
}

function renderScoreboard(room) {
  const box = document.getElementById("scoreboard");
  box.innerHTML = "";
  room.turnOrder.forEach((teamId, idx) => {
    const team = room.teams[teamId];
    if (!team) return;
    const chip = document.createElement("div");
    chip.className = "score-chip";
    chip.innerHTML = `<span class="score-dot" style="background:var(${TEAM_COLORS[idx % TEAM_COLORS.length]})"></span>${escapeHtml(team.name)} <span class="score-num">${room.scores[teamId] || 0}</span>`;
    box.appendChild(chip);
  });
}

function renderAuctionResult(bids, penalized = []) {
  showPhaseBox("auction-result-box");
  const list = document.getElementById("auction-result-list");
  list.innerHTML = "";
  bids.forEach((b) => {
    const row = document.createElement("div");
    row.className = "result-row";
    row.innerHTML = `<span>${escapeHtml(b.teamName)}</span><span class="bid-val">${b.value} كلمة/كلمات</span>`;
    list.appendChild(row);
  });
  penalized.forEach((p) => {
    const row = document.createElement("div");
    row.className = "result-row penalized";
    row.innerHTML = `<span>${escapeHtml(p.teamName)}</span><span>ما بعتش Bid (-1 نقطة)</span>`;
    list.appendChild(row);
  });
  setTimeout(() => {
    if (document.getElementById("auction-result-box").classList.contains("hidden") === false) {
      // هتتغطى تلقائيًا بمرحلة الشرح أو التصويت جاية من السيرفر
    }
  }, 100);
}

function showPhaseBox(idToShow) {
  ["secret-word-box", "auction-box", "auction-result-box", "explain-box", "roundend-box", "continue-box", "gameover-box"].forEach((id) => {
    if (id === "secret-word-box") return; // يتحكم فيه لوحده فى renderGame
    document.getElementById(id).classList.toggle("hidden", id !== idToShow);
  });
}

function resetBidButtons() {
  document.querySelectorAll(".paddle").forEach((b) => {
    b.disabled = false;
    b.classList.remove("selected");
  });
  document.getElementById("bid-status").textContent = "";
}

function runCountdown(elementId, endsAt, onDone) {
  const el = document.getElementById(elementId);
  if (state.timers[elementId]) clearInterval(state.timers[elementId]);
  function tick() {
    const remaining = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
    el.textContent = remaining;
    if (remaining <= 0) {
      clearInterval(state.timers[elementId]);
      onDone();
    }
  }
  tick();
  state.timers[elementId] = setInterval(tick, 250);
}

function escapeHtml(str) {
  return String(str || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

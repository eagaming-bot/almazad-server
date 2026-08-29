const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { getPool, CATEGORY_KEYS } = require("./words");

const AVATAR_COUNT = 40; // عدد الأفاتارز المتاحة (assets/avatars فى تطبيق الموبايل)

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

// ---------- الحالة العامة ----------
// rooms[roomCode] = { ... }
const rooms = {};

function makeRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  } while (rooms[code]);
  return code;
}

function newRoom(hostSocketId) {
  return {
    hostSocketId,
    players: {}, // socketId -> { name, teamId }
    teams: {}, // teamId -> { name, playerIds: [], appearances: {playerId: count} }
    teamOrderCounter: 0,
    settings: {
      auctionDuration: 7,
      explainDuration: 60,
      targetScore: 12,
      language: "ar", // ar | en
      category: "all", // all | countries | food | movies | objects | animals | names
    },
    scores: {}, // teamId -> number
    turnOrder: [], // [teamId...] فى ترتيب الإنشاء
    usedWordsPool: new Set(), // نصوص الكلمات المستخدمة فى الجولة الحالية من المخزون
    phase: "lobby", // lobby | auction | explain | continueVote | gameover
    round: null,
    started: false,
  };
}

function publicRoomState(room, roomCode) {
  return {
    roomCode,
    hostSocketId: room.hostSocketId,
    phase: room.phase,
    started: room.started,
    settings: room.settings,
    scores: room.scores,
    turnOrder: room.turnOrder,
    serverNow: Date.now(),
    teams: Object.fromEntries(
      Object.entries(room.teams).map(([teamId, t]) => [
        teamId,
        {
          name: t.name,
          players: t.playerIds.map((pid) => ({
            id: pid,
            name: room.players[pid] ? room.players[pid].name : "؟",
            avatarId: room.players[pid] ? room.players[pid].avatarId : 0,
          })),
        },
      ])
    ),
    players: Object.fromEntries(
      Object.entries(room.players).map(([id, p]) => [id, { name: p.name, teamId: p.teamId, avatarId: p.avatarId }])
    ),
    round: room.round
      ? {
          selections: room.round.selections, // {teamId: {playerId, playerName}}
          difficulty: room.round.word ? room.round.word.difficulty : null,
          auctionEndsAt: room.round.auctionEndsAt || null,
          bidsRevealed: room.round.bidsRevealed || null,
          explain: room.round.explain
            ? {
                teamId: room.round.explain.teamId,
                playerId: room.round.explain.playerId,
                playerName: room.round.explain.playerName,
                wordCount: room.round.explain.wordCount,
                endsAt: room.round.explain.endsAt,
              }
            : null,
          continueVotes: room.round.continueVotes || null,
          roundEnd: room.round.roundEnd || null,
          paused: !!room.round.paused,
          pausedRemainingSeconds: room.round.pausedRemainingMs != null ? Math.ceil(room.round.pausedRemainingMs / 1000) : null,
        }
      : null,
  };
}

function broadcastRoom(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  io.to(roomCode).emit("room:update", publicRoomState(room, roomCode));
}

function clearRoundTimers(room) {
  if (room.round) {
    if (room.round.auctionTimeout) clearTimeout(room.round.auctionTimeout);
    if (room.round.explain && room.round.explain.timeout) clearTimeout(room.round.explain.timeout);
  }
}

// بيوقف مؤقتًا أي تايمر شغال دلوقتي (مزاد أو شرح) - بيحفظ الوقت المتبقي عشان نكمل بيه بعدين
function pauseCurrentTimer(room) {
  if (!room.round || room.round.paused) return false;
  let endsAt = null;
  let timeoutRef = null;
  if (room.phase === "auction") {
    endsAt = room.round.auctionEndsAt;
    timeoutRef = room.round.auctionTimeout;
  } else if (room.phase === "explain" && room.round.explain) {
    endsAt = room.round.explain.endsAt;
    timeoutRef = room.round.explain.timeout;
  } else {
    return false; // مفيش تايمر شغال دلوقتي يتوقف
  }
  if (timeoutRef) clearTimeout(timeoutRef);
  room.round.paused = true;
  room.round.pausedRemainingMs = Math.max(0, endsAt - Date.now());
  return true;
}

// بيكمّل التايمر من نفس الوقت اللي وقف عنده
function resumeCurrentTimer(room, roomCode) {
  if (!room.round || !room.round.paused) return false;
  const remainingMs = room.round.pausedRemainingMs || 0;
  const newEndsAt = Date.now() + remainingMs;
  room.round.paused = false;
  room.round.pausedRemainingMs = null;
  if (room.phase === "auction") {
    room.round.auctionEndsAt = newEndsAt;
    room.round.auctionTimeout = setTimeout(() => resolveAuction(roomCode), remainingMs + 300);
  } else if (room.phase === "explain" && room.round.explain) {
    room.round.explain.endsAt = newEndsAt;
    room.round.explain.timeout = setTimeout(() => onExplainTimeout(roomCode), remainingMs + 300);
  }
  return true;
}

// بيصفّر النقاط ويمسح بقايا الجولة القديمة، من غير ما يلمس الفرق أو اللاعبين - مستخدمة فى إعادة اللعب
function resetScoresKeepTeams(room) {
  const scores = {};
  for (const teamId of room.turnOrder) scores[teamId] = 0;
  room.scores = scores;
  room.round = null;
  room.usedWordsPool.clear();
}

// ---------- اختيار اللاعبين حسب العدالة ----------
function pickPlayerForTeam(room, teamId) {
  const team = room.teams[teamId];
  if (!team || team.playerIds.length === 0) return null;
  let minCount = Infinity;
  for (const pid of team.playerIds) {
    const c = team.appearances[pid] || 0;
    if (c < minCount) minCount = c;
  }
  const candidates = team.playerIds.filter((pid) => (team.appearances[pid] || 0) === minCount);
  const chosen = candidates[Math.floor(Math.random() * candidates.length)];
  team.appearances[chosen] = (team.appearances[chosen] || 0) + 1;
  // لو الكل وصل لـ3 ظهورات، نبدأ دورة جديدة
  const allDone = team.playerIds.every((pid) => (team.appearances[pid] || 0) >= 3);
  if (allDone) {
    for (const pid of team.playerIds) team.appearances[pid] = 0;
  }
  return chosen;
}

// ---------- اختيار كلمة ----------
function pickWord(room) {
  const { language, category } = room.settings;
  let pool = getPool(language, category).filter((w) => !room.usedWordsPool.has(w.text));
  if (pool.length === 0) {
    // خلص المخزون المتاح لهذا الكاتيجوري، نرجّع الكل ونبدأ من جديد
    room.usedWordsPool.clear();
    pool = getPool(language, category);
  }
  const word = pool[Math.floor(Math.random() * pool.length)];
  room.usedWordsPool.add(word.text);
  return word;
}

// ---------- بداية Round جديدة ----------
function startRound(roomCode, sameWord) {
  const room = rooms[roomCode];
  if (!room) return;
  clearRoundTimers(room);

  const activeTeams = room.turnOrder.filter((tid) => room.teams[tid] && room.teams[tid].playerIds.length > 0);
  if (activeTeams.length < 2) {
    io.to(roomCode).emit("game:error", "لازم فريقين على الأقل فيهم لاعب واحد على الأقل عشان تبدأ الجولة.");
    return;
  }

  const word = sameWord || pickWord(room);
  const selections = {};
  for (const teamId of activeTeams) {
    const pid = pickPlayerForTeam(room, teamId);
    selections[teamId] = { playerId: pid, playerName: room.players[pid] ? room.players[pid].name : "؟" };
  }

  room.phase = "auction";
  room.round = {
    word,
    selections,
    bids: {}, // teamId -> {value, ts}
    auctionEndsAt: Date.now() + room.settings.auctionDuration * 1000,
    auctionTimeout: null,
    bidsRevealed: null,
    bidOrder: [],
    bidOrderIndex: -1,
    explain: null,
    continueVotes: null,
    paused: false,
    pausedRemainingMs: null,
  };

  // نبلّغ الكل إن جولة جديدة بدأت عشان يمسحوا أي كلمة قديمة عندهم فورًا،
  // قبل ما نبعت الكلمة الجديدة سرًا للمختارين
  io.to(roomCode).emit("round:starting");

  // ابعت الكلمة سرًا للاعبين المختارين فقط
  for (const teamId of activeTeams) {
    const pid = selections[teamId].playerId;
    io.to(pid).emit("round:wordReveal", { word: word.text, difficulty: word.difficulty });
  }

  broadcastRoom(roomCode);
  io.to(roomCode).emit("auction:start", {
    duration: room.settings.auctionDuration,
    endsAt: room.round.auctionEndsAt,
    serverNow: Date.now(),
  });

  room.round.auctionTimeout = setTimeout(() => resolveAuction(roomCode), room.settings.auctionDuration * 1000 + 300);
}

function resolveAuction(roomCode) {
  const room = rooms[roomCode];
  if (!room || room.phase !== "auction" || !room.round) return;
  clearTimeout(room.round.auctionTimeout);

  const activeTeams = Object.keys(room.round.selections);
  const bidList = [];

  for (const teamId of activeTeams) {
    let bid = room.round.bids[teamId];
    if (!bid) {
      // محدش اختار عدد كلمات - نديله تلقائيًا 3 كلمات (بدون خصم نقاط)
      // الطابع الزمني بيتحط عشوائي شوية عشان لو كل الفرق مااختارتش،
      // يبقى اختيار مين هيبدأ عشوائي وعادل بينهم
      bid = { value: 3, ts: Date.now() + Math.random() * 500, auto: true };
      room.round.bids[teamId] = bid;
    }
    bidList.push({ teamId, value: bid.value, ts: bid.ts, auto: !!bid.auto });
  }

  bidList.sort((a, b) => (a.value - b.value) || (a.ts - b.ts));
  room.round.bidsRevealed = bidList.map((b) => ({
    teamId: b.teamId,
    teamName: room.teams[b.teamId] ? room.teams[b.teamId].name : "؟",
    value: b.value,
    auto: b.auto,
  }));
  room.round.bidOrder = bidList.map((b) => b.teamId);
  room.round.bidOrderIndex = -1;

  io.to(roomCode).emit("auction:result", {
    bids: room.round.bidsRevealed,
  });

  checkGameOver(roomCode, () => {
    advanceToNextBidder(roomCode);
  });
}

function advanceToNextBidder(roomCode) {
  const room = rooms[roomCode];
  if (!room || !room.round) return;
  room.round.bidOrderIndex += 1;
  if (room.round.bidOrderIndex >= room.round.bidOrder.length) {
    // كل الفرق فشلت
    askContinue(roomCode);
    return;
  }
  const teamId = room.round.bidOrder[room.round.bidOrderIndex];
  const bidValue = room.round.bids[teamId].value;
  const sel = room.round.selections[teamId];

  room.phase = "explain";
  room.round.explain = {
    teamId,
    playerId: sel.playerId,
    playerName: sel.playerName,
    wordCount: bidValue,
    endsAt: Date.now() + room.settings.explainDuration * 1000,
    timeout: null,
  };

  broadcastRoom(roomCode);
  io.to(roomCode).emit("explain:start", {
    teamId,
    teamName: room.teams[teamId] ? room.teams[teamId].name : "؟",
    playerName: sel.playerName,
    wordCount: bidValue,
    duration: room.settings.explainDuration,
    endsAt: room.round.explain.endsAt,
    serverNow: Date.now(),
  });

  room.round.explain.timeout = setTimeout(
    () => onExplainTimeout(roomCode),
    room.settings.explainDuration * 1000 + 300
  );
}

function onExplainTimeout(roomCode) {
  const room = rooms[roomCode];
  if (!room || room.phase !== "explain" || !room.round || !room.round.explain) return;
  const teamId = room.round.explain.teamId;
  io.to(roomCode).emit("explain:timeout", {
    teamId,
    teamName: room.teams[teamId] ? room.teams[teamId].name : "؟",
  });
  advanceToNextBidder(roomCode);
}

function onWithdraw(roomCode, requesterId) {
  const room = rooms[roomCode];
  if (!room || room.phase !== "explain" || !room.round || !room.round.explain) return;
  if (requesterId !== room.round.explain.playerId) return; // بس اللاعب اللي بيشرح دلوقتي يقدر ينسحب
  clearTimeout(room.round.explain.timeout);
  const teamId = room.round.explain.teamId;
  // مفيش خصم نقاط - الفريق بيفضل ثابت في نقطته، بس بيخسر دوره وينتقل للفريق اللي بعده
  io.to(roomCode).emit("explain:withdrawn", {
    teamId,
    teamName: room.teams[teamId] ? room.teams[teamId].name : "؟",
    scores: room.scores,
  });
  advanceToNextBidder(roomCode);
}

// لو اللاعب اللي بيشرح دلوقتي خرج/فصل النت أثناء دوره، ننتقل تلقائيًا للفريق اللي بعده من غير خصم نقطة
function handleMidRoundDeparture(roomCode, socketId) {
  const room = rooms[roomCode];
  if (!room || !room.round) return;
  if (room.phase === "explain" && room.round.explain && room.round.explain.playerId === socketId) {
    clearTimeout(room.round.explain.timeout);
    const teamId = room.round.explain.teamId;
    io.to(roomCode).emit("explain:timeout", {
      teamId,
      teamName: room.teams[teamId] ? room.teams[teamId].name : "؟",
    });
    advanceToNextBidder(roomCode);
  }
}

function askContinue(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  room.phase = "continueVote";
  room.round.continueVotes = {};
  broadcastRoom(roomCode);
  io.to(roomCode).emit("continue:ask", { teams: room.turnOrder });
}

function goToRoundEnd(roomCode, payload) {
  const room = rooms[roomCode];
  if (!room) return;
  room.phase = "roundEnd";
  room.round.roundEnd = payload; // { reason: 'correct'|'newWord', teamName? }
  broadcastRoom(roomCode);
}

function onCorrect(roomCode, requesterId) {
  const room = rooms[roomCode];
  if (!room || room.phase !== "explain" || !room.round || !room.round.explain) return;
  if (requesterId !== room.hostSocketId) return; // بس الـHost يقدر يضغط Correct
  clearTimeout(room.round.explain.timeout);
  const teamId = room.round.explain.teamId;
  room.scores[teamId] = (room.scores[teamId] || 0) + 1;
  io.to(roomCode).emit("explain:correct", {
    teamId,
    teamName: room.teams[teamId] ? room.teams[teamId].name : "؟",
    scores: room.scores,
  });
  checkGameOver(roomCode, () => {
    goToRoundEnd(roomCode, { reason: "correct", teamName: room.teams[teamId] ? room.teams[teamId].name : "؟" });
  });
}

function checkGameOver(roomCode, next) {
  const room = rooms[roomCode];
  if (!room) return;
  const target = room.settings.targetScore;
  const winners = Object.entries(room.scores).filter(([, s]) => s >= target);
  if (winners.length > 0) {
    room.phase = "gameover";
    clearRoundTimers(room);
    const ranking = Object.entries(room.scores)
      .map(([teamId, score]) => ({ teamId, teamName: room.teams[teamId] ? room.teams[teamId].name : "؟", score }))
      .sort((a, b) => b.score - a.score);
    io.to(roomCode).emit("game:over", { ranking });
    broadcastRoom(roomCode);
    return;
  }
  next();
}

// ---------- Socket handlers ----------
io.on("connection", (socket) => {
  socket.on("host:create", ({ name }) => {
    const roomCode = makeRoomCode();
    const room = newRoom(socket.id);
    room.players[socket.id] = {
      name: (name || "Host").trim() || "Host",
      teamId: null,
      avatarId: Math.floor(Math.random() * AVATAR_COUNT),
    };
    rooms[roomCode] = room;
    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    socket.emit("you:joined", { roomCode, id: socket.id, isHost: true });
    broadcastRoom(roomCode);
  });

  socket.on("player:join", ({ roomCode, name }) => {
    roomCode = (roomCode || "").toUpperCase().trim();
    const room = rooms[roomCode];
    if (!room) {
      socket.emit("game:error", "كود الغرفة غير موجود.");
      return;
    }
    if (room.started) {
      socket.emit("game:error", "المباراة بدأت بالفعل، مينفعش تنضم دلوقتي.");
      return;
    }
    room.players[socket.id] = {
      name: (name || "لاعب").trim() || "لاعب",
      teamId: null,
      avatarId: Math.floor(Math.random() * AVATAR_COUNT),
    };
    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    socket.emit("you:joined", { roomCode, id: socket.id, isHost: false });
    broadcastRoom(roomCode);
  });

  socket.on("team:create", ({ teamName }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || room.started) return;
    if (socket.id !== room.hostSocketId) return; // الهوست بس هو اللي يعمل فرق
    room.teamOrderCounter += 1;
    const teamId = "t" + room.teamOrderCounter;
    const defaultLetter = String.fromCharCode(64 + room.teamOrderCounter); // 1->A, 2->B, ...
    room.teams[teamId] = { name: (teamName || "فريق " + defaultLetter).trim(), playerIds: [], appearances: {} };
    room.turnOrder.push(teamId);
    room.scores[teamId] = 0;
    broadcastRoom(roomCode);
  });

  socket.on("team:delete", ({ teamId }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || room.started) return;
    if (socket.id !== room.hostSocketId) return; // الهوست بس هو اللي يقدر يحذف فرق
    const team = room.teams[teamId];
    if (!team) return;
    // أي لاعب كان فى الفريق ده يرجع "بلا فريق" عشان ينضم لفريق تاني
    for (const pid of team.playerIds) {
      if (room.players[pid]) room.players[pid].teamId = null;
    }
    delete room.teams[teamId];
    room.turnOrder = room.turnOrder.filter((tid) => tid !== teamId);
    delete room.scores[teamId];
    broadcastRoom(roomCode);
  });

  socket.on("team:join", ({ teamId }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || room.started) return;
    const team = room.teams[teamId];
    const player = room.players[socket.id];
    if (!team || !player) return;
    if (team.playerIds.length >= 5 && !team.playerIds.includes(socket.id)) {
      socket.emit("game:error", "الفريق ده وصل للحد الأقصى (5 لاعبين).");
      return;
    }
    // اطلع من أي فريق قديم
    if (player.teamId && room.teams[player.teamId]) {
      room.teams[player.teamId].playerIds = room.teams[player.teamId].playerIds.filter((id) => id !== socket.id);
    }
    player.teamId = teamId;
    if (!team.playerIds.includes(socket.id)) team.playerIds.push(socket.id);
    broadcastRoom(roomCode);
  });

  socket.on("host:updateSettings", (settings) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || socket.id !== room.hostSocketId || room.started) return;
    const s = room.settings;
    if (typeof settings.auctionDuration === "number") s.auctionDuration = Math.max(3, Math.min(30, settings.auctionDuration));
    if (typeof settings.explainDuration === "number") s.explainDuration = Math.max(10, Math.min(180, settings.explainDuration));
    if (typeof settings.targetScore === "number") s.targetScore = Math.max(1, Math.min(100, settings.targetScore));
    if (["ar", "en"].includes(settings.language)) s.language = settings.language;
    if (settings.category === "all" || CATEGORY_KEYS.includes(settings.category)) s.category = settings.category;
    broadcastRoom(roomCode);
  });

  socket.on("host:startGame", () => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || socket.id !== room.hostSocketId || room.started) return;
    const teamsWithPlayers = room.turnOrder.filter((tid) => room.teams[tid].playerIds.length > 0);
    if (teamsWithPlayers.length < 2) {
      socket.emit("game:error", "لازم فريقين على الأقل، وكل فريق فيه لاعب واحد على الأقل.");
      return;
    }
    room.turnOrder = teamsWithPlayers;
    room.started = true;
    startRound(roomCode);
  });

  // الهوست يقدر يتخطى الجولة الحالية (مثلاً لو الكلمة معجبتش الاتنين اللي هيشرحوا)
  // وينتقل لجولة جديدة بكلمة جديدة على طول، من غير أي تأثير على النقاط
  socket.on("host:skipRound", () => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || socket.id !== room.hostSocketId) return;
    if (room.phase !== "auction" && room.phase !== "explain") return;
    clearRoundTimers(room);
    startRound(roomCode);
  });

  // إيقاف/استكمال أي تايمر شغال (مزاد أو شرح) - مفيد لو حد محتاج يقف شوية (يروح الحمام مثلًا)
  socket.on("host:pauseTimer", () => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || socket.id !== room.hostSocketId) return;
    if (pauseCurrentTimer(room)) broadcastRoom(roomCode);
  });

  socket.on("host:resumeTimer", () => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || socket.id !== room.hostSocketId) return;
    if (resumeCurrentTimer(room, roomCode)) broadcastRoom(roomCode);
  });

  // إعادة لعب فورية بنفس الفرق ونفس الإعدادات - بتصفّر النقاط وتبدأ جولة جديدة على طول
  socket.on("host:rematch", () => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || socket.id !== room.hostSocketId || room.phase !== "gameover") return;
    clearRoundTimers(room);
    resetScoresKeepTeams(room);
    startRound(roomCode);
  });

  // إعادة لعب بنفس الفرق، بس الرجوع الأول لقاعة الانتظار عشان الهوست يعدّل الإعدادات (الكاتيجوري/التايمر) قبل البدء
  socket.on("host:rematchSettings", () => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || socket.id !== room.hostSocketId || room.phase !== "gameover") return;
    clearRoundTimers(room);
    resetScoresKeepTeams(room);
    room.phase = "lobby";
    room.started = false;
    broadcastRoom(roomCode);
  });

  socket.on("bid:submit", ({ value }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || room.phase !== "auction" || !room.round) return;
    if (![1, 2, 3].includes(value)) return;
    const player = room.players[socket.id];
    if (!player || !player.teamId) return;
    const sel = room.round.selections[player.teamId];
    if (!sel || sel.playerId !== socket.id) return; // اللاعب ده مش هو المشارك فى الجولة دي
    if (room.round.bids[player.teamId]) return; // اتبعت قبل كده
    room.round.bids[player.teamId] = { value, ts: Date.now() };
    io.to(roomCode).emit("bid:acknowledged", { teamId: player.teamId });

    // لو كل الفرق المشاركة رمت Bid، اقفل المزاد بدري
    const allIn = Object.keys(room.round.selections).every((tid) => room.round.bids[tid]);
    if (allIn) resolveAuction(roomCode);
  });

  socket.on("host:correct", () => {
    const roomCode = socket.data.roomCode;
    if (!roomCode) return;
    onCorrect(roomCode, socket.id);
  });

  socket.on("explain:withdraw", () => {
    const roomCode = socket.data.roomCode;
    if (!roomCode) return;
    onWithdraw(roomCode, socket.id);
  });

  socket.on("continue:vote", ({ vote }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || room.phase !== "continueVote" || !room.round) return;
    const player = room.players[socket.id];
    if (!player || !player.teamId) return;
    if (room.round.continueVotes[player.teamId] !== undefined) return;
    room.round.continueVotes[player.teamId] = !!vote;
    broadcastRoom(roomCode);

    const anyYes = Object.values(room.round.continueVotes).some((v) => v === true);
    const allVoted = room.turnOrder.every((tid) => room.round.continueVotes[tid] !== undefined);

    if (anyYes) {
      const word = room.round.word;
      io.to(roomCode).emit("continue:result", { continue: true });
      setTimeout(() => startRound(roomCode, word), 1500);
    } else if (allVoted) {
      io.to(roomCode).emit("continue:result", { continue: false });
      goToRoundEnd(roomCode, { reason: "newWord" });
    }
  });

  socket.on("host:nextRound", () => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || socket.id !== room.hostSocketId || room.phase !== "roundEnd") return;
    startRound(roomCode);
  });

  socket.on("player:leave", () => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room) return;
    if (socket.id === room.hostSocketId) {
      // الهوست لو خرج، المباراة كلها بتقفل - نبلّغ الباقيين بس، مش هو نفسه (عشان توجيه العميل بعد الخروج يفضل زي ما هو)
      socket.to(roomCode).emit("game:ended", { reason: "host_left" });
      clearRoundTimers(room);
      delete rooms[roomCode];
      socket.leave(roomCode);
      socket.data.roomCode = null;
      return;
    }
    const player = room.players[socket.id];
    if (player && player.teamId && room.teams[player.teamId]) {
      handleMidRoundDeparture(roomCode, socket.id);
      room.teams[player.teamId].playerIds = room.teams[player.teamId].playerIds.filter((id) => id !== socket.id);
    }
    delete room.players[socket.id];
    socket.leave(roomCode);
    socket.data.roomCode = null;
    broadcastRoom(roomCode);
  });

  socket.on("host:endGame", () => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || socket.id !== room.hostSocketId) return;
    room.phase = "gameover";
    clearRoundTimers(room);
    const ranking = Object.entries(room.scores)
      .map(([teamId, score]) => ({ teamId, teamName: room.teams[teamId] ? room.teams[teamId].name : "؟", score }))
      .sort((a, b) => b.score - a.score);
    io.to(roomCode).emit("game:over", { ranking, endedEarly: true });
    broadcastRoom(roomCode);
  });

  socket.on("disconnect", () => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room) return;
    const player = room.players[socket.id];
    if (player && player.teamId && room.teams[player.teamId]) {
      handleMidRoundDeparture(roomCode, socket.id);
      room.teams[player.teamId].playerIds = room.teams[player.teamId].playerIds.filter((id) => id !== socket.id);
    }
    delete room.players[socket.id];
    if (socket.id === room.hostSocketId) {
      io.to(roomCode).emit("game:ended", { reason: "host_left" });
      clearRoundTimers(room);
      delete rooms[roomCode];
      return;
    }
    broadcastRoom(roomCode);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Almazad server running: http://localhost:${PORT}`);
});

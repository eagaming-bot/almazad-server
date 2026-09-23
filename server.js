const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { getPool, CATEGORY_KEYS } = require("./words");
const { randomInt, shuffleArray: strongShuffleArray } = require("./strongRandom");
const { pickFresh } = require("./freshPicker");
const { MOVIES, SYSTEMS, GUESS_WORDS } = require("./data/gameBanks");

// كل نقطة بتتحسب 15 (يعني 15/30/45...) بدل 1/2/3
const POINT_UNIT = 15;
const DUPLICATE_UNIT = 5; // الإجابة المكررة فى أتوبيس

const AVATAR_COUNT = 40; // عدد الأفاتارز المتاحة (assets/avatars فى تطبيق الموبايل)

// الفئات المتاحة فى لعبة أتوبيس كومبليت استوب - اللاعبين بيختاروا منها
// قبل كل جولة (مش كلها إجبارية).
const BUS_CATEGORIES = [
  { id: "boyName", label: "اسم ولد" },
  { id: "girlName", label: "اسم بنت" },
  { id: "animal", label: "حيوان" },
  { id: "plant", label: "نبات" },
  { id: "country", label: "بلاد" },
  { id: "object", label: "جماد" },
  { id: "food", label: "أكلة" },
  { id: "job", label: "مهنة" },
  { id: "color", label: "لون" },
  { id: "celebrity", label: "مشهور" },
];

// حروف عربية مناسبة للبداية (شيلنا اللي صعب يبدأ بيها كلام كتير)
const BUS_LETTERS = "أبتجحدرزسشصضطعغفقكلمنهوي".split("");

const SPY_BANKS = {
  job: {
    label: "وظيفة",
    items: ["طبيب", "مدرس", "مهندس", "طيار", "ممرضة", "شيف", "محامي", "شرطي", "مصور", "نجار", "سائق تاكسي", "صيدلي", "مذيع", "كهربائي", "بائع", "مبرمج"],
  },
  place: {
    label: "مكان",
    items: ["المطار", "الشاطئ", "المستشفى", "المدرسة", "السينما", "المطعم", "الجيم", "السوق", "المسجد", "الحديقة", "المكتبة", "الفندق", "المصنع", "المحطة", "الاستاد", "الصيدلية"],
  },
  food: {
    label: "أكلة",
    items: ["كشري", "ملوخية", "فول ومدمس", "مسقعة", "محشي", "كباب", "بيتزا", "شاورما", "فراخ مشوية", "مكرونة بشاميل", "طعمية", "حمام محشي", "رز بلبن", "كنافة", "فتة", "سمك مشوي"],
  },
};

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
    code = Array.from({ length: 4 }, () => chars[randomInt(chars.length)]).join("");
  } while (rooms[code]);
  return code;
}

function newRoom(hostSocketId) {
  return {
    hostSocketId,
    selectedGame: null, // null | 'mazad' | ... - الهوست بيختارها بعد ما الكل يدخل الغرفة
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
    phase: "lobby", // lobby | auction | explain | continueVote | gameover | sniperPlaying
    round: null,
    sniper: null, // حالة لعبة القناص لما تكون شغالة - مستقلة تمامًا عن round/teams بتاعت المزاد
    spy: null, // حالة لعبة الجاسوس لما تكون شغالة - برضو مستقلة تمامًا
    bus: null, // حالة لعبة أتوبيس كومبليت استوب
    movies: null, // حالة لعبة أفلام
    moviesSettings: { actDuration: 60, targetScore: 5 }, // مدة التمثيل بالثواني + عدد الأفلام للفوز
    system: null, // حالة لعبة سيستم
    guess: null, // حالة لعبة خمن
    mafia: null, // حالة لعبة مافيا
    started: false,
  };
}

function publicRoomState(room, roomCode) {
  return {
    roomCode,
    hostSocketId: room.hostSocketId,
    selectedGame: room.selectedGame,
    moviesSettings: room.moviesSettings,
    phase: room.phase,
    started: room.started,
    settings: room.settings,
    scores: room.scores,
    turnOrder: room.turnOrder,
    // اسم الفريق اللي انسحب - بيتعرض في شاشة الانتظار بعد الانسحاب مباشرة
    lastWithdrawTeamName:
      room.phase === "explainWithdrawn" && room.round?.pendingWithdrawTeamId
        ? room.teams[room.round.pendingWithdrawTeamId]?.name || "؟"
        : null,
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
    sniper: room.sniper
      ? {
          phase: room.sniper.phase, // playing | guessing | reveal
          totalPlayers: room.sniper.playerOrder.length,
          paused: !!room.sniper.paused,
          ranking: room.sniper.ranking || null,
          eliminatedIds: room.sniper.eliminatedOrder, // آمن يتبعت للكل - مش بيكشف مين القناص
          aliveCount: room.sniper.playerOrder.length - room.sniper.eliminatedOrder.length,
          guesserId: room.sniper.guesserId,
          guessTargetId: room.sniper.guessTargetId,
          correct: room.sniper.phase === "reveal" ? room.sniper.correct : null,
          // هوية القناص الحقيقية متتبعتش خالص إلا لما اللعبة توصل لمرحلة الكشف النهائي
          sniperId: room.sniper.phase === "reveal" ? room.sniper.sniperId : null,
        }
      : null,
    spy: room.spy
      ? {
          category: room.spy.category,
          categoryLabel: SPY_BANKS[room.spy.category]?.label || "",
          phase: room.spy.phase, // discussing | voting | spyFinalGuess | reveal
          paused: !!room.spy.paused,
          ranking: room.spy.ranking || null,
          totalPlayers: room.spy.playerOrder.length,
          turn: room.spy.turn,
          voteCount: Object.keys(room.spy.votes).length,
          votes: room.spy.phase === "reveal" ? room.spy.votes : null,
          accused: room.spy.phase === "spyFinalGuess" || room.spy.phase === "reveal" ? room.spy.accused : null,
          correctlyCaught: room.spy.phase === "spyFinalGuess" || room.spy.phase === "reveal" ? room.spy.correctlyCaught : null,
          spyGuessCorrect: room.spy.phase === "reveal" ? room.spy.spyGuessCorrect : null,
          // الهوية والكلمة السرية متتكشفش إلا فى الكشف النهائي بس
          spyId: room.spy.phase === "reveal" ? room.spy.spyId : null,
          word: room.spy.phase === "reveal" ? room.spy.word : null,
        }
      : null,
    bus: room.bus
      ? {
          phase: room.bus.phase, // writing | review | results
          categories: room.bus.categories, // [{id, label}]
          letter: room.bus.letter,
          paused: !!room.bus.paused,
          ranking: room.bus.ranking || null,
          stopperId: room.bus.stopperId,
          submittedIds: Object.keys(room.bus.answers),
          totalPlayers: room.bus.playerOrder.length,
          // الإجابات متتكشفش إلا بعد ما الجولة تقف - عشان محدش ينقل من حد
          answers: room.bus.phase === "writing" ? null : room.bus.answers,
          rejected: room.bus.rejected,
          duplicates: room.bus.duplicates || {},
          roundScores: room.bus.phase === "results" ? room.bus.roundScores : null,
          totals: room.bus.totals,
        }
      : null,
    movies: room.movies
      ? {
          phase: room.movies.phase, // acting | roundEnd
          teamAId: room.movies.teamAId,
          teamBId: room.movies.teamBId,
          currentTeamId: room.movies.currentTeamId,
          actorId: room.movies.actorId,
          paused: !!room.movies.paused,
          pausedRemainingSeconds: room.movies.pausedRemainingMs != null ? Math.ceil(room.movies.pausedRemainingMs / 1000) : null,
          ranking: room.movies.ranking || null,
          targetScore: room.movies.targetScore,
          endsAt: room.movies.endsAt,
          scores: room.movies.scores,
          roundNumber: room.movies.roundNumber,
          lastResult: room.movies.lastResult,
          // اسم الفيلم بيتبعت للممثل بس عن طريق movies:film - مش هنا
        }
      : null,
    system: room.system
      ? {
          phase: room.system.phase, // playing | guessing | reveal
          paused: !!room.system.paused,
          ranking: room.system.ranking || null,
          unawareId: room.system.unawareId,
          guessText: room.system.phase === "reveal" ? room.system.guessText : null,
          correct: room.system.phase === "reveal" ? room.system.correct : null,
          // نص السيستم بيتكشف للكل فى الريفيل بس
          systemText: room.system.phase === "reveal" ? room.system.systemText : null,
          isCustom: room.system.isCustom,
        }
      : null,
    guess: room.guess
      ? {
          phase: room.guess.phase, // asking | reveal
          paused: !!room.guess.paused,
          ranking: room.guess.ranking || null,
          guesserId: room.guess.guesserId,
          turn: room.guess.turn, // مين المفروض يتسأل دلوقتي
          askedIds: room.guess.askedIds,
          totalPlayers: room.guess.playerOrder.length,
          guessText: room.guess.phase === "reveal" ? room.guess.guessText : null,
          correct: room.guess.phase === "reveal" ? room.guess.correct : null,
          word: room.guess.phase === "reveal" ? room.guess.word : null,
        }
      : null,
    mafia: room.mafia
      ? {
          phase: room.mafia.phase, // night | reveal_wills | day_announce | discussion | voting | vote_result | gameover
          round: room.mafia.round,
          paused: !!room.mafia.paused,
          pausedRemainingSeconds: room.mafia.paused && room.mafia.pausedRemainingMs != null ? Math.ceil(room.mafia.pausedRemainingMs / 1000) : null,
          playerOrder: room.mafia.playerOrder,
          aliveIds: room.mafia.aliveIds,
          mafiaCount: room.mafia.mafiaCount,
          doctorCount: room.mafia.doctorCount,
          // بيتكشف بس لما اللاعب يموت (ليلاً أو بالتصويت) - آمن يتبعت للكل طول الوقت
          revealedRoles: room.mafia.revealedRoles,
          // مؤشرات تقدم بس من غير ما تكشف مين اختار مين
          mafiaTargetLocked: !!room.mafia.nightTargetId,
          doctorTargetLocked: !!room.mafia.healTargetId,
          willsSubmittedCount: Object.keys(room.mafia.wills).length,
          discussionEndsAt: room.mafia.discussionEndsAt,
          // الوصايا بتتكشف من غير أسامي بس فى مرحلة reveal_wills وبعدها
          wills:
            room.mafia.phase === "reveal_wills" ||
            room.mafia.phase === "day_announce" ||
            room.mafia.phase === "discussion" ||
            room.mafia.phase === "voting"
              ? room.mafia.willsRevealList
              : null,
          lastResult: room.mafia.phase === "day_announce" ? room.mafia.lastNightResult : null,
          voteCounts: room.mafia.phase === "vote_result" ? room.mafia.voteCounts : null,
          lastVoteOut: room.mafia.phase === "vote_result" ? room.mafia.lastVoteOut : null,
          winner: room.mafia.winner,
          // اللعبة خلصت - مفيش أي داعي للسرية بقى، نكشف كل الأدوار
          allRoles: room.mafia.phase === "gameover" ? room.mafia.roles : null,
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
  const chosen = candidates[randomInt(candidates.length)];
  team.appearances[chosen] = (team.appearances[chosen] || 0) + 1;
  // لو الكل وصل لـ3 ظهورات، نبدأ دورة جديدة
  const allDone = team.playerIds.every((pid) => (team.appearances[pid] || 0) >= 3);
  if (allDone) {
    for (const pid of team.playerIds) team.appearances[pid] = 0;
  }
  return chosen;
}

// ---------- اختيار كلمة ----------
// بيمنع التكرار على مستويين: جوه الماتش الحالي (usedWordsPool)، وكمان
// عبر الجلسات كلها حتى بعد ما السيرفر يترستارت (pickFresh على الديسك).
function pickWord(room) {
  const { language, category } = room.settings;
  const pool = getPool(language, category).filter((w) => !room.usedWordsPool.has(w.text));
  const word = pickFresh(`mazad:${language}:${category}`, pool.length > 0 ? pool : getPool(language, category), (w) => w.text);
  if (pool.length === 0) room.usedWordsPool.clear();
  room.usedWordsPool.add(word.text);
  return word;
}

// ---------- لعبة القناص (غمزة) ----------
// لعبة مستقلة تمامًا عن نظام الفرق بتاع المزاد - كل اللاعبين المنضمين
// للغرفة (من غير فرق) يشاركوا فيها مباشرة.
function startSniperMatch(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  const playerIds = Object.keys(room.players);
  if (playerIds.length < 3) {
    io.to(roomCode).emit("game:error", "لازم 3 لاعبين على الأقل عشان تبدأ القناص.");
    return;
  }
  const sniperId = playerIds[randomInt(playerIds.length)];
  room.sniper = {
    playerOrder: playerIds.slice(),
    sniperId,
    eliminatedOrder: [],
    phase: "playing",
    guesserId: null,
    guessTargetId: null,
    correct: null,
  };
  room.started = true;
  room.phase = "sniperPlaying";
  broadcastRoom(roomCode);
  // الدور السري بيتبعت لكل لاعب لوحده، وبيوصل لكل الموبايلات فى نفس اللحظة
  // (كلهم بياخدوا room:update وsniper:role مع بعض) عشان محدش يلاحظ فرق فى التوقيت.
  for (const pid of playerIds) {
    io.to(pid).emit("sniper:role", { role: pid === sniperId ? "sniper" : "target" });
  }
}

// لو حد خرج وسط ماتش قناص شغال، أبسط وأسلم حاجة إننا نقفل الماتش ونرجع للوبي
// بدل ما نحاول نكمل بعدد لاعبين ناقص وسط منطق حساس زي ده.
function endSniperMatchIfActive(room, roomCode) {
  if (room.selectedGame === "sniper" && room.sniper && room.sniper.phase !== "reveal") {
    room.sniper = null;
    room.started = false;
    room.phase = "lobby";
    io.to(roomCode).emit("game:error", "الماتش اتقفل لأن حد من اللاعبين خرج.");
  }
  if (room.selectedGame === "spy" && room.spy && room.spy.phase !== "reveal") {
    room.spy = null;
    room.started = false;
    room.phase = "lobby";
    io.to(roomCode).emit("game:error", "الماتش اتقفل لأن حد من اللاعبين خرج.");
  }
  if (room.selectedGame === "bus" && room.bus && room.bus.phase !== "results") {
    room.bus = null;
    room.started = false;
    room.phase = "lobby";
    io.to(roomCode).emit("game:error", "الماتش اتقفل لأن حد من اللاعبين خرج.");
  }
  if (room.selectedGame === "movies" && room.movies && room.movies.phase !== "roundEnd") {
    if (room.movies.timeout) clearTimeout(room.movies.timeout);
    room.movies = null;
    room.started = false;
    room.phase = "lobby";
    io.to(roomCode).emit("game:error", "الماتش اتقفل لأن حد من اللاعبين خرج.");
  }
  if (room.selectedGame === "system" && room.system && room.system.phase !== "reveal") {
    room.system = null;
    room.started = false;
    room.phase = "lobby";
    io.to(roomCode).emit("game:error", "الماتش اتقفل لأن حد من اللاعبين خرج.");
  }
  if (room.selectedGame === "guess" && room.guess && room.guess.phase !== "reveal") {
    room.guess = null;
    room.started = false;
    room.phase = "lobby";
    io.to(roomCode).emit("game:error", "الماتش اتقفل لأن حد من اللاعبين خرج.");
  }
  if (room.selectedGame === "mafia" && room.mafia && room.mafia.phase !== "gameover") {
    if (room.mafia.discussionTimeout) clearTimeout(room.mafia.discussionTimeout);
    room.mafia = null;
    room.started = false;
    room.phase = "lobby";
    io.to(roomCode).emit("game:error", "الماتش اتقفل لأن حد من اللاعبين خرج.");
  }
}

// ---------- لعبة الجاسوس ----------
function pickRandomPair(playerIds) {
  const askerId = playerIds[randomInt(playerIds.length)];
  let targetId = askerId;
  while (targetId === askerId) {
    targetId = playerIds[randomInt(playerIds.length)];
  }
  return { askerId, targetId };
}

function startSpyMatch(roomCode, category) {
  const room = rooms[roomCode];
  if (!room) return;
  // "عشوائي" = اللعبة تختار كاتيجوري من الموجودين بنفسها
  const resolvedCategory =
    category === "random"
      ? Object.keys(SPY_BANKS)[randomInt(Object.keys(SPY_BANKS).length)]
      : category;
  const bank = SPY_BANKS[resolvedCategory];
  if (!bank) return;
  const playerIds = Object.keys(room.players);
  if (playerIds.length < 3) {
    io.to(roomCode).emit("game:error", "لازم 3 لاعبين على الأقل عشان تبدأ الجاسوس.");
    return;
  }
  const spyId = playerIds[randomInt(playerIds.length)];
  const word = pickFresh(`spy:${resolvedCategory}`, bank.items);
  room.spy = {
    category: resolvedCategory,
    word,
    spyId,
    playerOrder: playerIds.slice(),
    turn: pickRandomPair(playerIds),
    phase: "discussing",
    votes: {},
    accused: null,
    correctlyCaught: null,
    spyFinalGuessText: null,
    spyGuessCorrect: null,
  };
  room.started = true;
  room.phase = "spyPlaying";
  broadcastRoom(roomCode);
  for (const pid of playerIds) {
    if (pid === spyId) {
      io.to(pid).emit("spy:role", { role: "spy", category: resolvedCategory, categoryLabel: bank.label });
    } else {
      io.to(pid).emit("spy:role", { role: "civilian", category: resolvedCategory, categoryLabel: bank.label, word });
    }
  }
}

// ---------- لعبة أتوبيس كومبليت استوب ----------
function startBusRound(roomCode, categoryIds, keepTotals) {
  const room = rooms[roomCode];
  if (!room) return;
  const categories = BUS_CATEGORIES.filter((c) => categoryIds.includes(c.id));
  if (categories.length === 0) return;
  const playerIds = Object.keys(room.players);
  if (playerIds.length < 2) {
    io.to(roomCode).emit("game:error", "لازم لاعبين على الأقل عشان تبدأ أتوبيس كومبليت استوب.");
    return;
  }
  const previousTotals = keepTotals && room.bus ? room.bus.totals : {};
  room.bus = {
    playerOrder: playerIds.slice(),
    categories,
    letter: pickFresh("bus:letter", BUS_LETTERS),
    phase: "writing",
    answers: {}, // playerId -> { categoryId: text }
    stopperId: null,
    rejected: {}, // "playerId:categoryId" -> true (إجابات الهوست شطبها فى المراجعة)
    roundScores: null,
    totals: { ...previousTotals },
  };
  room.started = true;
  room.phase = "busPlaying";
  broadcastRoom(roomCode);
}

// بيحسب نقط الجولة: إجابة صح ومنفردة = نقطة، ومكررة = نص نقطة،
// وفاضية أو الهوست شطبها = صفر.
function computeBusScores(room) {
  const bus = room.bus;
  const normalize = (s) => (s || "").trim().toLowerCase();
  const roundScores = {};

  for (const pid of bus.playerOrder) roundScores[pid] = 0;

  for (const category of bus.categories) {
    // نجمع كل الإجابات الصالحة فى الفئة دي عشان نعرف المكرر من المنفرد
    const valueCounts = {};
    for (const pid of bus.playerOrder) {
      if (bus.rejected[`${pid}:${category.id}`]) continue;
      const value = normalize(bus.answers[pid]?.[category.id]);
      if (!value) continue;
      valueCounts[value] = (valueCounts[value] || 0) + 1;
    }
    for (const pid of bus.playerOrder) {
      if (bus.rejected[`${pid}:${category.id}`]) continue;
      const value = normalize(bus.answers[pid]?.[category.id]);
      if (!value) continue;
      roundScores[pid] += valueCounts[value] === 1 ? POINT_UNIT : DUPLICATE_UNIT;
    }
  }

  // خريطة المكرر: "الفئة:الإجابة" -> true، عشان الكلاينت يعرض 15 ولا 5 لكل خانة
  const duplicates = {};
  for (const category of bus.categories) {
    const valueCounts = {};
    for (const pid of bus.playerOrder) {
      if (bus.rejected[`${pid}:${category.id}`]) continue;
      const value = normalize(bus.answers[pid]?.[category.id]);
      if (!value) continue;
      valueCounts[value] = (valueCounts[value] || 0) + 1;
    }
    for (const [value, count] of Object.entries(valueCounts)) {
      if (count > 1) duplicates[`${category.id}:${value}`] = true;
    }
  }
  bus.duplicates = duplicates;

  bus.roundScores = roundScores;
  for (const pid of bus.playerOrder) {
    bus.totals[pid] = (bus.totals[pid] || 0) + roundScores[pid];
  }
}

// ---------- لعبة أفلام ----------
function startMoviesRound(roomCode, keepScores) {
  const room = rooms[roomCode];
  if (!room) return;
  const teamIds = room.turnOrder.filter((tid) => room.teams[tid]?.playerIds.length > 0);
  if (teamIds.length < 2) {
    io.to(roomCode).emit("game:error", "لازم فريقين على الأقل وكل فريق فيه لاعب.");
    return;
  }
  const prev = keepScores && room.movies ? room.movies : null;
  const teamAId = teamIds[0];
  const teamBId = teamIds[1];
  // الدور بيتبادل بين الفريقين كل جولة
  const currentTeamId = prev ? (prev.currentTeamId === teamAId ? teamBId : teamAId) : teamAId;
  // بنختار ممثل مختلف كل مرة من نفس الفريق (الأقل ظهورًا)
  const appearances = prev ? prev.appearances : {};
  const teamPlayers = room.teams[currentTeamId].playerIds;
  const minSeen = Math.min(...teamPlayers.map((pid) => appearances[pid] || 0));
  const candidates = teamPlayers.filter((pid) => (appearances[pid] || 0) === minSeen);
  const actorId = candidates[randomInt(candidates.length)];
  appearances[actorId] = (appearances[actorId] || 0) + 1;

  const film = pickFresh("movies", MOVIES);
  const duration = room.moviesSettings?.actDuration || 60;
  room.movies = {
    teamAId,
    teamBId,
    currentTeamId,
    actorId,
    film,
    appearances,
    phase: "acting",
    endsAt: Date.now() + duration * 1000,
    duration,
    scores: prev ? prev.scores : { [teamAId]: 0, [teamBId]: 0 },
    roundNumber: prev ? prev.roundNumber + 1 : 1,
    lastResult: null,
    targetScore: (room.moviesSettings?.targetScore || 5) * POINT_UNIT,
    timeout: null,
  };
  room.movies.timeout = setTimeout(() => endMoviesRound(roomCode, "timeout"), duration * 1000 + 300);
  room.started = true;
  room.phase = "moviesPlaying";
  broadcastRoom(roomCode);
  io.to(actorId).emit("movies:film", { film });
}

function endMoviesRound(roomCode, reason) {
  const room = rooms[roomCode];
  if (!room || !room.movies || room.movies.phase !== "acting") return;
  if (room.movies.timeout) clearTimeout(room.movies.timeout);
  room.movies.timeout = null;
  if (reason === "correct") {
    room.movies.scores[room.movies.currentTeamId] = (room.movies.scores[room.movies.currentTeamId] || 0) + POINT_UNIT;
  }
  // لو الوقت خلص من غير تخمين: مفيش خصم، الفريق بس مش بياخد نقطة
  room.movies.lastResult = { reason, film: room.movies.film, teamId: room.movies.currentTeamId };
  const target = room.movies.targetScore;
  const reachedTarget = Object.values(room.movies.scores).some((sc) => sc >= target);
  if (reachedTarget) {
    room.movies.ranking = buildRankingFromScores(room, room.movies.scores);
    room.movies.phase = "matchOver";
  } else {
    room.movies.phase = "roundEnd";
  }
  broadcastRoom(roomCode);
}

// ---------- لعبة سيستم ----------
function startSystemMatch(roomCode, customText) {
  const room = rooms[roomCode];
  if (!room) return;
  const playerIds = Object.keys(room.players);
  if (playerIds.length < 3) {
    io.to(roomCode).emit("game:error", "لازم 3 لاعبين على الأقل عشان تبدأ سيستم.");
    return;
  }
  const unawareId = playerIds[randomInt(playerIds.length)];
  const isCustom = !!(customText && customText.trim());
  const systemText = isCustom ? customText.trim() : pickFresh("system", SYSTEMS, (s) => s.id).text;

  room.system = {
    playerOrder: playerIds.slice(),
    unawareId,
    systemText,
    isCustom,
    phase: "playing",
    guessText: null,
    correct: null,
  };
  room.started = true;
  room.phase = "systemPlaying";
  broadcastRoom(roomCode);
  for (const pid of playerIds) {
    if (pid === unawareId) io.to(pid).emit("system:role", { role: "unaware" });
    else io.to(pid).emit("system:role", { role: "aware", systemText });
  }
}

// ---------- لعبة خمن ----------
// ---------- لعبة مافيا ----------

// جدول احتمالات عدد المافيا حسب عدد اللاعبين - أقصى حد 4 مهما زاد العدد
function pickMafiaCountRandom(n) {
  let weights; // [{c, w}]
  if (n <= 4) weights = [{ c: 1, w: 100 }];
  else if (n === 5) weights = [{ c: 1, w: 80 }, { c: 2, w: 20 }];
  else if (n === 6) weights = [{ c: 1, w: 60 }, { c: 2, w: 40 }];
  else if (n === 7) weights = [{ c: 1, w: 40 }, { c: 2, w: 40 }, { c: 3, w: 20 }];
  else if (n === 8) weights = [{ c: 1, w: 25 }, { c: 2, w: 40 }, { c: 3, w: 35 }];
  else if (n === 9) weights = [{ c: 2, w: 40 }, { c: 3, w: 60 }];
  else {
    // 10 لاعبين فيما فوق: فرصة الـ4 بتزيد تدريجيًا كل ما العدد زاد، وسقفها ميعديش 4
    const extra = Math.min(n - 10, 6); // بنوقف الزيادة عند 16 لاعب عشان الفرص متفضلش تكبر للأبد
    const w4 = 25 + extra * 4; // من 25% عند 10 لاعبين لحد ~49% عند 16+
    const w3 = 40;
    const w2 = Math.max(10, 100 - w4 - w3);
    weights = [{ c: 2, w: w2 }, { c: 3, w: w3 }, { c: 4, w: w4 }];
  }
  const total = weights.reduce((s, x) => s + x.w, 0);
  let r = Math.random() * total;
  for (const { c, w } of weights) {
    if (r < w) return c;
    r -= w;
  }
  return weights[weights.length - 1].c;
}

function maxMafiaFor(n) {
  if (n <= 4) return 1;
  if (n <= 6) return 2;
  if (n <= 9) return 3;
  return 4;
}

// عدد الأطباء بيتحدد من اللعبة نفسها بالكامل - مفيش تدخل من الهوست خالص
function pickDoctorCount(n, mafiaCount) {
  if (n >= 8 && (mafiaCount === 2 || mafiaCount === 3)) {
    return Math.random() < 0.35 ? 2 : 1;
  }
  return 1;
}

function shuffleArray(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt((i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function startMafiaMatch(roomCode, mafiaCountChoice) {
  const room = rooms[roomCode];
  if (!room) return;
  const playerIds = Object.keys(room.players);
  const n = playerIds.length;
  if (n < 4) {
    io.to(roomCode).emit("game:error", "لازم 4 لاعبين على الأقل عشان تبدأ مافيا.");
    return;
  }
  const max = maxMafiaFor(n);
  let mafiaCount;
  if (mafiaCountChoice === "random" || !mafiaCountChoice) {
    mafiaCount = pickMafiaCountRandom(n);
  } else {
    mafiaCount = Math.max(1, Math.min(max, Number(mafiaCountChoice) || 1));
  }
  const doctorCount = pickDoctorCount(n, mafiaCount);

  const shuffled = shuffleArray(playerIds);
  const roles = {};
  shuffled.slice(0, mafiaCount).forEach((id) => (roles[id] = "mafia"));
  shuffled.slice(mafiaCount, mafiaCount + doctorCount).forEach((id) => (roles[id] = "doctor"));
  shuffled.slice(mafiaCount + doctorCount).forEach((id) => (roles[id] = "citizen"));

  room.mafia = {
    playerOrder: playerIds.slice(),
    aliveIds: playerIds.slice(),
    roles,
    mafiaCount,
    doctorCount,
    round: 1,
    phase: "night",
    paused: false,
    nightTargetId: null,
    healTargetId: null,
    doctorSelfHealCounts: {},
    doctorLastSelfHealRound: {},
    wills: {},
    willsRevealList: [],
    lastNightResult: null,
    revealedRoles: {},
    discussionEndsAt: null,
    discussionTimeout: null,
    votes: {},
    voteCounts: null,
    lastVoteOut: null,
    winner: null,
  };
  room.started = true;
  room.phase = "mafiaPlaying";
  broadcastRoom(roomCode);
  const mafiaIds = playerIds.filter((id) => roles[id] === "mafia");
  for (const pid of playerIds) {
    // المافيا بيعرفوا بعض؛ الدكتور والمواطن ماعندهمش معلومة زيادة عن دورهم
    io.to(pid).emit("mafia:role", { role: roles[pid], teammates: roles[pid] === "mafia" ? mafiaIds.filter((id) => id !== pid) : [] });
  }
}

function aliveMafiaCount(m) {
  return m.aliveIds.filter((id) => m.roles[id] === "mafia").length;
}
function aliveNonMafiaCount(m) {
  return m.aliveIds.filter((id) => m.roles[id] !== "mafia").length;
}

function checkMafiaWin(room) {
  const m = room.mafia;
  if (aliveMafiaCount(m) === 0) {
    m.winner = "citizens";
    m.phase = "gameover";
    return true;
  }
  if (aliveNonMafiaCount(m) === 0) {
    m.winner = "mafia";
    m.phase = "gameover";
    return true;
  }
  return false;
}

function tryAdvanceMafiaNight(roomCode) {
  const room = rooms[roomCode];
  if (!room || !room.mafia || room.mafia.phase !== "night") return;
  const m = room.mafia;
  const mafiaAlive = aliveMafiaCount(m) > 0;
  const doctorAliveIds = m.aliveIds.filter((id) => m.roles[id] === "doctor");
  const needMafiaTarget = mafiaAlive ? !!m.nightTargetId : true;
  const needDoctorTarget = doctorAliveIds.length > 0 ? !!m.healTargetId : true;
  const allWillsIn = m.aliveIds.every((id) => m.wills[id] !== undefined);
  if (needMafiaTarget && needDoctorTarget && allWillsIn) {
    advanceToRevealWills(roomCode);
  }
}

function advanceToRevealWills(roomCode) {
  const room = rooms[roomCode];
  const m = room.mafia;
  m.willsRevealList = shuffleArray(Object.values(m.wills).map((text) => ({ text })));
  m.phase = "reveal_wills";

  const saved = !!m.nightTargetId && m.healTargetId === m.nightTargetId;
  let killedId = null;
  if (m.nightTargetId && !saved) {
    killedId = m.nightTargetId;
    m.aliveIds = m.aliveIds.filter((id) => id !== killedId);
    m.revealedRoles[killedId] = m.roles[killedId];
  }
  m.lastNightResult = {
    killedId,
    killedName: killedId ? room.players[killedId]?.name || "؟" : null,
    saved: !!m.nightTargetId && saved,
  };
  broadcastRoom(roomCode);
}

function startMafiaVoting(roomCode) {
  const room = rooms[roomCode];
  if (!room || !room.mafia) return;
  room.mafia.phase = "voting";
  room.mafia.discussionTimeout = null;
  broadcastRoom(roomCode);
}

function resolveMafiaVote(roomCode) {
  const room = rooms[roomCode];
  const m = room.mafia;
  const counts = {};
  for (const targetId of Object.values(m.votes)) {
    counts[targetId] = (counts[targetId] || 0) + 1;
  }
  let topId = null;
  let topCount = -1;
  for (const [pid, count] of Object.entries(counts)) {
    if (count > topCount) {
      topCount = count;
      topId = pid;
    }
  }
  m.voteCounts = counts;
  m.aliveIds = m.aliveIds.filter((id) => id !== topId);
  m.revealedRoles[topId] = m.roles[topId];
  m.lastVoteOut = {
    id: topId,
    name: room.players[topId]?.name || "؟",
    role: m.roles[topId],
  };
  m.phase = "vote_result";
  checkMafiaWin(room);
  broadcastRoom(roomCode);
}

function startGuessMatch(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  const playerIds = Object.keys(room.players);
  if (playerIds.length < 3) {
    io.to(roomCode).emit("game:error", "لازم 3 لاعبين على الأقل عشان تبدأ خمن.");
    return;
  }
  const guesserId = playerIds[randomInt(playerIds.length)];
  const others = playerIds.filter((id) => id !== guesserId);
  const word = pickFresh("guess", GUESS_WORDS);

  room.guess = {
    playerOrder: playerIds.slice(),
    guesserId,
    word,
    // اللعبة هي اللي بتحدد مين يتسأل، مش الخمّان
    turn: others[randomInt(others.length)],
    askedIds: [],
    phase: "asking",
    guessText: null,
    correct: null,
  };
  room.started = true;
  room.phase = "guessPlaying";
  broadcastRoom(roomCode);
  for (const pid of playerIds) {
    if (pid === guesserId) io.to(pid).emit("guess:role", { role: "guesser" });
    else io.to(pid).emit("guess:role", { role: "knower", word });
  }
}

// المزاد عنده منطق pause خاص بيه (بيوقف التايمر فعليًا)، وأفلام كمان عندها
// تايمر. باقي الألعاب مفيهاش تايمر فبنكتفي بعلامة paused اللي بتقفل الشاشة.
function activeGameState(room) {
  return room[room.selectedGame] || null;
}

function pauseAnyGame(room, roomCode) {
  if (room.selectedGame === "mazad") return pauseCurrentTimer(room);

  if (room.selectedGame === "movies" && room.movies) {
    if (room.movies.paused || room.movies.phase !== "acting") return false;
    room.movies.paused = true;
    room.movies.pausedRemainingMs = Math.max(0, room.movies.endsAt - Date.now());
    if (room.movies.timeout) clearTimeout(room.movies.timeout);
    room.movies.timeout = null;
    return true;
  }

  if (room.selectedGame === "mafia" && room.mafia) {
    if (room.mafia.paused || room.mafia.phase !== "discussion") return false;
    room.mafia.paused = true;
    room.mafia.pausedRemainingMs = Math.max(0, room.mafia.discussionEndsAt - Date.now());
    if (room.mafia.discussionTimeout) clearTimeout(room.mafia.discussionTimeout);
    room.mafia.discussionTimeout = null;
    return true;
  }

  const g = activeGameState(room);
  if (!g || g.paused) return false;
  g.paused = true;
  return true;
}

function resumeAnyGame(room, roomCode) {
  if (room.selectedGame === "mazad") return resumeCurrentTimer(room, roomCode);

  if (room.selectedGame === "movies" && room.movies) {
    if (!room.movies.paused) return false;
    const remaining = room.movies.pausedRemainingMs || 0;
    room.movies.paused = false;
    room.movies.pausedRemainingMs = null;
    room.movies.endsAt = Date.now() + remaining;
    room.movies.timeout = setTimeout(() => endMoviesRound(roomCode, "timeout"), remaining + 300);
    return true;
  }

  if (room.selectedGame === "mafia" && room.mafia) {
    if (!room.mafia.paused) return false;
    const remaining = room.mafia.pausedRemainingMs || 0;
    room.mafia.paused = false;
    room.mafia.pausedRemainingMs = null;
    room.mafia.discussionEndsAt = Date.now() + remaining;
    room.mafia.discussionTimeout = setTimeout(() => startMafiaVoting(roomCode), remaining + 300);
    return true;
  }

  const g = activeGameState(room);
  if (!g || !g.paused) return false;
  g.paused = false;
  return true;
}

// ---------- إنهاء الماتش وعرض النتيجة النهائية ----------
// بيحط اللعبة فى مرحلة matchOver ومعاها الترتيب النهائي، عشان اللاعبين
// يشوفوا النتيجة كام كام قبل ما يقرروا جولة جديدة ولا رجوع للوبي.
function buildRankingFromScores(room, scores) {
  return Object.entries(scores || {})
    .map(([id, score]) => ({
      id,
      name: room.teams[id]?.name || room.players[id]?.name || "؟",
      score,
    }))
    .sort((a, b) => b.score - a.score);
}

function endMatchForGame(room, roomCode) {
  const gameId = room.selectedGame;
  if (gameId === "movies" && room.movies) {
    if (room.movies.timeout) clearTimeout(room.movies.timeout);
    room.movies.timeout = null;
    room.movies.ranking = buildRankingFromScores(room, room.movies.scores);
    room.movies.phase = "matchOver";
    return true;
  }
  if (gameId === "bus" && room.bus) {
    room.bus.ranking = buildRankingFromScores(room, room.bus.totals);
    room.bus.phase = "matchOver";
    return true;
  }
  if (gameId === "mafia" && room.mafia) {
    if (room.mafia.discussionTimeout) clearTimeout(room.mafia.discussionTimeout);
    room.mafia.discussionTimeout = null;
    room.mafia.winner = null; // اتقفلت بدري - مفيش فايز
    room.mafia.phase = "gameover";
    return true;
  }
  // الألعاب اللي مفيهاش نقاط تراكمية: بننهيها من غير ترتيب
  const g = activeGameState(room);
  if (g) {
    g.ranking = null;
    g.phase = "matchOver";
    return true;
  }
  return false;
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
  // مفيش خصم نقاط - الفريق بيفضل ثابت في نقطته، بس بيخسر دوره وينتقل للفريق اللي بعده.
  // بنوقف هنا وننتظر الهوست يدوس "التالي" عشان تايمر الفريق اللي بعده مايبدأش
  // فورًا من غير ما الكل ياخد لحظة يستوعب إن اللي فات انسحب.
  room.phase = "explainWithdrawn";
  room.round.pendingWithdrawTeamId = teamId;
  io.to(roomCode).emit("explain:withdrawn", {
    teamId,
    teamName: room.teams[teamId] ? room.teams[teamId].name : "؟",
    scores: room.scores,
  });
  broadcastRoom(roomCode);
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
  room.scores[teamId] = (room.scores[teamId] || 0) + POINT_UNIT;
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
  const target = room.settings.targetScore * POINT_UNIT;
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
      avatarId: randomInt(AVATAR_COUNT),
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
      avatarId: randomInt(AVATAR_COUNT),
    };
    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    socket.emit("you:joined", { roomCode, id: socket.id, isHost: false });
    broadcastRoom(roomCode);
  });

  // الهوست بيختار اللعبة اللي الأوضة هتلعبها. دلوقتي بس 'mazad' متاحة فعليًا -
  // أي لعبة تانية هتتضاف هنا لما يكون منطقها جاهز على السيرفر.
  const IMPLEMENTED_GAMES = ["mazad", "sniper", "spy", "bus", "movies", "system", "guess", "mafia"];
  socket.on("host:selectGame", ({ gameId }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || socket.id !== room.hostSocketId || room.started) return;
    if (!IMPLEMENTED_GAMES.includes(gameId)) return;
    room.selectedGame = gameId;
    broadcastRoom(roomCode);
  });

  // الهوست يرجع لشاشة اختيار اللعبة تاني من قاعة الانتظار (من غير ما يسيب الغرفة خالص)
  socket.on("host:backToGameSelect", () => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || socket.id !== room.hostSocketId || room.started) return;
    room.selectedGame = null;
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
    if (room.selectedGame === "sniper") {
      startSniperMatch(roomCode);
      return;
    }
    if (room.selectedGame === "movies") {
      startMoviesRound(roomCode, false);
      return;
    }
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
  // إنهاء الماتش الحالي وعرض النتيجة النهائية (متاح فى أي لعبة وأي وقت)
  socket.on("host:endMatch", () => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || socket.id !== room.hostSocketId || !room.selectedGame) return;
    if (endMatchForGame(room, roomCode)) broadcastRoom(roomCode);
  });

  // جولة/ماتش جديد بنفس اللعبة ونفس اللاعبين - بيصفّر النقاط ويبدأ من الأول
  socket.on("host:newMatch", (payload) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || socket.id !== room.hostSocketId || !room.selectedGame) return;
    const gameId = room.selectedGame;
    if (gameId === "movies") {
      room.movies = null;
      startMoviesRound(roomCode, false);
    } else if (gameId === "bus") {
      const categoryIds = (room.bus?.categories || []).map((c) => c.id);
      room.bus = null;
      startBusRound(roomCode, categoryIds, false);
    } else if (gameId === "sniper") {
      startSniperMatch(roomCode);
    } else if (gameId === "spy") {
      startSpyMatch(roomCode, room.spy?.category || (payload && payload.category) || "random");
    } else if (gameId === "system") {
      startSystemMatch(roomCode, null);
    } else if (gameId === "guess") {
      startGuessMatch(roomCode);
    } else if (gameId === "mafia") {
      room.mafia = null;
      startMafiaMatch(roomCode, "random");
    }
  });

  socket.on("host:pauseTimer", () => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || socket.id !== room.hostSocketId) return;
    if (pauseAnyGame(room, roomCode)) broadcastRoom(roomCode);
  });

  socket.on("host:resumeTimer", () => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || socket.id !== room.hostSocketId) return;
    if (resumeAnyGame(room, roomCode)) broadcastRoom(roomCode);
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

  // لاعب بيدوس "اتقتلت" - يشتغل مع القناص نفسه كمان (بيدوسه بعد آخر ضحية عشان يتمويه)
  socket.on("sniper:eliminated", () => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || room.selectedGame !== "sniper" || !room.sniper || room.sniper.phase !== "playing") return;
    const s = room.sniper;
    if (!room.players[socket.id]) return;
    if (s.eliminatedOrder.includes(socket.id)) return; // دوسها قبل كده
    s.eliminatedOrder.push(socket.id);

    // أول ما يفضل شخص واحد بس معندوش "اتقتلت" (غير القناص لو كسل يدوسها)، هو ده اللي هيخمن
    const totalPlayers = s.playerOrder.length;
    if (s.eliminatedOrder.length === totalPlayers - 1 && !s.guesserId) {
      s.guesserId = socket.id;
      s.phase = "guessing";
    }
    broadcastRoom(roomCode);
  });

  // الشخص الأخير بيخمن مين كان القناص
  socket.on("sniper:guess", ({ targetId }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || room.selectedGame !== "sniper" || !room.sniper || room.sniper.phase !== "guessing") return;
    const s = room.sniper;
    if (socket.id !== s.guesserId) return;
    if (!room.players[targetId]) return;
    s.guessTargetId = targetId;
    s.correct = targetId === s.sniperId;
    s.phase = "reveal";
    broadcastRoom(roomCode);
  });

  // ماتش جديد بنفس اللاعبين (قناص عشوائي جديد)
  socket.on("host:sniperRematch", () => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || socket.id !== room.hostSocketId || room.selectedGame !== "sniper") return;
    startSniperMatch(roomCode);
  });

  // رجوع للوبي (مثلاً لو الهوست عايز يسيب حد يدخل الغرفة قبل الماتش الجاي)
  socket.on("host:sniperBackToLobby", () => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || socket.id !== room.hostSocketId || room.selectedGame !== "sniper") return;
    room.sniper = null;
    room.started = false;
    room.phase = "lobby";
    broadcastRoom(roomCode);
  });

  // ---------- أحداث لعبة الجاسوس ----------
  socket.on("host:startSpyMatch", ({ category }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || socket.id !== room.hostSocketId || room.started) return;
    if (room.selectedGame !== "spy") return;
    startSpyMatch(roomCode, category);
  });

  // أي حد يدوس "التالي" يمرر السؤال لزوج عشوائي جديد - بس الهوست عشان الإيقاع يبقى منظم
  socket.on("host:spyNextTurn", () => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || socket.id !== room.hostSocketId || room.selectedGame !== "spy" || !room.spy) return;
    if (room.spy.phase !== "discussing") return;
    room.spy.turn = pickRandomPair(room.spy.playerOrder);
    broadcastRoom(roomCode);
  });

  // الهوست بيقفل النقاش ويفتح باب التصويت لما اللاعبين يقولوا "يلا نصوّت"
  socket.on("host:spyStartVoting", () => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || socket.id !== room.hostSocketId || room.selectedGame !== "spy" || !room.spy) return;
    if (room.spy.phase !== "discussing") return;
    room.spy.phase = "voting";
    broadcastRoom(roomCode);
  });

  socket.on("spy:vote", ({ accusedId }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || room.selectedGame !== "spy" || !room.spy || room.spy.phase !== "voting") return;
    if (!room.players[socket.id] || !room.players[accusedId]) return;
    room.spy.votes[socket.id] = accusedId;

    if (Object.keys(room.spy.votes).length === room.spy.playerOrder.length) {
      // كل الناس صوتت - نحسم النتيجة. فى حالة تعادل، أول واحد وصل لأعلى عدد أصوات هو اللي بيتحاسب
      const counts = {};
      for (const accused of Object.values(room.spy.votes)) {
        counts[accused] = (counts[accused] || 0) + 1;
      }
      let topId = null;
      let topCount = -1;
      for (const [pid, count] of Object.entries(counts)) {
        if (count > topCount) {
          topCount = count;
          topId = pid;
        }
      }
      room.spy.accused = topId;
      room.spy.correctlyCaught = topId === room.spy.spyId;
      room.spy.phase = room.spy.correctlyCaught ? "spyFinalGuess" : "reveal";
    }
    broadcastRoom(roomCode);
  });

  // لو اتمسك، بتبقى له فرصة أخيرة يخمن الكلمة/المكان بالظبط عشان يفوز برغم كده
  socket.on("spy:finalGuess", ({ guess }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || room.selectedGame !== "spy" || !room.spy || room.spy.phase !== "spyFinalGuess") return;
    if (socket.id !== room.spy.spyId) return;
    const normalize = (s) => (s || "").trim().toLowerCase();
    room.spy.spyFinalGuessText = guess;
    room.spy.spyGuessCorrect = normalize(guess) === normalize(room.spy.word);
    room.spy.phase = "reveal";
    broadcastRoom(roomCode);
  });

  socket.on("host:spyBackToLobby", () => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || socket.id !== room.hostSocketId || room.selectedGame !== "spy") return;
    room.spy = null;
    room.started = false;
    room.phase = "lobby";
    broadcastRoom(roomCode);
  });

  // ---------- أحداث أتوبيس كومبليت استوب ----------
  socket.on("host:startBusRound", ({ categoryIds, keepTotals }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || socket.id !== room.hostSocketId || room.selectedGame !== "bus") return;
    if (!keepTotals && room.started) return; // بداية ماتش جديد بس لما مفيش ماتش شغال
    startBusRound(roomCode, categoryIds || [], !!keepTotals);
  });

  // كل لاعب بيبعت إجاباته وهو بيكتب (بنحفظ آخر نسخة) - عشان لو حد ضغط استوب
  // نكون ماسكين اللي كتبه كل واحد لحد اللحظة دي
  socket.on("bus:updateAnswers", ({ answers }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || room.selectedGame !== "bus" || !room.bus || room.bus.phase !== "writing") return;
    if (!room.players[socket.id]) return;
    room.bus.answers[socket.id] = answers || {};
    // مش بنعمل broadcast هنا عشان مانكشفش إجابات الناس وهم لسه بيكتبوا
  });

  // أول واحد يخلص كل الفئات يدوس استوب فتقف الكتابة على الكل فورًا
  socket.on("bus:stop", ({ answers }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || room.selectedGame !== "bus" || !room.bus || room.bus.phase !== "writing") return;
    if (!room.players[socket.id]) return;
    room.bus.answers[socket.id] = answers || {};
    room.bus.stopperId = socket.id;
    room.bus.phase = "review";
    broadcastRoom(roomCode);
  });

  // الهوست بيشطب أي إجابة غلط (مش بحرف الجولة، أو مش من الفئة) قبل الحساب
  socket.on("host:busToggleReject", ({ playerId, categoryId }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || socket.id !== room.hostSocketId || room.selectedGame !== "bus" || !room.bus) return;
    if (room.bus.phase !== "review") return;
    const key = `${playerId}:${categoryId}`;
    if (room.bus.rejected[key]) delete room.bus.rejected[key];
    else room.bus.rejected[key] = true;
    broadcastRoom(roomCode);
  });

  socket.on("host:busConfirmScores", () => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || socket.id !== room.hostSocketId || room.selectedGame !== "bus" || !room.bus) return;
    if (room.bus.phase !== "review") return;
    computeBusScores(room);
    room.bus.phase = "results";
    broadcastRoom(roomCode);
  });

  // الهوست يقدر يعدّل نقط أي لاعب يدوي بعد الحساب التلقائي
  // (مثلاً إجابة صح بس مكتوبة بحروف غلط)
  socket.on("host:busAdjustScore", ({ playerId, delta }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || socket.id !== room.hostSocketId || room.selectedGame !== "bus" || !room.bus) return;
    if (room.bus.phase !== "results") return;
    if (!room.players[playerId]) return;
    const step = Number(delta) || 0;
    room.bus.roundScores[playerId] = Math.max(0, (room.bus.roundScores[playerId] || 0) + step);
    room.bus.totals[playerId] = Math.max(0, (room.bus.totals[playerId] || 0) + step);
    broadcastRoom(roomCode);
  });

  socket.on("host:busBackToLobby", () => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || socket.id !== room.hostSocketId || room.selectedGame !== "bus") return;
    room.bus = null;
    room.started = false;
    room.phase = "lobby";
    broadcastRoom(roomCode);
  });

  // ---------- أحداث لعبة أفلام ----------
  socket.on("host:updateMoviesSettings", ({ actDuration, targetScore }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || socket.id !== room.hostSocketId || room.started) return;
    if (typeof actDuration === "number") {
      room.moviesSettings.actDuration = Math.max(15, Math.min(180, actDuration));
    }
    if (typeof targetScore === "number") {
      room.moviesSettings.targetScore = Math.max(1, Math.min(30, targetScore));
    }
    broadcastRoom(roomCode);
  });

  socket.on("host:startMoviesRound", ({ keepScores }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || socket.id !== room.hostSocketId || room.selectedGame !== "movies") return;
    if (!keepScores && room.started) return;
    startMoviesRound(roomCode, !!keepScores);
  });

  socket.on("host:moviesCorrect", () => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || socket.id !== room.hostSocketId || room.selectedGame !== "movies") return;
    endMoviesRound(roomCode, "correct");
  });

  socket.on("movies:withdraw", () => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || room.selectedGame !== "movies" || !room.movies) return;
    if (socket.id !== room.movies.actorId) return;
    endMoviesRound(roomCode, "withdraw");
  });

  socket.on("host:moviesBackToLobby", () => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || socket.id !== room.hostSocketId || room.selectedGame !== "movies") return;
    if (room.movies?.timeout) clearTimeout(room.movies.timeout);
    room.movies = null;
    room.started = false;
    room.phase = "lobby";
    broadcastRoom(roomCode);
  });

  // ---------- أحداث لعبة سيستم ----------
  socket.on("host:startSystemMatch", ({ customText }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || socket.id !== room.hostSocketId || room.selectedGame !== "system" || room.started) return;
    startSystemMatch(roomCode, customText);
  });

  // اللي مش عارف السيستم بيقول إنه جاهز يخمن
  socket.on("system:readyToGuess", () => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || room.selectedGame !== "system" || !room.system || room.system.phase !== "playing") return;
    if (socket.id !== room.system.unawareId) return;
    room.system.phase = "guessing";
    broadcastRoom(roomCode);
  });

  socket.on("system:submitGuess", ({ guess }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || room.selectedGame !== "system" || !room.system || room.system.phase !== "guessing") return;
    if (socket.id !== room.system.unawareId) return;
    room.system.guessText = guess;
    room.system.phase = "reveal";
    // التخمين هنا وصفي مش نص حرفي، فالهوست هو اللي بيحكم صح ولا غلط
    broadcastRoom(roomCode);
  });

  socket.on("host:systemVerdict", ({ correct }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || socket.id !== room.hostSocketId || room.selectedGame !== "system" || !room.system) return;
    room.system.correct = !!correct;
    room.system.phase = "reveal";
    broadcastRoom(roomCode);
  });

  socket.on("host:systemBackToLobby", () => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || socket.id !== room.hostSocketId || room.selectedGame !== "system") return;
    room.system = null;
    room.started = false;
    room.phase = "lobby";
    broadcastRoom(roomCode);
  });

  // ---------- أحداث لعبة خمن ----------
  socket.on("host:startGuessMatch", () => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || socket.id !== room.hostSocketId || room.selectedGame !== "guess" || room.started) return;
    startGuessMatch(roomCode);
  });

  // الخمّان خلص سؤاله مع الشخص الحالي - اللعبة تختار الشخص اللي بعده
  socket.on("guess:nextTarget", () => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || room.selectedGame !== "guess" || !room.guess || room.guess.phase !== "asking") return;
    if (socket.id !== room.guess.guesserId) return;
    const g = room.guess;
    if (g.turn && !g.askedIds.includes(g.turn)) g.askedIds.push(g.turn);
    const remaining = g.playerOrder.filter((id) => id !== g.guesserId && !g.askedIds.includes(id));
    // لو الكل اتسأل، بنبدأ لفة جديدة من الأول
    const pool = remaining.length > 0 ? remaining : g.playerOrder.filter((id) => id !== g.guesserId);
    if (remaining.length === 0) g.askedIds = [];
    g.turn = pool[randomInt(pool.length)];
    broadcastRoom(roomCode);
  });

  // الخمّان يقدر يخمن فى أي وقت
  socket.on("guess:submitGuess", ({ guess }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || room.selectedGame !== "guess" || !room.guess || room.guess.phase !== "asking") return;
    if (socket.id !== room.guess.guesserId) return;
    const normalize = (s) => (s || "").trim().toLowerCase().replace(/^ال/, "");
    room.guess.guessText = guess;
    room.guess.correct = normalize(guess) === normalize(room.guess.word);
    room.guess.phase = "reveal";
    broadcastRoom(roomCode);
  });

  socket.on("host:guessBackToLobby", () => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || socket.id !== room.hostSocketId || room.selectedGame !== "guess") return;
    room.guess = null;
    room.started = false;
    room.phase = "lobby";
    broadcastRoom(roomCode);
  });

  // ---------- أحداث لعبة مافيا ----------
  socket.on("host:startMafiaMatch", ({ mafiaCount }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || socket.id !== room.hostSocketId || room.selectedGame !== "mafia" || room.started) return;
    startMafiaMatch(roomCode, mafiaCount);
  });

  // أي مافيا يختار الهدف - الاختيار مشترك بين كل المافيا (لو أكتر من واحد)
  socket.on("mafia:setTarget", ({ targetId }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || !room.mafia || room.mafia.phase !== "night") return;
    const m = room.mafia;
    if (m.roles[socket.id] !== "mafia" || !m.aliveIds.includes(socket.id)) return;
    if (!m.aliveIds.includes(targetId) || m.roles[targetId] === "mafia") return;
    m.nightTargetId = targetId;
    broadcastRoom(roomCode);
    tryAdvanceMafiaNight(roomCode);
  });

  // الدكتور يختار يعالج مين - وله حد لعلاج نفسه (مرتين بس، مش ورا بعض)
  socket.on("doctor:setTarget", ({ targetId }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || !room.mafia || room.mafia.phase !== "night") return;
    const m = room.mafia;
    if (m.roles[socket.id] !== "doctor" || !m.aliveIds.includes(socket.id)) return;
    if (!m.aliveIds.includes(targetId)) return;
    if (targetId === socket.id) {
      const usedSoFar = m.doctorSelfHealCounts[socket.id] || 0;
      const lastRound = m.doctorLastSelfHealRound[socket.id];
      if (usedSoFar >= 2 || lastRound === m.round - 1) {
        socket.emit("game:error", "معاكش فرصة تعالج نفسك تاني دلوقتي.");
        return;
      }
      m.doctorSelfHealCounts[socket.id] = usedSoFar + 1;
      m.doctorLastSelfHealRound[socket.id] = m.round;
    }
    m.healTargetId = targetId;
    broadcastRoom(roomCode);
    tryAdvanceMafiaNight(roomCode);
  });

  // كل لاعب حي بيكتب وصيته (10-100 حرف)
  socket.on("mafia:submitWill", ({ text }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || !room.mafia || room.mafia.phase !== "night") return;
    const m = room.mafia;
    if (!m.aliveIds.includes(socket.id)) return;
    const trimmed = (text || "").trim();
    if (trimmed.length < 10 || trimmed.length > 100) {
      socket.emit("game:error", "من فضلك اكتب وصيتك.");
      return;
    }
    m.wills[socket.id] = trimmed;
    broadcastRoom(roomCode);
    tryAdvanceMafiaNight(roomCode);
  });

  // زرار "التالي" العام - بيحرك اللعبة بين المراحل اللي محتاجة تأكيد من الهوست
  socket.on("host:mafiaAdvance", () => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || socket.id !== room.hostSocketId || !room.mafia) return;
    const m = room.mafia;

    if (m.phase === "reveal_wills") {
      if (checkMafiaWin(room)) {
        broadcastRoom(roomCode);
        return;
      }
      m.phase = "day_announce";
      broadcastRoom(roomCode);
      return;
    }

    if (m.phase === "day_announce") {
      // لو محدش مات (الدكتور عالج صح)، مفيش داعي لنقاش ولا تصويت -
      // نكمل على طول لليلة جديدة
      if (!m.lastNightResult || !m.lastNightResult.killedId) {
        m.round += 1;
        m.phase = "night";
        m.nightTargetId = null;
        m.healTargetId = null;
        m.wills = {};
        m.willsRevealList = [];
        m.lastNightResult = null;
        m.votes = {};
        m.voteCounts = null;
        m.lastVoteOut = null;
        broadcastRoom(roomCode);
        return;
      }
      m.phase = "discussion";
      m.discussionEndsAt = Date.now() + 90 * 1000;
      m.discussionTimeout = setTimeout(() => startMafiaVoting(roomCode), 90 * 1000 + 300);
      broadcastRoom(roomCode);
      return;
    }

    if (m.phase === "discussion") {
      if (m.discussionTimeout) clearTimeout(m.discussionTimeout);
      startMafiaVoting(roomCode);
      return;
    }

    if (m.phase === "vote_result") {
      m.round += 1;
      m.phase = "night";
      m.nightTargetId = null;
      m.healTargetId = null;
      m.wills = {};
      m.willsRevealList = [];
      m.lastNightResult = null;
      m.votes = {};
      m.voteCounts = null;
      m.lastVoteOut = null;
      broadcastRoom(roomCode);
      return;
    }
  });

  socket.on("mafia:vote", ({ targetId }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || !room.mafia || room.mafia.phase !== "voting") return;
    const m = room.mafia;
    if (!m.aliveIds.includes(socket.id) || !m.aliveIds.includes(targetId)) return;
    m.votes[socket.id] = targetId;
    broadcastRoom(roomCode);
    if (Object.keys(m.votes).length === m.aliveIds.length) {
      resolveMafiaVote(roomCode);
    }
  });

  socket.on("host:mafiaBackToLobby", () => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || socket.id !== room.hostSocketId || room.selectedGame !== "mafia") return;
    if (room.mafia?.discussionTimeout) clearTimeout(room.mafia.discussionTimeout);
    room.mafia = null;
    room.started = false;
    room.phase = "lobby";
    broadcastRoom(roomCode);
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

  // الهوست بيدوس "التالي" بعد الانسحاب عشان يبدأ دور الفريق اللي بعده -
  // بدل ما التايمر يبدأ لوحده على طول لحظة الانسحاب
  socket.on("host:continueAfterWithdraw", () => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || socket.id !== room.hostSocketId || room.phase !== "explainWithdrawn") return;
    advanceToNextBidder(roomCode);
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
    endSniperMatchIfActive(room, roomCode);
    delete room.players[socket.id];
    socket.leave(roomCode);
    socket.data.roomCode = null;
    broadcastRoom(roomCode);
  });

  socket.on("host:endGame", () => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || socket.id !== room.hostSocketId) return;
    if (room.selectedGame === "sniper") {
      room.sniper = null;
      room.started = false;
      room.phase = "lobby";
      broadcastRoom(roomCode);
      return;
    }
    if (room.selectedGame === "spy") {
      room.spy = null;
      room.started = false;
      room.phase = "lobby";
      broadcastRoom(roomCode);
      return;
    }
    if (room.selectedGame === "bus") {
      room.bus = null;
      room.started = false;
      room.phase = "lobby";
      broadcastRoom(roomCode);
      return;
    }
    if (["movies", "system", "guess"].includes(room.selectedGame)) {
      if (room.movies?.timeout) clearTimeout(room.movies.timeout);
      room.movies = null;
      room.system = null;
      room.guess = null;
      room.started = false;
      room.phase = "lobby";
      broadcastRoom(roomCode);
      return;
    }
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
    endSniperMatchIfActive(room, roomCode);
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
  console.log(`GAWLA server running: http://localhost:${PORT}`);
});

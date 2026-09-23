const fs = require("fs");
const path = require("path");

// بيحفظ العناصر اللي اتستخدمت قبل كده على الديسك، عشان الكلمات/السيستمز
// ماتتكررش حتى لو اللعبة اتقفلت واتفتحت تاني أو السيرفر اترستارت.
// لما البنك كله يخلص، بنصفّر ونبدأ من الأول (بس بنستنى الأخير عشان
// ماييجيش نفس العنصر مرتين ورا بعض).
const STORE_PATH = path.join(__dirname, "used-items.json");

let store = {};
try {
  if (fs.existsSync(STORE_PATH)) {
    store = JSON.parse(fs.readFileSync(STORE_PATH, "utf8")) || {};
  }
} catch (e) {
  store = {};
}

function scheduleSave() {
  // بنكتب على طول (الملف صغير جدًا) عشان لو السيرفر اتقفل فجأة
  // ماتضيعش آخر العناصر اللي اتسحبت وتتكرر تاني بعد الرستارت
  try {
    fs.writeFileSync(STORE_PATH, JSON.stringify(store), "utf8");
  } catch (e) {}
}

/**
 * بيختار عنصر عشوائي من list ما اتستخدمش قبل كده فى الـ bucket ده.
 * @param {string} bucket مفتاح البنك (مثلاً "system" أو "movies" أو "spy:place")
 * @param {Array} list العناصر المتاحة
 * @param {(item) => string} keyOf إزاي نميز العنصر (افتراضي: العنصر نفسه لو نص)
 */
function pickFresh(bucket, list, keyOf) {
  if (!list || list.length === 0) return null;
  const idOf = keyOf || ((x) => (typeof x === "string" ? x : x.id || JSON.stringify(x)));
  const used = new Set(store[bucket] || []);

  let pool = list.filter((item) => !used.has(idOf(item)));

  if (pool.length === 0) {
    // البنك خلص - نصفّر ونستثني آخر عنصر بس عشان مايتكررش ورا بعضه
    const lastUsed = (store[bucket] || []).slice(-1)[0];
    store[bucket] = [];
    pool = list.filter((item) => idOf(item) !== lastUsed);
    if (pool.length === 0) pool = list.slice();
  }

  const chosen = pool[Math.floor(Math.random() * pool.length)];
  store[bucket] = [...(store[bucket] || []), idOf(chosen)];
  scheduleSave();
  return chosen;
}

module.exports = { pickFresh };

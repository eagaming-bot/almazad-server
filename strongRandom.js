// عشوائية معزّزة بتخلط أكتر من مصدر مع بعض، بنفس فكرة النسخة اللي في
// الكلاينت بالظبط - عشان يبقى فيه طبقة حماية إضافية موحّدة فى الاختيار
// العشوائي (مين المافيا، مين القناص، إلخ) سواء اللعب من هاتف واحد أو
// من خلال السيرفر. الجمع هنا بيتم بـ"باقي القسمة على 1" (modular
// addition) مش بمتوسط مرجّح، عشان التوزيع يفضل منتظم فعليًا - جمع
// مرجّح لأكتر من قيمة منتظمة بيميل للقيم اللي فى النص (زي نتيجة رمي
// أكتر من زهر) وده مش المطلوب هنا.
let callSeed = Math.floor(Math.random() * 1e9);

function strongRandom() {
  callSeed = (callSeed + 1) % 1e9;
  const a = Math.random();
  const b = Math.random();
  const t = (Date.now() % 100000) / 100000;
  const s = (callSeed % 10007) / 10007;
  let mixed = a + b + t + s;
  mixed = mixed - Math.floor(mixed);
  return mixed;
}

function randomInt(n) {
  if (n <= 0) return 0;
  return Math.min(n - 1, Math.floor(strongRandom() * n));
}

function shuffleArray(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

module.exports = { strongRandom, randomInt, shuffleArray };

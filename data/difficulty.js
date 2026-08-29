// بيوزع Difficulty Score (1-10) بالتناوب على قايمة كلمات، عشان كل كلمة تاخد رقم صعوبة تقريبي
// من غير ما نحتاج نحدد كل كلمة يدويًا واحدة واحدة.
function withDifficulty(list, seed = 0) {
  return list.map((text, i) => ({ text: text.trim(), difficulty: 1 + ((i + seed) % 10) }));
}

module.exports = { withDifficulty };

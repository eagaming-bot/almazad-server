const AR = require("./data/words.ar");
const EN = require("./data/words.en");

const CATEGORY_KEYS = ["countries", "food", "movies", "objects", "animals", "names"];

function getBank(language) {
  return language === "en" ? EN : AR;
}

// category: 'all' أو أحد مفاتيح CATEGORY_KEYS
function getPool(language, category) {
  const bank = getBank(language);
  if (!category || category === "all") {
    return CATEGORY_KEYS.reduce((acc, key) => acc.concat(bank[key] || []), []);
  }
  return bank[category] || [];
}

module.exports = { getPool, CATEGORY_KEYS };

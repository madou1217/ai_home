'use strict';

// 翻译目标/源语言的语言目录与「输入语言探测」。
//
// 为什么探测放在服务端：WebUI 的翻译页与全局悬浮窗都要在输入时实时显示检出的语言，
// 两处若各写一套脚本规则，结论必然不一致（"这是日语还是中文"最容易被误判）。这里给出
// 唯一实现，两侧只渲染结果。
//
// 判定顺序刻意是「决定性字符 → 假名/谚文 → 拉丁语言停用词 → 拉丁语言字母统计」，因为
// 汉字中日共用的部分无法靠字符集区分：出现平假名/片假名即日语；出现谚文即韩语；只有
// 汉字时用中文常用字与日语专用汉字（々 等）辅助；纯拉丁文本才走停用词与词形统计。
//
// 语言目录（LANGUAGES）同时是「可设置默认值」的白名单：前端下拉、服务端校验、目标语言
// 名称注入提示词都只从这里读，新增语言 = 加一行（含中文名与英文名，供模型理解）。

const LANGUAGES = Object.freeze([
  { code: 'zh-Hans', label: '简体中文', english: 'Simplified Chinese', native: '简体中文' },
  { code: 'zh-Hant', label: '繁體中文', english: 'Traditional Chinese', native: '繁體中文' },
  { code: 'en', label: '英语', english: 'English', native: 'English' },
  { code: 'ja', label: '日语', english: 'Japanese', native: '日本語' },
  { code: 'ko', label: '韩语', english: 'Korean', native: '한국어' },
  { code: 'fr', label: '法语', english: 'French', native: 'Français' },
  { code: 'de', label: '德语', english: 'German', native: 'Deutsch' },
  { code: 'es', label: '西班牙语', english: 'Spanish', native: 'Español' },
  { code: 'pt', label: '葡萄牙语', english: 'Portuguese', native: 'Português' },
  { code: 'ru', label: '俄语', english: 'Russian', native: 'Русский' },
  { code: 'it', label: '意大利语', english: 'Italian', native: 'Italiano' },
  { code: 'ar', label: '阿拉伯语', english: 'Arabic', native: 'العربية' },
  { code: 'th', label: '泰语', english: 'Thai', native: 'ไทย' },
  { code: 'vi', label: '越南语', english: 'Vietnamese', native: 'Tiếng Việt' },
  { code: 'id', label: '印尼语', english: 'Indonesian', native: 'Bahasa Indonesia' },
  { code: 'tr', label: '土耳其语', english: 'Turkish', native: 'Türkçe' },
  { code: 'nl', label: '荷兰语', english: 'Dutch', native: 'Nederlands' },
  { code: 'pl', label: '波兰语', english: 'Polish', native: 'Polski' },
  { code: 'hi', label: '印地语', english: 'Hindi', native: 'हिन्दी' }
]);

const AUTO_LANGUAGE = 'auto';

const BY_CODE = new Map(LANGUAGES.map((item) => [String(item.code).toLowerCase(), item]));

// 常见别名/旧写法 → 目录项。只做同义归一，不创造新语言。
const CODE_ALIASES = Object.freeze({
  zh: 'zh-Hans',
  'zh-cn': 'zh-Hans',
  'zh-sg': 'zh-Hans',
  'zh-hans-cn': 'zh-Hans',
  'zh-tw': 'zh-Hant',
  'zh-hk': 'zh-Hant',
  'zh-mo': 'zh-Hant',
  'zh-hant-tw': 'zh-Hant',
  cn: 'zh-Hans',
  chinese: 'zh-Hans',
  english: 'en',
  japanese: 'ja',
  korean: 'ko',
  french: 'fr',
  german: 'de',
  spanish: 'es',
  portuguese: 'pt',
  russian: 'ru',
  italian: 'it',
  arabic: 'ar',
  thai: 'th',
  vietnamese: 'vi',
  indonesian: 'id',
  turkish: 'tr',
  dutch: 'nl',
  polish: 'pl',
  hindi: 'hi'
});

function normalizeLanguageCode(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const lower = raw.toLowerCase().replace(/_/g, '-');
  if (lower === AUTO_LANGUAGE) return AUTO_LANGUAGE;
  const alias = CODE_ALIASES[lower];
  if (alias) return alias;
  const direct = BY_CODE.get(lower);
  return direct ? direct.code : '';
}

function isSupportedLanguage(value) {
  const code = normalizeLanguageCode(value);
  return Boolean(code && code !== AUTO_LANGUAGE);
}

function getLanguage(codeRaw) {
  const code = normalizeLanguageCode(codeRaw);
  if (!code || code === AUTO_LANGUAGE) return null;
  const entry = BY_CODE.get(code.toLowerCase());
  return entry ? { ...entry } : null;
}

function languageLabel(codeRaw) {
  const entry = getLanguage(codeRaw);
  return entry ? entry.label : '';
}

/**
 * 注入提示词的语言名：优先用英文名（模型对所有语言的稳定识别度最高），并在括号里补
 * 原生写法，让「简体中文 / 繁體中文」「日语 / 中文」这类近邻语言不会被混淆。
 */
function languagePromptName(codeRaw) {
  const entry = getLanguage(codeRaw);
  if (!entry) return '';
  return entry.native && entry.native !== entry.english
    ? `${entry.english} (${entry.native})`
    : entry.english;
}

function listLanguages() {
  return LANGUAGES.map((item) => ({ ...item }));
}

const HAN_RE = /[\u4e00-\u9fff\u3400-\u4dbf]/;
const HIRAGANA_RE = /[\u3040-\u309f]/;
const KATAKANA_RE = /[\u30a0-\u30ff\u31f0-\u31ff]/;
const HANGUL_RE = /[\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]/;
const CYRILLIC_RE = /[\u0400-\u04ff]/;
const ARABIC_RE = /[\u0600-\u06ff\u0750-\u077f]/;
const THAI_RE = /[\u0e00-\u0e7f]/;
const DEVANAGARI_RE = /[\u0900-\u097f]/;
const GREEK_RE = /[\u0370-\u03ff]/;
const HEBREW_RE = /[\u0590-\u05ff]/;
// 日语的「々」等叠字记号、以及只在日语里出现的假名组合，用于在纯汉字串上做辅助判断。
const JAPANESE_HAN_MARKERS = /[々〆ヶヵ]/;

// 拉丁语言停用词。只取高频、区分度高的短词，宁可漏判（回落统计）也不要误判。
const LATIN_STOPWORDS = Object.freeze({
  en: ['the', 'and', 'is', 'are', 'you', 'this', 'that', 'with', 'for', 'not', 'have', 'from', 'was', 'were', 'will', 'would', 'to', 'be', 'or', 'it', 'in', 'on', 'of', 'as', 'at', 'an', 'by'],
  fr: ['le', 'la', 'les', 'des', 'une', 'est', 'et', 'que', 'qui', 'pour', 'dans', 'avec', 'pas', 'vous', 'nous', 'sur'],
  de: ['der', 'die', 'das', 'und', 'ist', 'nicht', 'ein', 'eine', 'mit', 'für', 'auf', 'sich', 'dem', 'den', 'auch', 'wie'],
  es: ['el', 'la', 'los', 'las', 'que', 'una', 'por', 'con', 'para', 'como', 'pero', 'sus', 'este', 'esta', 'más', 'nos', 'es'],
  pt: ['o', 'a', 'os', 'as', 'que', 'não', 'uma', 'para', 'com', 'como', 'mas', 'seu', 'sua', 'este', 'esta', 'mais'],
  it: ['il', 'lo', 'la', 'gli', 'che', 'non', 'una', 'per', 'con', 'come', 'ma', 'suo', 'questa', 'questo', 'più', 'sono', 'è'],
  nl: ['de', 'het', 'een', 'niet', 'van', 'dat', 'met', 'voor', 'zijn', 'dit', 'maar', 'ook', 'aan', 'worden', 'kan', 'nog'],
  tr: ['ve', 'bir', 'bu', 'için', 'ile', 'değil', 'gibi', 'olarak', 'çok', 'daha', 'var', 'yok', 'ama', 'olan', 'kadar'],
  vi: ['và', 'của', 'không', 'một', 'cho', 'với', 'này', 'được', 'những', 'các', 'trong', 'khi', 'như', 'để', 'đã', 'là'],
  id: ['dan', 'yang', 'untuk', 'dengan', 'tidak', 'ini', 'itu', 'dari', 'akan', 'pada', 'juga', 'dalam', 'bisa', 'ada', 'atau', 'saya'],
  pl: ['i', 'w', 'nie', 'na', 'się', 'z', 'do', 'to', 'jest', 'że', 'jak', 'ale', 'co', 'tak', 'dla', 'od']
});

// Common English content words cover short UI selections such as “Hello
// world” where stopword evidence is absent.  Keep this deliberately small and
// require two hits so a product name or an isolated identifier is not guessed
// as English.
const ENGLISH_COMMON_WORDS = new Set([
  'hello', 'world', 'please', 'thanks', 'thank', 'welcome', 'translate',
  'translation', 'summary', 'summarize', 'effective', 'methods', 'monitor',
  'account', 'usage', 'including', 'tracking', 'models', 'quota', 'management',
  'strategy', 'strategies', 'today', 'tomorrow', 'what', 'where', 'when', 'how',
  'can', 'could', 'should', 'quickly', 'text', 'page', 'settings'
]);

// 拆出「像单词的拉丁字母片段」：允许重音符、撇号、连字符，长度 ≥ 1。
const LATIN_WORD_RE = /[A-Za-zÀ-ÖØ-öø-ÿĀ-ž'’-]+/g;

function countMatches(text, re) {
  const source = String(text || '');
  let count = 0;
  for (let index = 0; index < source.length; index += 1) {
    if (re.test(source[index])) count += 1;
  }
  return count;
}

function sampleText(text, limit = 4000) {
  const source = String(text || '');
  return source.length > limit ? source.slice(0, limit) : source;
}

function detectLatinLanguage(text) {
  // 两字母介词/冠词（例如波兰语 `i/w/z`）跨语言高度重叠，不能单独作为
  // 非英语证据。仍保留这些词参与计分，因为 `el ... es`、`le ... est` 这类
  // 短句只有两个字母停用词才能可靠识别；最终对非英语至少要求两个命中。
  const words = String(text || '').toLowerCase().match(LATIN_WORD_RE) || [];
  if (words.length === 0) return '';
  const scores = new Map();
  words.forEach((word) => {
    Object.entries(LATIN_STOPWORDS).forEach(([code, list]) => {
      if (list.includes(word)) scores.set(code, (scores.get(code) || 0) + 1);
    });
    if (ENGLISH_COMMON_WORDS.has(word)) scores.set('en', (scores.get('en') || 0) + 1);
  });
  let best = '';
  let bestScore = 0;
  scores.forEach((score, code) => {
    if (score > bestScore) {
      best = code;
      bestScore = score;
    }
  });
  // 至少两个独立停用词命中才算非英语；单命中在短句里噪声太大。
  if (best && bestScore >= 2) return best;
  // 没有停用词（短标签 / 专有名词）时用字母特征兜底：德语变音、葡语/越南语重音记号。
  const source = String(text || '');
  if (/[äöüß]/i.test(source) && !/[ãõ]/i.test(source)) return 'de';
  if (/[ãõ]/i.test(source)) return 'pt';
  if (/[đơư]/i.test(source)) return 'vi';
  // 英文技术文本常常只命中一个 `and/with/for`；英文作为默认工作语言可以
  // 接受单命中。其它语言的单命中返回未知，让调用方进入目标确认流程，避免
  // 把孤立的 `la` 等短词误判成法语或西班牙语；英文的 `to` 与波兰语共享，
  // 通过英文词表的优先级保持短英文句子的稳定默认值。
  if (bestScore === 1 && scores.get('en') === 1) return 'en';
  return '';
}

/**
 * 探测一段文本的语言。
 *
 * @param {string} text 待判定文本
 * @returns {{ code: string, label: string, confidence: 'high'|'medium'|'low', script: string }}
 *          无法判定时 code 为空串（调用方按「未知」处理，绝不猜一个具体语言）。
 */
function detectLanguage(text) {
  const source = sampleText(text);
  const trimmed = source.trim();
  if (!trimmed) {
    return { code: '', label: '', confidence: 'low', script: '' };
  }
  const total = trimmed.length || 1;
  const han = countMatches(trimmed, HAN_RE);
  const hiragana = countMatches(trimmed, HIRAGANA_RE);
  const katakana = countMatches(trimmed, KATAKANA_RE);
  const hangul = countMatches(trimmed, HANGUL_RE);
  const cyrillic = countMatches(trimmed, CYRILLIC_RE);
  const arabic = countMatches(trimmed, ARABIC_RE);
  const thai = countMatches(trimmed, THAI_RE);
  const devanagari = countMatches(trimmed, DEVANAGARI_RE);
  const greek = countMatches(trimmed, GREEK_RE);
  const hebrew = countMatches(trimmed, HEBREW_RE);

  const kana = hiragana + katakana;
  if (kana > 0) {
    const confidence = kana / total >= 0.1 ? 'high' : 'medium';
    return { code: 'ja', label: languageLabel('ja'), confidence, script: 'kana' };
  }
  if (hangul > 0) {
    return { code: 'ko', label: languageLabel('ko'), confidence: hangul / total >= 0.1 ? 'high' : 'medium', script: 'hangul' };
  }
  if (han > 0 && han / total >= 0.2) {
    // 汉字占主体：区分简繁用「繁体专有字 + 简体专有字」的命中数对比；
    // 日语专用记号（々〆ヶ）出现时判日语。
    const traditional = (trimmed.match(/[體國學會來個們這時間後實開關發現點對於樣]|[\u5f8c\u9593\u5be6\u958b\u767c]/g) || []).length;
    const simplified = (trimmed.match(/[体国学从来个们这时间后实开关发现点对于样]/g) || []).length;
    if (JAPANESE_HAN_MARKERS.test(trimmed) && traditional === 0 && simplified === 0) {
      return { code: 'ja', label: languageLabel('ja'), confidence: 'medium', script: 'han' };
    }
    const code = traditional > simplified ? 'zh-Hant' : 'zh-Hans';
    const gap = Math.abs(traditional - simplified);
    return {
      code,
      label: languageLabel(code),
      confidence: gap >= 2 ? 'high' : 'medium',
      script: 'han'
    };
  }
  if (cyrillic > 0 && cyrillic / total >= 0.2) {
    return { code: 'ru', label: languageLabel('ru'), confidence: 'high', script: 'cyrillic' };
  }
  if (arabic > 0 && arabic / total >= 0.2) {
    return { code: 'ar', label: languageLabel('ar'), confidence: 'high', script: 'arabic' };
  }
  if (thai > 0 && thai / total >= 0.2) {
    return { code: 'th', label: languageLabel('th'), confidence: 'high', script: 'thai' };
  }
  if (devanagari > 0 && devanagari / total >= 0.2) {
    return { code: 'hi', label: languageLabel('hi'), confidence: 'high', script: 'devanagari' };
  }
  // 希腊语 / 希伯来语不在目录里：给空 code（未知）而不是硬塞一个语言。
  if ((greek > 0 || hebrew > 0) && (greek + hebrew) / total >= 0.2) {
    return { code: '', label: '', confidence: 'low', script: greek > hebrew ? 'greek' : 'hebrew' };
  }
  const latin = detectLatinLanguage(trimmed);
  if (!latin) {
    return { code: '', label: '', confidence: 'low', script: '' };
  }
  const letters = (trimmed.match(/[A-Za-zÀ-ÖØ-öø-ÿĀ-ž]/g) || []).length;
  const words = trimmed.toLowerCase().match(LATIN_WORD_RE) || [];
  const englishContentWords = latin === 'en'
    ? words.filter((word) => word.length >= 3 && !LATIN_STOPWORDS.en.includes(word))
    : [];
  // Shared function words such as "to", "in", "as" can identify English as
  // a useful fallback, but they cannot prove the source language. Keep these
  // short selections low-confidence so the caller asks for confirmation
  // before treating an English target as the source language.
  const ambiguousEnglish = latin === 'en'
    && (englishContentWords.length === 0
      || (words.length <= 2 && englishContentWords.length < 2));
  return {
    code: latin,
    label: languageLabel(latin),
    confidence: ambiguousEnglish ? 'low' : letters / total >= 0.5 ? 'high' : 'medium',
    script: 'latin'
  };
}

module.exports = {
  LANGUAGES,
  AUTO_LANGUAGE,
  normalizeLanguageCode,
  isSupportedLanguage,
  getLanguage,
  languageLabel,
  languagePromptName,
  listLanguages,
  detectLanguage
};

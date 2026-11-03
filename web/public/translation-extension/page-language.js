/* global module */
(function publish(root) {
  'use strict';

  // Conservative page skipping, not a replacement for the server language
  // catalog. Script counts + distinct function words mirror its local detector
  // approach, with stricter evidence because skipping would hide untranslated
  // content. Document-level lang is deliberately never sufficient evidence.
  const latinWords = {
    en: 'the and is are you this that with for not have from was were will would to be or it in on of as at an by already your their these those which',
    fr: 'le la les des une est et que qui pour dans avec pas vous nous sur cette sont aux mais déjà',
    de: 'der die das und ist nicht ein eine mit für auf sich dem den auch wie diese bereits wird sind',
    es: 'el la los las que una por con para como pero sus este esta más nos es del está son ya',
    pt: 'os as que não uma para com como mas seu sua este esta mais são está dos das já',
    it: 'il lo la gli che non una per con come ma suo questa questo più sono è della già',
    nl: 'de het een niet van dat met voor zijn dit maar ook aan worden kan nog deze',
    tr: 've bir bu için ile değil gibi olarak çok daha var yok ama olan kadar zaten',
    vi: 'và của không một cho với này được những các trong khi như để đã là',
    id: 'dan yang untuk dengan tidak ini itu dari akan pada juga dalam bisa ada atau saya sudah',
    pl: 'nie na się do to jest że jak ale co tak dla od już oraz przez'
  };
  const latinSets = Object.fromEntries(Object.entries(latinWords).map(([code, words]) => [code, new Set(words.split(' '))]));
  const cues = {
    ru: new Set('это эта эти уже что как для из или мы вы они который которая чтобы потому есть может русском'.split(' ')),
    ar: new Set('هذا هذه ذلك التي الذي في من على إلى عن مع هو هي نحن لا أن إن دون باللغة العربية'.split(' ')),
    hi: new Set('यह वह और है हैं के की को में से नहीं लिए आप हम हिंदी'.split(' '))
  };
  const scriptPatterns = {
    han: /\p{Script=Han}/u, kana: /[\p{Script=Hiragana}\p{Script=Katakana}]/u,
    hangul: /\p{Script=Hangul}/u, cyrillic: /\p{Script=Cyrillic}/u,
    arabic: /\p{Script=Arabic}/u, thai: /\p{Script=Thai}/u,
    devanagari: /\p{Script=Devanagari}/u, latin: /\p{Script=Latin}/u
  };
  // Avoid shared Japanese shinjitai such as 国/体/学 as Chinese-only evidence.
  const simplified = /[这们说对为过经让吗还没语现发开关简译读页请网该应与写击录览设选并从实间进务产书]/gu;
  const traditional = /[這們說對為過經讓嗎還沒語現發開關簡譯讀頁請網該應與寫擊錄覽設選並從實間進務產書體學國個後]/gu;
  const chinesePhrases = /这是|這是|我们|我們|你们|你們|可以|已经|已經|这个|這個|没有|沒有|需要|请在|請在|如果|因为|因為|所以|但是|进行|進行|中文|翻译|翻譯|阅读|閱讀|页面|頁面/gu;

  function normalize(value) {
    const raw = String(value || '').trim().replace(/_/g, '-');
    if (!raw || raw.toLowerCase() === 'auto') return '';
    try {
      const locale = new Intl.Locale(raw);
      return locale.language === 'zh' ? locale.maximize().script === 'Hant' ? 'zh-Hant' : 'zh-Hans' : locale.language;
    } catch { return ''; }
  }

  function distinctMatches(text, pattern) { return new Set(text.match(pattern) || []).size; }
  function wordHits(text, dictionary) {
    const words = text.toLowerCase().match(/[\p{L}\p{M}]+/gu) || [];
    return new Set(words.filter((word) => dictionary.has(word))).size;
  }
  const outcome = (skip, reason) => ({ skip, source: 'auto', reason });

  function decide(segment, target) {
    const text = String(typeof segment === 'string' ? segment : segment?.source || segment?.text || '').trim();
    const requested = normalize(target);
    if (!requested) return outcome(false, 'target-unknown');
    // Do not sample and then skip the unseen tail of a long mixed paragraph.
    if (text.length < 8 || text.length > 12000) return outcome(false, 'insufficient-text');
    if (/https?:\/\/|www\.|[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.test(text)) return outcome(false, 'url-or-identifier');
    const counts = Object.fromEntries(Object.keys(scriptPatterns).map((key) => [key, 0]));
    let letters = 0; let other = 0;
    for (const character of text) {
      if (!/\p{L}/u.test(character)) continue;
      letters += 1;
      const script = Object.keys(scriptPatterns).find((key) => scriptPatterns[key].test(character));
      if (script) counts[script] += 1; else other += 1;
    }
    if (letters < 8) return outcome(false, 'insufficient-letters');
    if (other) return outcome(false, 'unsupported-script');
    const active = Object.keys(counts).filter((key) => counts[key] > 0);
    const japanese = counts.kana >= 3 && active.every((key) => key === 'han' || key === 'kana');
    if (active.length > 1 && !japanese) return outcome(false, 'mixed-scripts');
    if (japanese) return outcome(requested === 'ja', requested === 'ja' ? 'text-target-japanese' : 'different-language');
    if (counts.kana) return outcome(false, 'insufficient-japanese');

    let detected = '';
    if (counts.han) {
      const local = segment?.languageSource === 'local-declaration' ? normalize(segment.sourceLanguage) : '';
      if (local === 'ja' || /[々〆ヶヵ]/u.test(text)) return outcome(false, 'ambiguous-han');
      const simple = distinctMatches(text, simplified);
      const complex = distinctMatches(text, traditional);
      const phrases = distinctMatches(text, chinesePhrases);
      if (simple && complex) return outcome(false, 'mixed-chinese-variants');
      const clearSimple = simple >= 2 || (simple >= 1 && phrases >= 2);
      const clearTraditional = complex >= 2 || (complex >= 1 && phrases >= 2);
      if (phrases < 1 || (!clearSimple && !clearTraditional && !(phrases >= 2 && local.startsWith('zh-')))) return outcome(false, 'ambiguous-han');
      if (clearSimple) detected = 'zh-Hans';
      else if (clearTraditional) detected = 'zh-Hant';
      else return outcome(requested.startsWith('zh-'), requested.startsWith('zh-') ? 'shared-chinese-text' : 'different-language');
    } else if (counts.hangul >= 8) detected = 'ko';
    else if (counts.thai >= 12) detected = 'th';
    else if (counts.cyrillic >= 15 && !/[іїєґўђјљњћџ]/iu.test(text) && wordHits(text, cues.ru) >= 3) detected = 'ru';
    else if (counts.arabic >= 15 && !/[پچژگکیےں]/u.test(text) && wordHits(text, cues.ar) >= 3) detected = 'ar';
    else if (counts.devanagari >= 15 && wordHits(text, cues.hi) >= 4 && /(?:^|\s)(?:है|हैं)(?:\s|[।.!?]|$)/u.test(text)) detected = 'hi';
    else if (counts.latin) {
      const words = text.toLowerCase().match(/[\p{L}\p{M}]+/gu) || [];
      if (words.length < 6) return outcome(false, 'short-latin-text');
      const scores = Object.entries(latinSets).map(([code, dictionary]) => ({ code, hits: new Set(words.filter((word) => dictionary.has(word))).size })).sort((a, b) => b.hits - a.hits);
      const first = scores[0]; const second = scores[1];
      if (first.hits < 4 || second.hits >= 3 || first.hits - second.hits < 2) return outcome(false, 'ambiguous-latin');
      detected = first.code;
    }
    return outcome(Boolean(detected && detected === requested), detected ? detected === requested ? 'text-target-language' : 'different-language' : 'insufficient-language-evidence');
  }

  const api = Object.freeze({ decide });
  root.AIHTranslationPageLanguage = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);

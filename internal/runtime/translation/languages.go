// Package translation 承载 AI 翻译的语言目录、语种探测、意图校验、设置存储、
// 模型目录装配与路由对冲执行（对应 Node translation-* 与 lib/translation/*）。
package translation

import (
	"regexp"
	"strings"
	"unicode"
)

// AutoLanguage 表示源语言自动探测标记。
const AutoLanguage = "auto"

// MaxDetectSampleRunes 是语种探测截取的最大样本长度。
const MaxDetectSampleRunes = 4000

// Language 描述一条受支持的翻译语言目录项。
type Language struct {
	Code    string `json:"code"`
	Label   string `json:"label"`
	English string `json:"english"`
	Native  string `json:"native"`
}

var supportedLanguages = []Language{
	{Code: "zh-Hans", Label: "简体中文", English: "Simplified Chinese", Native: "简体中文"},
	{Code: "zh-Hant", Label: "繁體中文", English: "Traditional Chinese", Native: "繁體中文"},
	{Code: "en", Label: "英语", English: "English", Native: "English"},
	{Code: "ja", Label: "日语", English: "Japanese", Native: "日本語"},
	{Code: "ko", Label: "韩语", English: "Korean", Native: "한국어"},
	{Code: "fr", Label: "法语", English: "French", Native: "Français"},
	{Code: "de", Label: "德语", English: "German", Native: "Deutsch"},
	{Code: "es", Label: "西班牙语", English: "Spanish", Native: "Español"},
	{Code: "pt", Label: "葡萄牙语", English: "Portuguese", Native: "Português"},
	{Code: "ru", Label: "俄语", English: "Russian", Native: "Русский"},
	{Code: "it", Label: "意大利语", English: "Italian", Native: "Italiano"},
	{Code: "ar", Label: "阿拉伯语", English: "Arabic", Native: "العربية"},
	{Code: "th", Label: "泰语", English: "Thai", Native: "ไทย"},
	{Code: "vi", Label: "越南语", English: "Vietnamese", Native: "Tiếng Việt"},
	{Code: "id", Label: "印尼语", English: "Indonesian", Native: "Bahasa Indonesia"},
	{Code: "tr", Label: "土耳其语", English: "Turkish", Native: "Türkçe"},
	{Code: "nl", Label: "荷兰语", English: "Dutch", Native: "Nederlands"},
	{Code: "pl", Label: "波兰语", English: "Polish", Native: "Polski"},
	{Code: "hi", Label: "印地语", English: "Hindi", Native: "हिन्दी"},
}

var languagesByCode = func() map[string]Language {
	byCode := make(map[string]Language, len(supportedLanguages))
	for _, entry := range supportedLanguages {
		byCode[strings.ToLower(entry.Code)] = entry
	}
	return byCode
}()

var codeAliases = map[string]string{
	"zh":          "zh-Hans",
	"zh-cn":       "zh-Hans",
	"zh-sg":       "zh-Hans",
	"zh-hans-cn":  "zh-Hans",
	"zh-tw":       "zh-Hant",
	"zh-hk":       "zh-Hant",
	"zh-mo":       "zh-Hant",
	"zh-hant-tw":  "zh-Hant",
	"cn":          "zh-Hans",
	"chinese":     "zh-Hans",
	"english":     "en",
	"japanese":    "ja",
	"korean":      "ko",
	"french":      "fr",
	"german":      "de",
	"spanish":     "es",
	"portuguese":  "pt",
	"russian":     "ru",
	"italian":     "it",
	"arabic":      "ar",
	"thai":        "th",
	"vietnamese":  "vi",
	"indonesian":  "id",
	"turkish":     "tr",
	"dutch":       "nl",
	"polish":      "pl",
	"hindi":       "hi",
}

// NormalizeLanguageCode 将语言别名归一为目录标准代码；不识别返回空串。
func NormalizeLanguageCode(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}
	lower := strings.ReplaceAll(strings.ToLower(trimmed), "_", "-")
	if lower == AutoLanguage {
		return AutoLanguage
	}
	if alias, ok := codeAliases[lower]; ok {
		return alias
	}
	if entry, ok := languagesByCode[lower]; ok {
		return entry.Code
	}
	return ""
}

// IsSupportedLanguage 判断给定值是否为受支持的具体语种（不含 auto）。
func IsSupportedLanguage(raw string) bool {
	code := NormalizeLanguageCode(raw)
	return code != "" && code != AutoLanguage
}

// GetLanguage 查询语言目录项。
func GetLanguage(raw string) (Language, bool) {
	code := NormalizeLanguageCode(raw)
	if code == "" || code == AutoLanguage {
		return Language{}, false
	}
	entry, ok := languagesByCode[strings.ToLower(code)]
	return entry, ok
}

// LanguageLabel 返回语种的中文界面标签。
func LanguageLabel(raw string) string {
	if entry, ok := GetLanguage(raw); ok {
		return entry.Label
	}
	return ""
}

// LanguagePromptName 返回注入提示词的语言名：优先英文名并在括号补充原生写法。
func LanguagePromptName(raw string) string {
	entry, ok := GetLanguage(raw)
	if !ok {
		return ""
	}
	if entry.Native != "" && entry.Native != entry.English {
		return entry.English + " (" + entry.Native + ")"
	}
	return entry.English
}

// ListLanguages 返回所有受支持语种的有序副本。
func ListLanguages() []Language {
	out := make([]Language, len(supportedLanguages))
	copy(out, supportedLanguages)
	return out
}

// DetectionResult 表示一次本地语种探测的结论。
type DetectionResult struct {
	Code       string `json:"code"`
	Label      string `json:"label"`
	Confidence string `json:"confidence"`
	Script     string `json:"script"`
}

var (
	latinStopwordLanguages = []string{"en", "fr", "de", "es", "pt", "it", "nl", "tr", "vi", "id", "pl"}
	latinStopwords         = map[string]map[string]struct{}{
		"en": wordSet("the", "and", "is", "are", "you", "this", "that", "with", "for", "not", "have", "from", "was", "were", "will", "would", "to", "be", "or", "it", "in", "on", "of", "as", "at", "an", "by"),
		"fr": wordSet("le", "la", "les", "des", "une", "est", "et", "que", "qui", "pour", "dans", "avec", "pas", "vous", "nous", "sur"),
		"de": wordSet("der", "die", "das", "und", "ist", "nicht", "ein", "eine", "mit", "für", "auf", "sich", "dem", "den", "auch", "wie"),
		"es": wordSet("el", "la", "los", "las", "que", "una", "por", "con", "para", "como", "pero", "sus", "este", "esta", "más", "nos", "es"),
		"pt": wordSet("o", "a", "os", "as", "que", "não", "uma", "para", "com", "como", "mas", "seu", "sua", "este", "esta", "mais"),
		"it": wordSet("il", "lo", "la", "gli", "che", "non", "una", "per", "con", "come", "ma", "suo", "questa", "questo", "più", "sono", "è"),
		"nl": wordSet("de", "het", "een", "niet", "van", "dat", "met", "voor", "zijn", "dit", "maar", "ook", "aan", "worden", "kan", "nog"),
		"tr": wordSet("ve", "bir", "bu", "için", "ile", "değil", "gibi", "olarak", "çok", "daha", "var", "yok", "ama", "olan", "kadar"),
		"vi": wordSet("và", "của", "không", "một", "cho", "với", "này", "được", "những", "các", "trong", "khi", "như", "để", "đã", "là"),
		"id": wordSet("dan", "yang", "untuk", "dengan", "tidak", "ini", "itu", "dari", "akan", "pada", "juga", "dalam", "bisa", "ada", "atau", "saya"),
		"pl": wordSet("i", "w", "nie", "na", "się", "z", "do", "to", "jest", "że", "jak", "ale", "co", "tak", "dla", "od"),
	}
	englishCommonWords = wordSet(
		"hello", "world", "please", "thanks", "thank", "welcome", "translate",
		"translation", "summary", "summarize", "effective", "methods", "monitor",
		"account", "usage", "including", "tracking", "models", "quota", "management",
		"strategy", "strategies", "today", "tomorrow", "what", "where", "when", "how",
		"can", "could", "should", "quickly", "text", "page", "settings",
	)
	latinWordPattern     = regexp.MustCompile(`[A-Za-zÀ-ÖØ-öø-ÿĀ-ž'’-]+`)
	germanDiacriticRE    = regexp.MustCompile(`(?i)[äöüß]`)
	portugueseTildeRE    = regexp.MustCompile(`(?i)[ãõ]`)
	vietnameseSpecialRE  = regexp.MustCompile(`(?i)[đơư]`)
)

func wordSet(words ...string) map[string]struct{} {
	set := make(map[string]struct{}, len(words))
	for _, word := range words {
		set[word] = struct{}{}
	}
	return set
}

func sampleRunes(text string, limit int) string {
	if limit <= 0 {
		return ""
	}
	count := 0
	for index := range text {
		if count == limit {
			return text[:index]
		}
		count++
	}
	return text
}

func isHanRune(r rune) bool {
	return (r >= 0x4e00 && r <= 0x9fff) || (r >= 0x3400 && r <= 0x4dbf)
}

func isHiraganaRune(r rune) bool {
	return r >= 0x3040 && r <= 0x309f
}

func isKatakanaRune(r rune) bool {
	return (r >= 0x30a0 && r <= 0x30ff) || (r >= 0x31f0 && r <= 0x31ff)
}

func isHangulRune(r rune) bool {
	return (r >= 0xac00 && r <= 0xd7af) || (r >= 0x1100 && r <= 0x11ff) || (r >= 0x3130 && r <= 0x318f)
}

func isCyrillicRune(r rune) bool {
	return r >= 0x0400 && r <= 0x04ff
}

func isArabicRune(r rune) bool {
	return (r >= 0x0600 && r <= 0x06ff) || (r >= 0x0750 && r <= 0x077f)
}

func isThaiRune(r rune) bool {
	return r >= 0x0e00 && r <= 0x0e7f
}

func isDevanagariRune(r rune) bool {
	return r >= 0x0900 && r <= 0x097f
}

func isGreekRune(r rune) bool {
	return r >= 0x0370 && r <= 0x03ff
}

func isHebrewRune(r rune) bool {
	return r >= 0x0590 && r <= 0x05ff
}

func isJapaneseHanMarker(r rune) bool {
	return r == '々' || r == '〆' || r == 'ヶ' || r == 'ヵ'
}

func isTraditionalHanHint(r rune) bool {
	switch r {
	case '體', '國', '學', '會', '來', '個', '們', '這', '時', '間', '後', '實', '開', '關', '發', '現', '點', '對', '於', '樣':
		return true
	default:
		return false
	}
}

func isSimplifiedHanHint(r rune) bool {
	switch r {
	case '体', '国', '学', '从', '来', '个', '们', '这', '时', '间', '后', '实', '开', '关', '发', '现', '点', '对', '于', '样':
		return true
	default:
		return false
	}
}

func isLatinLetterRune(r rune) bool {
	return (r >= 'A' && r <= 'Z') ||
		(r >= 'a' && r <= 'z') ||
		(r >= 0x00c0 && r <= 0x00d6) ||
		(r >= 0x00d8 && r <= 0x00f6) ||
		(r >= 0x00f8 && r <= 0x00ff) ||
		(r >= 0x0100 && r <= 0x017e)
}

func detectLatinLanguage(text string) string {
	words := latinWordPattern.FindAllString(strings.ToLower(text), -1)
	if len(words) == 0 {
		return ""
	}
	scores := make(map[string]int, len(latinStopwordLanguages))
	for _, word := range words {
		for _, code := range latinStopwordLanguages {
			if _, ok := latinStopwords[code][word]; ok {
				scores[code]++
			}
		}
		if _, ok := englishCommonWords[word]; ok {
			scores["en"]++
		}
	}
	best := ""
	bestScore := 0
	for _, code := range latinStopwordLanguages {
		if scores[code] > bestScore {
			best = code
			bestScore = scores[code]
		}
	}
	if best != "" && bestScore >= 2 {
		return best
	}
	if germanDiacriticRE.MatchString(text) && !portugueseTildeRE.MatchString(text) {
		return "de"
	}
	if portugueseTildeRE.MatchString(text) {
		return "pt"
	}
	if vietnameseSpecialRE.MatchString(text) {
		return "vi"
	}
	if bestScore == 1 && scores["en"] == 1 {
		return "en"
	}
	return ""
}

// DetectLanguage 探测输入文本的语言；无法判定时返回空 Code。
func DetectLanguage(text string) DetectionResult {
	trimmed := strings.TrimSpace(sampleRunes(text, MaxDetectSampleRunes))
	if trimmed == "" {
		return DetectionResult{Confidence: "low"}
	}
	var (
		total, han, hiragana, katakana, hangul int
		cyrillic, arabic, thai, devanagari     int
		greek, hebrew                          int
		traditional, simplified                int
		hasJapaneseMarker                      bool
		latinLetters                           int
	)
	for _, r := range trimmed {
		total++
		switch {
		case isHanRune(r):
			han++
			if isTraditionalHanHint(r) {
				traditional++
			}
			if isSimplifiedHanHint(r) {
				simplified++
			}
		case isHiraganaRune(r):
			hiragana++
		case isKatakanaRune(r):
			katakana++
		case isHangulRune(r):
			hangul++
		case isCyrillicRune(r):
			cyrillic++
		case isArabicRune(r):
			arabic++
		case isThaiRune(r):
			thai++
		case isDevanagariRune(r):
			devanagari++
		case isGreekRune(r):
			greek++
		case isHebrewRune(r):
			hebrew++
		}
		if isJapaneseHanMarker(r) {
			hasJapaneseMarker = true
		}
		if isLatinLetterRune(r) {
			latinLetters++
		}
	}
	if total == 0 {
		total = 1
	}

	kana := hiragana + katakana
	if kana > 0 {
		conf := "medium"
		if float64(kana)/float64(total) >= 0.1 {
			conf = "high"
		}
		return DetectionResult{Code: "ja", Label: LanguageLabel("ja"), Confidence: conf, Script: "kana"}
	}
	if hangul > 0 {
		conf := "medium"
		if float64(hangul)/float64(total) >= 0.1 {
			conf = "high"
		}
		return DetectionResult{Code: "ko", Label: LanguageLabel("ko"), Confidence: conf, Script: "hangul"}
	}
	if han > 0 && float64(han)/float64(total) >= 0.2 {
		if hasJapaneseMarker && traditional == 0 && simplified == 0 {
			return DetectionResult{Code: "ja", Label: LanguageLabel("ja"), Confidence: "medium", Script: "han"}
		}
		code := "zh-Hans"
		if traditional > simplified {
			code = "zh-Hant"
		}
		gap := traditional - simplified
		if gap < 0 {
			gap = -gap
		}
		conf := "medium"
		if gap >= 2 {
			conf = "high"
		}
		return DetectionResult{Code: code, Label: LanguageLabel(code), Confidence: conf, Script: "han"}
	}
	if cyrillic > 0 && float64(cyrillic)/float64(total) >= 0.2 {
		conf := "medium"
		if float64(cyrillic)/float64(total) >= 0.5 {
			conf = "high"
		}
		return DetectionResult{Code: "ru", Label: LanguageLabel("ru"), Confidence: conf, Script: "cyrillic"}
	}
	if arabic > 0 && float64(arabic)/float64(total) >= 0.2 {
		conf := "medium"
		if float64(arabic)/float64(total) >= 0.5 {
			conf = "high"
		}
		return DetectionResult{Code: "ar", Label: LanguageLabel("ar"), Confidence: conf, Script: "arabic"}
	}
	if thai > 0 && float64(thai)/float64(total) >= 0.2 {
		conf := "medium"
		if float64(thai)/float64(total) >= 0.5 {
			conf = "high"
		}
		return DetectionResult{Code: "th", Label: LanguageLabel("th"), Confidence: conf, Script: "thai"}
	}
	if devanagari > 0 && float64(devanagari)/float64(total) >= 0.2 {
		conf := "medium"
		if float64(devanagari)/float64(total) >= 0.5 {
			conf = "high"
		}
		return DetectionResult{Code: "hi", Label: LanguageLabel("hi"), Confidence: conf, Script: "devanagari"}
	}
	if greek > 0 || hebrew > 0 {
		script := "hebrew"
		if greek > 0 {
			script = "greek"
		}
		return DetectionResult{Code: "", Label: "", Confidence: "low", Script: script}
	}

	latin := detectLatinLanguage(trimmed)
	if latin == "" {
		return DetectionResult{Confidence: "low"}
	}
	words := latinWordPattern.FindAllString(strings.ToLower(trimmed), -1)
	englishContentWords := 0
	if latin == "en" {
		enStops := latinStopwords["en"]
		for _, word := range words {
			if runeCount(word) >= 3 {
				if _, isStop := enStops[word]; !isStop {
					englishContentWords++
				}
			}
		}
	}
	ambiguousEnglish := latin == "en" && (englishContentWords == 0 || (len(words) <= 2 && englishContentWords < 2))
	conf := "medium"
	if ambiguousEnglish {
		conf = "low"
	} else if float64(latinLetters)/float64(total) >= 0.5 {
		conf = "high"
	}
	return DetectionResult{
		Code:       latin,
		Label:      LanguageLabel(latin),
		Confidence: conf,
		Script:     "latin",
	}
}

func runeCount(value string) int {
	n := 0
	for range value {
		n++
	}
	return n
}

func containsNonSpace(value string) bool {
	for _, r := range value {
		if !unicode.IsSpace(r) {
			return true
		}
	}
	return false
}

// TargetPolicies 定义允许的目标语言确认策略。
var validTargetPolicies = map[string]struct{}{
	"saved":         {},
	"explicit":      {},
	"confirm":       {},
	"same-language": {},
}

// LanguageIntentInput 描述一次翻译意图的语言判定输入。
type LanguageIntentInput struct {
	Source          string
	Target          string
	Detected        string
	Confidence      string
	TargetPolicy    string
	AllowAutoSource bool
}

// LanguageIntent 表示语种组合裁决结果。
type LanguageIntent struct {
	State  string
	Source string
	Target string
	Reason string
}

// ResolveLanguageIntent 裁决一次请求的源/目标语言是否可安全送往上。
func ResolveLanguageIntent(input LanguageIntentInput) LanguageIntent {
	rawSource := strings.TrimSpace(input.Source)
	if rawSource == "" {
		rawSource = AutoLanguage
	}
	rawTarget := strings.TrimSpace(input.Target)
	rawDetected := strings.TrimSpace(input.Detected)

	source := NormalizeLanguageCode(rawSource)
	target := NormalizeLanguageCode(rawTarget)
	detected := NormalizeLanguageCode(rawDetected)

	policy := "saved"
	if _, ok := validTargetPolicies[input.TargetPolicy]; ok {
		policy = input.TargetPolicy
	}

	if (rawSource != "" && source == "") ||
		(rawTarget != "" && target == "") ||
		(rawDetected != "" && detected == "") {
		return LanguageIntent{State: "unsupported", Reason: "unsupported_language"}
	}
	if source != AutoLanguage && !IsSupportedLanguage(source) {
		return LanguageIntent{State: "unsupported", Reason: "unsupported_source"}
	}
	if target != "" && target != AutoLanguage && !IsSupportedLanguage(target) {
		return LanguageIntent{State: "unsupported", Reason: "unsupported_target"}
	}
	if target == "" || target == AutoLanguage {
		resolvedSrc := source
		if source == AutoLanguage {
			resolvedSrc = detected
		}
		return LanguageIntent{State: "needs_target_confirmation", Source: resolvedSrc, Reason: "target_required"}
	}

	resolvedSource := source
	if source == AutoLanguage {
		resolvedSource = detected
	}
	confidence := strings.ToLower(strings.TrimSpace(input.Confidence))
	if source == AutoLanguage && input.AllowAutoSource && (resolvedSource == "" || confidence == "low") {
		return LanguageIntent{State: "ready", Source: AutoLanguage, Target: target, Reason: "provider_auto_source"}
	}
	if resolvedSource == "" || !IsSupportedLanguage(resolvedSource) {
		return LanguageIntent{State: "needs_target_confirmation", Source: resolvedSource, Target: target, Reason: "source_detection_required"}
	}
	if confidence == "low" && policy != "explicit" {
		return LanguageIntent{State: "needs_target_confirmation", Source: resolvedSource, Target: target, Reason: "low_confidence"}
	}
	if resolvedSource == target && policy != "explicit" {
		return LanguageIntent{State: "same_language", Source: resolvedSource, Target: target, Reason: "same_language"}
	}
	return LanguageIntent{State: "ready", Source: resolvedSource, Target: target, Reason: "ready"}
}

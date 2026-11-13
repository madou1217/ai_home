package translation

import (
	"strings"
	"testing"
)

func TestNormalizeLanguageCodeAndCatalog(t *testing.T) {
	cases := []struct {
		raw  string
		want string
	}{
		{"", ""},
		{"auto", AutoLanguage},
		{"AUTO", AutoLanguage},
		{"zh", "zh-Hans"},
		{"zh-Hans", "zh-Hans"},
		{"zh_cn", "zh-Hans"},
		{"zh-TW", "zh-Hant"},
		{"zh-HK", "zh-Hant"},
		{"zh_Hant", "zh-Hant"},
		{"en", "en"},
		{"ja", "ja"},
		{"xx-INVALID", ""},
	}
	for _, tc := range cases {
		if got := NormalizeLanguageCode(tc.raw); got != tc.want {
			t.Errorf("NormalizeLanguageCode(%q) = %q, want %q", tc.raw, got, tc.want)
		}
	}

	langs := ListLanguages()
	if len(langs) < 12 {
		t.Fatalf("ListLanguages len = %d, want >= 12", len(langs))
	}
	if !IsSupportedLanguage("zh-CN") || IsSupportedLanguage("auto") {
		t.Fatalf("IsSupportedLanguage invariants broken")
	}
	if got := LanguagePromptName("zh-TW"); !strings.Contains(got, "Traditional Chinese") {
		t.Fatalf("LanguagePromptName(zh-TW) = %q", got)
	}
}

func TestDetectLanguage(t *testing.T) {
	cases := []struct {
		name           string
		text           string
		wantCode       string
		wantConfidence string
	}{
		{"empty", "   ", "", "low"},
		{"simplified_chinese", "这是一段用于测试翻译服务的简体中文句子。", "zh-Hans", "high"},
		{"traditional_chinese", "這是一段繁體中文測試內容，裡面包含臺灣與閱讀等字樣。", "zh-Hant", "high"},
		{"japanese", "これは日本語の翻訳テストです。", "ja", "high"},
		{"korean", "이것은 한국어 번역 테스트 문장입니다.", "ko", "high"},
		{"russian", "Это тестовое предложение на русском языке.", "ru", "high"},
		{"arabic", "هذه جملة اختبار باللغة العربية.", "ar", "high"},
		{"english", "This is a clear English sentence for translation testing with the and for.", "en", "high"},
		{"french", "Bonjour, ceci est une phrase pour tester la traduction avec vous dans le bureau.", "fr", "high"},
		{"german", "Das ist ein deutscher Satz mit der und für die Übersetzung.", "de", "high"},
		{"ambiguous_short", "ok", "", "low"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			res := DetectLanguage(tc.text)
			if res.Code != tc.wantCode {
				t.Fatalf("DetectLanguage(%q).Code = %q, want %q (full=%+v)", tc.text, res.Code, tc.wantCode, res)
			}
			if res.Confidence != tc.wantConfidence {
				t.Fatalf("DetectLanguage(%q).Confidence = %q, want %q (full=%+v)", tc.text, res.Confidence, tc.wantConfidence, res)
			}
		})
	}
}

func TestResolveLanguageIntent(t *testing.T) {
	// 明示相同语种 -> same_language
	res := ResolveLanguageIntent(LanguageIntentInput{
		Source: "en",
		Target: "en",
	})
	if res.State != "same_language" {
		t.Fatalf("explicit same language state = %q, want same_language", res.State)
	}

	// auto + 高置信命中目标语 -> same_language
	res = ResolveLanguageIntent(LanguageIntentInput{
		Source:     "auto",
		Target:     "zh-CN",
		Detected:   "zh-CN",
		Confidence: "high",
	})
	if res.State != "same_language" {
		t.Fatalf("auto same detected state = %q, want same_language", res.State)
	}

	// auto + 目标 auto -> needs_target_confirmation
	res = ResolveLanguageIntent(LanguageIntentInput{
		Source:     "auto",
		Target:     "auto",
		Detected:   "en",
		Confidence: "high",
	})
	if res.State != "needs_target_confirmation" || res.Reason != "target_required" {
		t.Fatalf("auto+auto = %+v, want needs_target_confirmation/target_required", res)
	}

	// 低置信度且不允许 auto-source -> needs_target_confirmation
	res = ResolveLanguageIntent(LanguageIntentInput{
		Source:          "auto",
		Target:          "zh-CN",
		Detected:        "en",
		Confidence:      "low",
		AllowAutoSource: false,
	})
	if res.State != "needs_target_confirmation" || res.Reason != "low_confidence" {
		t.Fatalf("low confidence disallow auto = %+v, want needs_target_confirmation/low_confidence", res)
	}

	// 低置信度且允许 auto-source -> ready with Source=auto
	res = ResolveLanguageIntent(LanguageIntentInput{
		Source:          "auto",
		Target:          "zh-CN",
		Detected:        "en",
		Confidence:      "low",
		AllowAutoSource: true,
	})
	if res.State != "ready" || res.Source != AutoLanguage {
		t.Fatalf("low confidence allow auto = %+v, want ready/auto", res)
	}

	// 高置信度简体中文 -> en
	res = ResolveLanguageIntent(LanguageIntentInput{
		Source:     "auto",
		Target:     "en",
		Detected:   "zh-Hans",
		Confidence: "high",
	})
	if res.State != "ready" || res.Source != "zh-Hans" || res.Target != "en" {
		t.Fatalf("zh-Hans -> en = %+v", res)
	}
}

func TestBuildTranslationMessagesAndDirectPrompt(t *testing.T) {
	msgRes := BuildTranslationMessages(TranslationMessagesInput{
		Text:      "Hello AIH",
		Source:    "en",
		Target:    "zh-Hans",
		Formality: "formal",
		Glossary: []GlossaryItem{
			{Source: "AIH", Target: "AI Home"},
			{Source: " ", Target: "skip"},
		},
	})
	if len(msgRes.Messages) != 2 || msgRes.Messages[0].Role != "system" || msgRes.Messages[1].Role != "user" {
		t.Fatalf("unexpected messages: %+v", msgRes.Messages)
	}
	if !strings.Contains(msgRes.System, "Simplified Chinese") ||
		!strings.Contains(msgRes.System, "formal") ||
		!strings.Contains(msgRes.System, "AIH => AI Home") {
		t.Fatalf("missing directives in system prompt: %s", msgRes.System)
	}

	sys, user := BuildDirectLLMPrompt("你好", "zh-CN", "en", "casual")
	if !strings.Contains(sys, "English") || !strings.Contains(sys, "Simplified Chinese") || !strings.Contains(sys, "casual") {
		t.Fatalf("unexpected direct prompt sys: %s", sys)
	}
	if user != "你好" {
		t.Fatalf("unexpected user prompt: %q", user)
	}
}

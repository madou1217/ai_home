package launcher

import (
	"sort"
	"strings"
	"time"
	"unicode"
)

// Single source of truth for AIH Launch search and ranking constants (§6).
// Native UI filters (macOS Swift, Windows C#, Linux C) must stay synchronized with these values.
const (
	ScoreExactName        = 1000
	ScoreNamePrefixBase   = 900
	ScoreNamePrefixMaxPen = 50
	ScoreWordPrefix       = 800
	ScoreAcronym          = 750
	ScoreSubstringBase    = 700
	ScoreSubstringMaxPen  = 100
	ScoreSubsequenceBase  = 600
	ScoreSubseqMaxPen     = 150
	ScoreSubtitleOnly     = 300

	RecencyBoostWindow = 7 * 24 * time.Hour
	RecencyBoostPoints = 30
	CountBoostCap      = 10
)

// NormalizeQuery trims whitespace and lowercases text while preserving CJK runes.
func NormalizeQuery(s string) string {
	return strings.ToLower(strings.TrimSpace(s))
}

// ScoreApp returns the base match score for app against a normalized non-empty query.
// Returns 0 when the app does not match.
func ScoreApp(app App, normalizedQuery string) int {
	if normalizedQuery == "" {
		return 0
	}
	qRunes := []rune(normalizedQuery)
	nameNorm := NormalizeQuery(app.Name)
	nRunes := []rune(nameNorm)

	best := 0
	if len(nRunes) > 0 {
		// 1. Exact name match.
		if nameNorm == normalizedQuery {
			best = maxInt(best, ScoreExactName)
		}
		// 2. Name prefix match: 900 - min(nameLen - queryLen, 50).
		if hasRunePrefix(nRunes, qRunes) {
			pen := len(nRunes) - len(qRunes)
			if pen > ScoreNamePrefixMaxPen {
				pen = ScoreNamePrefixMaxPen
			}
			if pen < 0 {
				pen = 0
			}
			best = maxInt(best, ScoreNamePrefixBase-pen)
		}
		// 3 & 4. Word prefix (800) and acronym (750) over whitespace / '-' / '_' / '/' tokens.
		words := splitWords(nRunes)
		if len(words) > 0 {
			initials := make([]rune, 0, len(words))
			for _, w := range words {
				if hasRunePrefix(w, qRunes) {
					best = maxInt(best, ScoreWordPrefix)
				}
				initials = append(initials, w[0])
			}
			if indexRunes(initials, qRunes) >= 0 {
				best = maxInt(best, ScoreAcronym)
			}
		}
		// 5. Name substring match: 700 - min(pos, 100).
		if idx := indexRunes(nRunes, qRunes); idx >= 0 {
			pen := idx
			if pen > ScoreSubstringMaxPen {
				pen = ScoreSubstringMaxPen
			}
			best = maxInt(best, ScoreSubstringBase-pen)
		}
		// 6. Name subsequence match: 600 - min(totalGaps, 150).
		if gaps, ok := subsequenceGaps(nRunes, qRunes); ok {
			pen := gaps
			if pen > ScoreSubseqMaxPen {
				pen = ScoreSubseqMaxPen
			}
			best = maxInt(best, ScoreSubsequenceBase-pen)
		}
	}

	// 7. Subtitle-only match: 300.
	if best == 0 {
		subNorm := NormalizeQuery(app.Subtitle)
		if subNorm != "" && strings.Contains(subNorm, normalizedQuery) {
			best = ScoreSubtitleOnly
		}
	}
	return best
}

// RecencyBoost computes the usage bonus: 30 (if opened within 7 days) + min(count, 10).
func RecencyBoost(entry UsageEntry, now time.Time) int {
	boost := 0
	if entry.OpenedAtMs > 0 {
		windowMs := RecencyBoostWindow.Milliseconds()
		if now.UnixMilli()-entry.OpenedAtMs <= windowMs {
			boost += RecencyBoostPoints
		}
	}
	if entry.Count > 0 {
		c := entry.Count
		if c > CountBoostCap {
			c = CountBoostCap
		}
		boost += c
	}
	return boost
}

// Rank filters (when query is non-empty) and sorts apps according to §6.
func Rank(apps []App, query string, usage map[string]UsageEntry, now time.Time) []App {
	qNorm := NormalizeQuery(query)
	if len(apps) == 0 {
		return []App{}
	}

	if qNorm == "" {
		type emptyItem struct {
			app        App
			openedAtMs int64
			nameLower  string
		}
		items := make([]emptyItem, 0, len(apps))
		for _, app := range apps {
			var opened int64
			if usage != nil {
				opened = usage[app.ID].OpenedAtMs
			}
			items = append(items, emptyItem{
				app:        app,
				openedAtMs: opened,
				nameLower:  NormalizeQuery(app.Name),
			})
		}
		sort.Slice(items, func(i, j int) bool {
			a, b := items[i], items[j]
			if (a.openedAtMs > 0) != (b.openedAtMs > 0) {
				return a.openedAtMs > 0
			}
			if a.openedAtMs != b.openedAtMs {
				return a.openedAtMs > b.openedAtMs
			}
			if a.nameLower != b.nameLower {
				return a.nameLower < b.nameLower
			}
			return a.app.ID < b.app.ID
		})
		out := make([]App, len(items))
		for i, item := range items {
			out[i] = item.app
		}
		return out
	}

	type scoredItem struct {
		app       App
		score     int
		nameLower string
	}
	scored := make([]scoredItem, 0, len(apps))
	for _, app := range apps {
		base := ScoreApp(app, qNorm)
		if base <= 0 {
			continue
		}
		var entry UsageEntry
		if usage != nil {
			entry = usage[app.ID]
		}
		scored = append(scored, scoredItem{
			app:       app,
			score:     base + RecencyBoost(entry, now),
			nameLower: NormalizeQuery(app.Name),
		})
	}
	sort.Slice(scored, func(i, j int) bool {
		a, b := scored[i], scored[j]
		if a.score != b.score {
			return a.score > b.score
		}
		if a.nameLower != b.nameLower {
			return a.nameLower < b.nameLower
		}
		return a.app.ID < b.app.ID
	})
	out := make([]App, len(scored))
	for i, item := range scored {
		out[i] = item.app
	}
	return out
}

func isWordSeparator(r rune) bool {
	return unicode.IsSpace(r) || r == '-' || r == '_' || r == '/'
}

func splitWords(runes []rune) [][]rune {
	var words [][]rune
	start := -1
	for i, r := range runes {
		if isWordSeparator(r) {
			if start >= 0 {
				words = append(words, runes[start:i])
				start = -1
			}
			continue
		}
		if start < 0 {
			start = i
		}
	}
	if start >= 0 {
		words = append(words, runes[start:])
	}
	return words
}

func hasRunePrefix(text, prefix []rune) bool {
	if len(prefix) == 0 || len(prefix) > len(text) {
		return false
	}
	for i := range prefix {
		if text[i] != prefix[i] {
			return false
		}
	}
	return true
}

func indexRunes(text, needle []rune) int {
	nLen := len(needle)
	if nLen == 0 || nLen > len(text) {
		return -1
	}
	limit := len(text) - nLen
	for i := 0; i <= limit; i++ {
		matched := true
		for j := 0; j < nLen; j++ {
			if text[i+j] != needle[j] {
				matched = false
				break
			}
		}
		if matched {
			return i
		}
	}
	return -1
}

func subsequenceGaps(text, query []rune) (int, bool) {
	if len(query) == 0 || len(query) > len(text) {
		return 0, false
	}
	qi := 0
	prev := -1
	gaps := 0
	for ti, r := range text {
		if r == query[qi] {
			if prev >= 0 {
				gaps += ti - prev - 1
			}
			prev = ti
			qi++
			if qi == len(query) {
				return gaps, true
			}
		}
	}
	return 0, false
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

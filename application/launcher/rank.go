package launcher

import (
	"math"
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
	ScoreAlias            = 650
	ScoreSubsequenceBase  = 600
	ScoreSubseqMaxPen     = 150
	ScoreSubtitleOnly     = 300

	// FrecencyHalfLife is the exponential decay time constant (14 days) for usage score (§6).
	FrecencyHalfLife = 14 * 24 * time.Hour
	// FrecencyBoostWeight scales decayed frecency score into integer boost points.
	FrecencyBoostWeight = 60
	// FrecencyBoostCap caps the integer boost emitted to API/UI clients.
	FrecencyBoostCap = 700
	// FrecencyV1MigrationCap caps initial score migrated from v1 usage.json counts.
	FrecencyV1MigrationCap = 20
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

	// 6b. Alias match (prefix/word-prefix/acronym/substring/subsequence): flat 650, max with name score.
	for _, alias := range app.Aliases {
		aliasNorm := NormalizeQuery(alias)
		if aliasNorm == "" {
			continue
		}
		if aliasMatches([]rune(aliasNorm), qRunes) {
			best = maxInt(best, ScoreAlias)
			break
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

func aliasMatches(aliasRunes, qRunes []rune) bool {
	if len(aliasRunes) == 0 || len(qRunes) == 0 {
		return false
	}
	if hasRunePrefix(aliasRunes, qRunes) || indexRunes(aliasRunes, qRunes) >= 0 {
		return true
	}
	words := splitWords(aliasRunes)
	if len(words) > 0 {
		initials := make([]rune, 0, len(words))
		for _, w := range words {
			if hasRunePrefix(w, qRunes) {
				return true
			}
			initials = append(initials, w[0])
		}
		if indexRunes(initials, qRunes) >= 0 {
			return true
		}
	}
	_, ok := subsequenceGaps(aliasRunes, qRunes)
	return ok
}

// MigrateUsageSnapshot upgrades a v1 usage snapshot in memory to the current schema version.
// v1 entries initialize Score = min(count, 20) and UpdatedAtMs = openedAtMs.
func MigrateUsageSnapshot(snap UsageSnapshot) UsageSnapshot {
	if snap.Apps == nil {
		snap.Apps = map[string]UsageEntry{}
	}
	if snap.Version < UsageVersion {
		for id, entry := range snap.Apps {
			snap.Apps[id] = migrateV1UsageEntry(entry)
		}
	} else {
		for id, entry := range snap.Apps {
			if math.IsNaN(entry.Score) || math.IsInf(entry.Score, 0) || entry.Score < 0 {
				entry.Score = 0
				snap.Apps[id] = entry
			}
		}
	}
	snap.Version = UsageVersion
	return snap
}

func migrateV1UsageEntry(entry UsageEntry) UsageEntry {
	if math.IsNaN(entry.Score) || math.IsInf(entry.Score, 0) || entry.Score < 0 {
		entry.Score = 0
	}
	if entry.Score == 0 && entry.UpdatedAtMs == 0 {
		c := entry.Count
		if c < 0 {
			c = 0
		}
		if c > FrecencyV1MigrationCap {
			c = FrecencyV1MigrationCap
		}
		entry.Score = float64(c)
		entry.UpdatedAtMs = entry.OpenedAtMs
	}
	return entry
}

// Frecency computes the exponentially decayed usage score of entry at now:
// score * exp(-(now - updatedAt) / FrecencyHalfLife).
func Frecency(entry UsageEntry, now time.Time) float64 {
	score := entry.Score
	updatedAtMs := entry.UpdatedAtMs
	if score <= 0 && updatedAtMs == 0 && entry.Count > 0 {
		migrated := migrateV1UsageEntry(entry)
		score = migrated.Score
		updatedAtMs = migrated.UpdatedAtMs
	}
	if score <= 0 || math.IsNaN(score) || math.IsInf(score, 0) {
		return 0
	}
	if updatedAtMs <= 0 {
		updatedAtMs = entry.OpenedAtMs
	}
	return decayScore(score, updatedAtMs, now.UnixMilli())
}

// FrecencyBoost converts entry's decayed frecency at now into the integer boost
// clamp(round(frecency * FrecencyBoostWeight), 0, FrecencyBoostCap).
func FrecencyBoost(entry UsageEntry, now time.Time) int {
	return frecencyToBoost(Frecency(entry, now))
}

// AdvanceUsageEntry decays entry's existing score to openedAtMs, adds 1, and updates
// timestamps and count for a newly recorded application open.
func AdvanceUsageEntry(entry UsageEntry, openedAtMs int64) UsageEntry {
	decayed := Frecency(entry, time.UnixMilli(openedAtMs))
	entry.Score = decayed + 1
	entry.UpdatedAtMs = openedAtMs
	entry.OpenedAtMs = openedAtMs
	entry.Count++
	return entry
}

func decayScore(score float64, updatedAtMs int64, nowMs int64) float64 {
	if score <= 0 || math.IsNaN(score) || math.IsInf(score, 0) {
		return 0
	}
	if updatedAtMs <= 0 || nowMs <= updatedAtMs {
		return score
	}
	dtMs := float64(nowMs - updatedAtMs)
	halfLifeMs := float64(FrecencyHalfLife.Milliseconds())
	decayed := score * math.Exp(-dtMs/halfLifeMs)
	if decayed <= 0 || math.IsNaN(decayed) || math.IsInf(decayed, 0) {
		return 0
	}
	return decayed
}

func frecencyToBoost(frecency float64) int {
	if frecency <= 0 || math.IsNaN(frecency) || math.IsInf(frecency, 0) {
		return 0
	}
	scaled := math.Round(frecency * FrecencyBoostWeight)
	if scaled <= 0 {
		return 0
	}
	if scaled >= float64(FrecencyBoostCap) {
		return FrecencyBoostCap
	}
	return int(scaled)
}

// Rank filters (when query is non-empty) and sorts apps according to §6 frecency rules.
// Never uses application name A–Z ordering.
func Rank(apps []App, query string, usage map[string]UsageEntry, now time.Time) []App {
	qNorm := NormalizeQuery(query)
	if len(apps) == 0 {
		return []App{}
	}

	if qNorm == "" {
		type emptyItem struct {
			app      App
			frecency float64
		}
		items := make([]emptyItem, 0, len(apps))
		for _, app := range apps {
			var entry UsageEntry
			if usage != nil {
				entry = usage[app.ID]
			}
			frecency := Frecency(entry, now)
			app.Boost = frecencyToBoost(frecency)
			items = append(items, emptyItem{
				app:      app,
				frecency: frecency,
			})
		}
		sort.Slice(items, func(i, j int) bool {
			a, b := items[i], items[j]
			if a.frecency != b.frecency {
				return a.frecency > b.frecency
			}
			if a.app.ModifiedAtMs != b.app.ModifiedAtMs {
				return a.app.ModifiedAtMs > b.app.ModifiedAtMs
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
		app   App
		score int
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
		boost := FrecencyBoost(entry, now)
		app.Boost = boost
		scored = append(scored, scoredItem{
			app:   app,
			score: base + boost,
		})
	}
	sort.Slice(scored, func(i, j int) bool {
		a, b := scored[i], scored[j]
		if a.score != b.score {
			return a.score > b.score
		}
		if a.app.Boost != b.app.Boost {
			return a.app.Boost > b.app.Boost
		}
		if a.app.ModifiedAtMs != b.app.ModifiedAtMs {
			return a.app.ModifiedAtMs > b.app.ModifiedAtMs
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

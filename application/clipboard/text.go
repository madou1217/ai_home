package clipboard

import (
	"sort"
	"strings"
	"unicode/utf8"
)

// windows1252High maps the 0x80–0x9F range that differs from ISO-8859-1.
// Clipboards bridged from Windows often carry CP1252 bytes (smart quotes,
// dashes, €); decoding them keeps text readable instead of storing mojibake.
var windows1252High = [32]rune{
	0x20AC, 0x0081, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021,
	0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008D, 0x017D, 0x008F,
	0x0090, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014,
	0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x009D, 0x017E, 0x0178,
}

// NormalizeText returns valid UTF-8 for clipboard text. Valid input is returned
// unchanged; otherwise bytes are decoded as Windows-1252 (with Latin-1 fallback),
// which is lossless for CP1252 and reversible for arbitrary single-byte data.
// Capture and sync both funnel through this so SHA-256 stays stable on the wire.
func NormalizeText(raw string) string {
	if utf8.ValidString(raw) {
		return raw
	}
	var builder strings.Builder
	builder.Grow(len(raw) + 8)
	for i := 0; i < len(raw); i++ {
		value := raw[i]
		switch {
		case value < 0x80:
			builder.WriteByte(value)
		case value < 0xA0:
			builder.WriteRune(windows1252High[value-0x80])
		default:
			builder.WriteRune(rune(value))
		}
	}
	return builder.String()
}

// NormalizeSyncedFilePaths canonicalizes a synced file list without the receiving
// OS's filepath rules: trim, drop empties/duplicates, sort, and join with newlines.
// The same bytes are hashed by sender and receiver, so Windows/macOS/Linux peers
// agree even though their absolute path syntax differs.
func NormalizeSyncedFilePaths(files []string) ([]string, []byte) {
	seen := make(map[string]struct{}, len(files))
	out := make([]string, 0, len(files))
	for _, raw := range files {
		trimmed := strings.TrimSpace(raw)
		if trimmed == "" {
			continue
		}
		if _, dup := seen[trimmed]; dup {
			continue
		}
		seen[trimmed] = struct{}{}
		out = append(out, trimmed)
	}
	sort.Strings(out)
	return out, []byte(strings.Join(out, "\n"))
}

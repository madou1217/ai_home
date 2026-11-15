// Package codexstatepage reads vendor-owned Codex state without mutating it.
package codexstatepage

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"
)

const cursorPrefix = "aih-state-v1:"
const maxSources = 16
const maxCandidates = 200000
const maxIdentityBytes = 32 << 20
const maxPage = 1024

var ErrBudget = errors.New("codex_state_read_budget_exceeded")
var ErrSchema = errors.New("codex_state_schema_unavailable")

type Params struct {
	Archived       bool     `json:"archived"`
	Cwd            string   `json:"cwd"`
	AllProjects    bool     `json:"allProjects"`
	ModelProviders []string `json:"modelProviders"`
	SourceKinds    []string `json:"sourceKinds"`
	Limit          int      `json:"limit"`
	SortKey        string   `json:"sortKey"`
	Cursor         string   `json:"cursor"`
}
type Row map[string]any
type Page struct {
	Rows       []Row   `json:"rows"`
	HasMore    bool    `json:"hasMore"`
	NextCursor *string `json:"nextCursor"`
}
type pageCursor struct {
	Version int     `json:"v"`
	SortKey string  `json:"sortKey"`
	Value   float64 `json:"value"`
	ID      string  `json:"id"`
	Filters string  `json:"filters"`
}

func text(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case []byte:
		return string(x)
	case int64:
		return strconv.FormatInt(x, 10)
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	}
	return ""
}
func numeric(v any) float64 {
	switch x := v.(type) {
	case int64:
		return float64(x)
	case float64:
		return x
	case string:
		n, _ := strconv.ParseFloat(strings.TrimSpace(x), 64)
		if !math.IsNaN(n) && !math.IsInf(n, 0) {
			return n
		}
	}
	return 0
}
func normalizeSort(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "created_at":
		return "created_at"
	case "recency_at":
		return "recency_at"
	}
	return "updated_at"
}
func normalizeSources(values []string) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, s := range values {
		s = strings.ToLower(strings.TrimSpace(s))
		if s != "" && !seen[s] {
			out = append(out, s)
			seen[s] = true
		}
	}
	if len(out) == 0 {
		return []string{"cli", "vscode"}
	}
	return out
}
func normalized(p Params) (Params, error) {
	p.Cwd = strings.TrimSpace(p.Cwd)
	if p.Cwd != "" && !filepath.IsAbs(p.Cwd) {
		p.Cwd = ""
	}
	p.SortKey = normalizeSort(p.SortKey)
	if len(p.SourceKinds) > 256 || len(p.ModelProviders) > 256 {
		return p, ErrBudget
	}
	p.SourceKinds = normalizeSources(p.SourceKinds)
	for _, value := range p.SourceKinds {
		if len(value) > 4096 {
			return p, ErrBudget
		}
	}
	if len(p.SourceKinds) > 256 || len(p.ModelProviders) > 256 || len(p.Cwd) > 32768 || len(p.Cursor) > 32768 {
		return p, ErrBudget
	}
	providers := []string{}
	for _, v := range p.ModelProviders {
		if v = strings.TrimSpace(v); v != "" {
			if len(v) > 4096 {
				return p, ErrBudget
			}
			providers = append(providers, v)
		}
	}
	p.ModelProviders = providers
	if p.Limit <= 0 {
		p.Limit = 50
	}
	if p.Limit > maxPage {
		return p, ErrBudget
	}
	return p, nil
}
func jsSort(values []string) {
	sort.Slice(values, func(i, j int) bool {
		a, b := utf16.Encode([]rune(values[i])), utf16.Encode([]rune(values[j]))
		for n := 0; n < len(a) && n < len(b); n++ {
			if a[n] != b[n] {
				return a[n] < b[n]
			}
		}
		return len(a) < len(b)
	})
}
func marshalWire(value any) ([]byte, error) {
	var out bytes.Buffer
	e := json.NewEncoder(&out)
	e.SetEscapeHTML(false)
	if err := e.Encode(value); err != nil {
		return nil, err
	}
	raw := bytes.TrimSuffix(out.Bytes(), []byte{'\n'})
	// JSON.stringify retains literal U+2028/U+2029. Skip escaped slashes:
	// the text "\\u2028" is not an actual U+2028 character.
	result := make([]byte, 0, len(raw))
	for i := 0; i < len(raw); {
		if raw[i] == '\\' && i+1 < len(raw) {
			if i+6 <= len(raw) && (string(raw[i:i+6]) == `\u2028` || string(raw[i:i+6]) == `\u2029`) {
				last := byte(0xa8)
				if raw[i+5] == '9' {
					last = 0xa9
				}
				result = append(result, 0xe2, 0x80, last)
				i += 6
				continue
			}
			result = append(result, raw[i:i+2]...)
			i += 2
			continue
		}
		result = append(result, raw[i])
		i++
	}
	return result, nil
}
func signature(p Params) string {
	models := append([]string{}, p.ModelProviders...)
	sources := append([]string{}, p.SourceKinds...)
	jsSort(models)
	jsSort(sources)
	shape := struct {
		Archived    bool     `json:"archived"`
		Cwd         string   `json:"cwd"`
		AllProjects bool     `json:"allProjects,omitempty"`
		Models      []string `json:"modelProviders"`
		Sources     []string `json:"sourceKinds"`
	}{p.Archived, p.Cwd, p.Cwd == "" && p.AllProjects, models, sources}
	raw, _ := marshalWire(shape)
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])[:24]
}
func decodeCursor(p Params) (*pageCursor, error) {
	if p.Cursor == "" {
		return nil, nil
	}
	raw := strings.TrimSpace(p.Cursor)
	if !strings.HasPrefix(raw, cursorPrefix) {
		return nil, errors.New("codex_state_cursor_invalid")
	}
	data, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(raw, cursorPrefix))
	if err != nil {
		return nil, errors.New("codex_state_cursor_invalid")
	}
	var c pageCursor
	if json.Unmarshal(data, &c) != nil || c.Version != 1 || strings.TrimSpace(c.ID) == "" || math.IsNaN(c.Value) || math.IsInf(c.Value, 0) || normalizeSort(c.SortKey) != p.SortKey || c.Filters != signature(p) {
		return nil, errors.New("codex_state_cursor_invalid")
	}
	return &c, nil
}
func encodeCursor(p Params, id string, value float64) *string {
	raw, _ := marshalWire(pageCursor{1, p.SortKey, value, id, signature(p)})
	v := cursorPrefix + base64.RawURLEncoding.EncodeToString(raw)
	return &v
}
func timestamps(row Row) (updated, created float64) {
	updated = numeric(row["updated_at_ms"])
	if updated == 0 {
		updated = numeric(row["updated_at"]) * 1000
	}
	created = numeric(row["created_at_ms"])
	if created == 0 {
		created = numeric(row["created_at"]) * 1000
	}
	return
}
func completeness(row Row) int {
	n := 0
	for key, v := range row {
		if !strings.HasPrefix(key, "__") && v != nil && v != "" {
			n++
		}
	}
	return n
}
func worktree(cwd string) bool {
	return strings.Contains(strings.ToLower(strings.ReplaceAll(strings.TrimSpace(cwd), "\\", "/")), "/.codex/worktrees/")
}
func subagent(row Row, spawned map[string]bool) bool {
	if spawned[strings.TrimSpace(text(row["id"]))] || strings.EqualFold(strings.TrimSpace(text(row["thread_source"])), "subagent") || strings.TrimSpace(text(row["parent_thread_id"])) != "" {
		return true
	}
	var source map[string]any
	if json.Unmarshal([]byte(text(row["source"])), &source) == nil {
		value, present := source["subagent"]
		return present && value != nil
	}
	return false
}

// State basenames use an ASCII grammar. For equal case-insensitive names,
// preserve localeCompare's lowercase-before-uppercase source preference.
func sourceLess(left, right string) bool {
	a, b := strings.ToLower(left), strings.ToLower(right)
	if a != b {
		return a < b
	}
	for i := 0; i < len(left) && i < len(right); i++ {
		if left[i] != right[i] {
			return left[i] > right[i]
		}
	}
	return len(left) < len(right)
}

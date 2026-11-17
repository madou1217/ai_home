package codexstatepage

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"math"
	"math/big"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/jsondocument"
)

const MaxResponseInput = 256 << 10
const maxResponseOutput = (32 << 20) - 1

var errResponseInput = errors.New("codex_state_response_input_invalid")
var responseDecimal = regexp.MustCompile(`^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$`)

type responseError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}
type threadListEnvelope struct {
	ID     json.RawMessage `json:"id"`
	Result *threadListPage `json:"result,omitempty"`
	Error  *responseError  `json:"error,omitempty"`
}
type threadListPage struct {
	Data            []listThread `json:"data"`
	NextCursor      *string      `json:"nextCursor"`
	BackwardsCursor *string      `json:"backwardsCursor"`
}
type listThread struct {
	ID            string            `json:"id"`
	SessionID     string            `json:"sessionId"`
	ForkedFromID  *string           `json:"forkedFromId"`
	Title         string            `json:"title"`
	Preview       string            `json:"preview"`
	Ephemeral     bool              `json:"ephemeral"`
	ModelProvider string            `json:"modelProvider"`
	CreatedAt     float64           `json:"createdAt"`
	UpdatedAt     float64           `json:"updatedAt"`
	Status        map[string]string `json:"status"`
	Path          *string           `json:"path"`
	Cwd           string            `json:"cwd"`
	CLIVersion    string            `json:"cliVersion"`
	Source        any               `json:"source"`
	ThreadSource  *string           `json:"threadSource"`
	AgentNickname any               `json:"agentNickname"`
	AgentRole     any               `json:"agentRole"`
	GitInfo       *listGitInfo      `json:"gitInfo"`
	Name          *string           `json:"name"`
	Turns         []any             `json:"turns"`
}
type listGitInfo struct {
	SHA       any `json:"sha"`
	Branch    any `json:"branch"`
	OriginURL any `json:"originUrl"`
}

// CompileThreadListResponse handles only the already-selected AIH continuation.
// It owns public cursor validation, row projection and the complete response.
// ReadPage remains the existing read-only database owner; no history is repaired.
func CompileThreadListResponse(ctx context.Context, raw []byte) ([]byte, error) {
	if len(raw) > MaxResponseInput {
		return nil, errResponseInput
	}
	obj, err := jsondocument.Object(raw)
	if err != nil || len(obj) != 5 || obj["version"] != json.Number("1") {
		return nil, errResponseInput
	}
	home, ok := obj["codexHome"].(string)
	params, okParams := obj["params"].(map[string]any)
	options, okOptions := obj["options"].(map[string]any)
	id, hasID := obj["id"]
	if !ok || !okParams || !okOptions || !hasID || len(options) != 1 {
		return nil, errResponseInput
	}
	titleBudget, ok := options["TitleMaxBytes"].(json.Number)
	if !ok {
		return nil, errResponseInput
	}
	budget, err := titleBudget.Int64()
	if err != nil || len(home) > 32768 || strings.ContainsRune(home, 0) {
		return nil, errResponseInput
	}
	idRaw, err := json.Marshal(id)
	if err != nil {
		return nil, errResponseInput
	}
	envelope := threadListEnvelope{ID: idRaw}
	finish := func() ([]byte, error) {
		if ctx.Err() != nil {
			return nil, errors.New("codex_state_response_cancelled")
		}
		out, err := marshalWire(envelope)
		if err != nil {
			return nil, errResponseInput
		}
		if len(out) > maxResponseOutput {
			envelope.Result = nil
			envelope.Error = &responseError{-32000, "codex_state_read_budget_exceeded"}
			return marshalWire(envelope)
		}
		return out, nil
	}
	fail := func(code int, message string) ([]byte, error) {
		envelope.Error = &responseError{code, message}
		return finish()
	}
	p := responseParams(params)
	if !strings.HasPrefix(p.Cursor, cursorPrefix) {
		return nil, errResponseInput
	}
	envelope.Result = &threadListPage{Data: []listThread{}}
	// Preserve the original empty-scope guard before cursor/budget/database I/O.
	if p.Cwd == "" && !p.AllProjects {
		return finish()
	}
	if !publicCursorValid(p) {
		envelope.Result = nil
		return fail(-32602, "codex_state_cursor_invalid")
	}
	home = responseTrim(home)
	if home == "" {
		return finish()
	}
	page, err := ReadPage(ctx, home, p, ReadOptions{TitleMaxBytes: budget})
	if err != nil {
		envelope.Result = nil
		message := "codex_state_read_unavailable"
		for _, code := range []string{"codex_state_cursor_invalid", "codex_state_read_budget_exceeded", "codex_state_schema_unavailable", "codex_state_home_invalid"} {
			if strings.Contains(err.Error(), code) {
				message = code
				break
			}
		}
		return fail(-32000, message)
	}
	for _, row := range page.Rows {
		thread, err := projectListThread(row)
		if err != nil {
			envelope.Result = nil
			return fail(-32000, "codex_state_read_unavailable")
		}
		envelope.Result.Data = append(envelope.Result.Data, thread)
	}
	envelope.Result.NextCursor = page.NextCursor
	return finish()
}

func responseParams(raw map[string]any) Params {
	p := Params{}
	p.Cwd, _ = raw["cwd"].(string)
	p.Cwd = responseTrim(p.Cwd)
	if !filepath.IsAbs(p.Cwd) {
		p.Cwd = ""
	}
	p.AllProjects, _ = raw["allProjects"].(bool)
	p.Archived, _ = raw["archived"].(bool)
	p.Cursor = responseString(or(raw["cursor"], ""))
	p.SortKey = normalizeSort(responseTrim(responseString(or(raw["sortKey"], ""))))
	if items, ok := raw["modelProviders"].([]any); ok {
		for _, item := range items {
			if s := responseTrim(responseString(or(item, ""))); s != "" {
				p.ModelProviders = append(p.ModelProviders, s)
			}
		}
	}
	if items, ok := raw["sourceKinds"].([]any); ok {
		seen := map[string]bool{}
		for _, item := range items {
			if s, ok := item.(string); ok {
				s = strings.ToLower(responseTrim(s))
				if s != "" && !seen[s] {
					p.SourceKinds = append(p.SourceKinds, s)
					seen[s] = true
				}
			}
		}
	}
	if len(p.SourceKinds) == 0 {
		p.SourceKinds = []string{"cli", "vscode"}
	}
	limit := responseNumber(raw["limit"])
	p.Limit = 50
	if !math.IsInf(limit, 0) && !math.IsNaN(limit) && limit > 0 {
		limit = math.Floor(limit)
		if limit > maxPage {
			p.Limit = maxPage + 1
		} else {
			p.Limit = max(1, int(limit))
		}
	}
	return p
}

// The public Node validator precedes the native typed cursor decoder. Preserve
// that distinction: public-invalid => -32602, native rejection => -32000.
func publicCursorValid(p Params) bool {
	encoded := strings.TrimPrefix(responseTrim(p.Cursor), cursorPrefix)
	var alphabet strings.Builder
	for _, r := range encoded {
		if r == '=' {
			break
		}
		if r >= 'A' && r <= 'Z' || r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '+' || r == '/' || r == '-' || r == '_' {
			alphabet.WriteRune(r)
		}
	}
	encoded = strings.NewReplacer("+", "-", "/", "_").Replace(alphabet.String())
	// Buffer.from discards a final unpaired sextet instead of rejecting all
	// preceding complete bytes. The native typed decoder still owns rejection.
	if len(encoded)%4 == 1 {
		encoded = encoded[:len(encoded)-1]
	}
	data, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		return false
	}
	var cursor map[string]any
	decoder := json.NewDecoder(strings.NewReader(strings.ToValidUTF8(string(data), "\ufffd")))
	decoder.UseNumber()
	if decoder.Decode(&cursor) != nil || cursor == nil {
		return false
	}
	// JSON.parse rejects trailing non-whitespace; duplicate keys remain legacy
	// last-wins here, unlike the strict private operation's outer DTO.
	var trailing any
	if decoder.Decode(&trailing) != io.EOF {
		return false
	}
	version, versionOK := cursor["v"].(json.Number)
	v, err := version.Float64()
	rawValue, valuePresent := cursor["value"]
	value := responseNumber(rawValue)
	filters, filtersOK := cursor["filters"].(string)
	return valuePresent && versionOK && err == nil && v == 1 && responseTrim(responseString(or(cursor["id"], ""))) != "" && !math.IsNaN(value) && !math.IsInf(value, 0) && normalizeSort(responseTrim(responseString(or(cursor["sortKey"], "")))) == p.SortKey && filtersOK && filters == signature(p)
}

func projectListThread(row Row) (listThread, error) {
	created, err := responseSeconds(or(row["created_at_ms"], row["created_at"]))
	if err != nil {
		return listThread{}, err
	}
	updated, err := responseSeconds(or(row["updated_at_ms"], row["updated_at"]))
	if err != nil {
		return listThread{}, err
	}
	if updated == 0 {
		updated = created
	}
	title := responseTrim(responseString(or(row["title"], or(row["first_user_message"], ""))))
	sourceText := responseTrim(responseString(or(row["source"], "")))
	var source any = sourceText
	switch sourceText {
	case "cli", "vscode", "exec", "appServer":
	case "":
		source = "unknown"
	default:
		source = map[string]string{"custom": sourceText}
	}
	id := responseString(or(row["id"], ""))
	thread := listThread{ID: id, SessionID: id, Title: title, Preview: responseString(or(row["first_user_message"], or(row["title"], ""))), ModelProvider: responseTrim(responseString(or(row["model_provider"], ""))), CreatedAt: created, UpdatedAt: updated, Status: map[string]string{"type": "notLoaded"}, Cwd: responseString(or(row["cwd"], "")), CLIVersion: responseString(or(row["cli_version"], "")), Source: source, AgentNickname: or(row["agent_nickname"], nil), AgentRole: or(row["agent_role"], nil), Turns: []any{}}
	if truth(row["rollout_path"]) {
		path := responseString(row["rollout_path"])
		thread.Path = &path
	}
	if title != "" {
		thread.Name = &title
	}
	if truth(row["git_sha"]) || truth(row["git_branch"]) || truth(row["git_origin_url"]) {
		thread.GitInfo = &listGitInfo{or(row["git_sha"], nil), or(row["git_branch"], nil), or(row["git_origin_url"], nil)}
	}
	return thread, nil
}

func truth(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case string:
		return x != ""
	case bool:
		return x
	case json.Number:
		n, _ := x.Float64()
		return n != 0 && !math.IsNaN(n)
	case int64:
		return x != 0
	case float64:
		return x != 0 && !math.IsNaN(x)
	default:
		return true
	}
}
func or(value, fallback any) any {
	if truth(value) {
		return value
	}
	return fallback
}
func responseTrim(value string) string {
	return strings.TrimFunc(value, func(r rune) bool {
		return r >= 0x09 && r <= 0x0d || r == 0x20 || r == 0xa0 || r == 0x1680 || r >= 0x2000 && r <= 0x200a || r == 0x2028 || r == 0x2029 || r == 0x202f || r == 0x205f || r == 0x3000 || r == 0xfeff
	})
}
func responseString(v any) string {
	switch x := v.(type) {
	case nil:
		return "null"
	case string:
		return x
	case bool:
		return strconv.FormatBool(x)
	case json.Number:
		return string(x)
	case int64:
		return strconv.FormatInt(x, 10)
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	case []any:
		parts := make([]string, len(x))
		for i, item := range x {
			if item != nil {
				parts[i] = responseString(item)
			}
		}
		return strings.Join(parts, ",")
	default:
		return "[object Object]"
	}
}
func responseNumber(v any) float64 {
	if v == nil {
		return 0
	}
	if x, ok := v.(bool); ok {
		if x {
			return 1
		}
		return 0
	}
	s := responseTrim(responseString(v))
	if s == "" {
		return 0
	}
	if len(s) > 2 && s[0] == '0' && strings.ContainsAny(s[1:2], "xXbBoO") {
		base := 16
		if s[1] == 'b' || s[1] == 'B' {
			base = 2
		}
		if s[1] == 'o' || s[1] == 'O' {
			base = 8
		}
		for _, c := range s[2:] {
			if !(c >= '0' && c <= '9' || base == 16 && (c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F')) {
				return math.NaN()
			}
		}
		if n, ok := new(big.Int).SetString(s[2:], base); ok {
			value, _ := new(big.Float).SetInt(n).Float64()
			return value
		}
		return math.NaN()
	}
	if s == "Infinity" || s == "+Infinity" {
		return math.Inf(1)
	}
	if s == "-Infinity" {
		return math.Inf(-1)
	}
	if !responseDecimal.MatchString(s) {
		return math.NaN()
	}
	n, _ := strconv.ParseFloat(s, 64)
	return n
}

func responseSeconds(v any) (float64, error) {
	// SQL timestamp affinity may yield time.Time; the old page JSON encoder
	// exposes it as RFC3339Nano before Node projects the field.
	if value, ok := v.(time.Time); ok {
		v = value.Format(time.RFC3339Nano)
	}
	if v == nil || v == "" {
		return 0, nil
	}
	n := responseNumber(v)
	if !math.IsInf(n, 0) && !math.IsNaN(n) {
		if n > 100000000000 {
			n /= 1000
		}
		return math.Floor(n), nil
	}
	s, ok := v.(string)
	if !ok {
		return 0, errors.New("codex_state_timestamp_nonfinite")
	}
	// Vendor timestamp columns are numeric. Preserve standard persisted ISO
	// dates too; an unrecognised textual date fails observably, not a false 0.
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02T15:04:05.999999999", "2006-01-02 15:04:05.999999999", "2006-01-02", time.RFC1123Z} {
		location := time.Local
		if layout == "2006-01-02" {
			location = time.UTC
		}
		if parsed, err := time.ParseInLocation(layout, s, location); err == nil {
			return math.Floor(float64(parsed.UnixMilli()) / 1000), nil
		}
	}
	return 0, errors.New("codex_state_timestamp_text_unsupported")
}

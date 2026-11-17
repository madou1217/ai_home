package codexstatepage

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"path/filepath"
	"runtime"
	"sort"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/jsondocument"
)

// Whole upstream responses need a separate admission budget from the small
// continuation DTO. Both encoded input and output (including LF) are bounded.
const MaxVisibilityInput = 32 << 20

var errVisibilityInput = errors.New("codex_state_visibility_input_invalid")

type visibilityField struct {
	key    string
	keyRaw json.RawMessage
	raw    json.RawMessage
}
type visibilityObject []visibilityField

// Only the two edited object levels are decoded in order. Opaque nested values
// remain the canonical JSON bytes supplied by the Node framing adapter. This is
// not a second generic JSON codec or an owner of upstream metadata semantics.
func visibilityFields(raw []byte) (visibilityObject, error) {
	d := json.NewDecoder(bytes.NewReader(raw))
	start, err := d.Token()
	if err != nil || start != json.Delim('{') {
		return nil, errVisibilityInput
	}
	out := visibilityObject{}
	for d.More() {
		start := d.InputOffset()
		token, err := d.Token()
		key, ok := token.(string)
		if err != nil || !ok {
			return nil, errVisibilityInput
		}
		keyEnd := d.InputOffset()
		keyStart := int(start) + bytes.IndexByte(raw[start:keyEnd], '"')
		if keyStart < int(start) {
			return nil, errVisibilityInput
		}
		var value json.RawMessage
		if d.Decode(&value) != nil {
			return nil, errVisibilityInput
		}
		out = append(out, visibilityField{key: key, keyRaw: raw[keyStart:keyEnd], raw: value})
	}
	end, err := d.Token()
	var extra any
	if err != nil || end != json.Delim('}') || d.Decode(&extra) != io.EOF {
		return nil, errVisibilityInput
	}
	return out, nil
}
func (o visibilityObject) get(key string) json.RawMessage {
	for _, field := range o {
		if field.key == key {
			return field.raw
		}
	}
	return nil
}
func (o *visibilityObject) set(key string, raw json.RawMessage) {
	for i := range *o {
		if (*o)[i].key == key {
			(*o)[i].raw = raw
			return
		}
	}
	*o = append(*o, visibilityField{key: key, raw: raw})
}
func (o visibilityObject) bytes() []byte {
	out := []byte{'{'}
	for i, field := range o {
		if i > 0 {
			out = append(out, ',')
		}
		key := field.keyRaw
		if key == nil {
			key, _ = marshalWire(field.key)
		}
		out = append(out, key...)
		out = append(out, ':')
		out = append(out, field.raw...)
	}
	return append(out, '}')
}

type visibilityItem struct {
	raw   json.RawMessage
	value map[string]any
}

func visibilityItems(raw []byte) []visibilityItem {
	var rows []json.RawMessage
	if json.Unmarshal(raw, &rows) != nil {
		return []visibilityItem{}
	}
	items := make([]visibilityItem, 0, len(rows))
	for _, row := range rows {
		var value map[string]any
		d := json.NewDecoder(bytes.NewReader(row))
		d.UseNumber()
		_ = d.Decode(&value)
		items = append(items, visibilityItem{row, value})
	}
	return items
}
func visibilityData(items []visibilityItem) []byte {
	out := []byte{'['}
	for i, item := range items {
		if i > 0 {
			out = append(out, ',')
		}
		out = append(out, item.raw...)
	}
	return append(out, ']')
}
func visibilityID(item visibilityItem) string {
	v := item.value
	return responseTrim(responseString(or(v["id"], or(v["sessionId"], or(v["threadId"], "")))))
}
func visibilitySubagent(item visibilityItem, hidden map[string]bool) bool {
	v := item.value
	id := responseTrim(responseString(or(v["id"], or(v["threadId"], ""))))
	if id != "" && hidden[id] {
		return true
	}
	kind := strings.ToLower(responseTrim(responseString(or(v["thread_source"], or(v["threadSource"], "")))))
	if kind == "subagent" || responseTrim(responseString(or(v["parent_thread_id"], or(v["parentThreadId"], "")))) != "" {
		return true
	}
	source, ok := v["source"].(map[string]any)
	if !ok {
		s := responseTrim(responseString(or(v["source"], "")))
		if strings.HasPrefix(s, "{") {
			d := json.NewDecoder(strings.NewReader(s))
			d.UseNumber()
			var extra any
			if d.Decode(&source) != nil || d.Decode(&extra) != io.EOF {
				source = nil
			}
		}
	}
	return source != nil && source["subagent"] != nil
}

// Node's Windows isAbsolute accepts a current-drive rooted path. Keep that
// scope for native-cursor visibility; the existing page reader owns its own
// stricter admission. Do not silently turn a rooted project into an empty page.
func visibilityScopeCwd(value any) string {
	cwd, ok := value.(string)
	if !ok {
		return ""
	}
	cwd = responseTrim(cwd)
	if filepath.IsAbs(cwd) || runtime.GOOS == "windows" && strings.HasPrefix(strings.ReplaceAll(cwd, `\`, "/"), "/") {
		return cwd
	}
	return ""
}
func visibilityMatchCwd(project, cwd string) bool {
	normalize := func(value string) string {
		value = responseTrim(value)
		if runtime.GOOS == "windows" && !filepath.IsAbs(value) && strings.HasPrefix(strings.ReplaceAll(value, `\`, "/"), "/") {
			if full, err := filepath.Abs(value); err == nil {
				value = full
			}
		}
		if !filepath.IsAbs(value) {
			return ""
		}
		value = filepath.Clean(value)
		if full, err := filepath.EvalSymlinks(value); err == nil {
			value = full
		}
		if runtime.GOOS == "windows" {
			value = strings.ToLower(value)
		}
		return value
	}
	// Use JS trim, not Go TrimSpace: U+0085 is a valid path character, not a
	// JS whitespace boundary. The rest is the existing project-scope policy.
	current := normalize(cwd)
	return current != "" && normalize(project) == current
}

func visibilityTimestamp(item visibilityItem, key string) float64 {
	v := item.value
	output := func(raw any) float64 {
		n := responseNumber(raw)
		if math.IsNaN(n) || n == 0 {
			return 0
		}
		if n > 0 && n < 100000000000 {
			return n * 1000
		}
		return n
	}
	one := func(prefix, camel string) float64 {
		if n := responseNumber(v[prefix+"_ms"]); n != 0 && !math.IsNaN(n) {
			return n
		}
		if n := responseNumber(v[prefix]); n != 0 && !math.IsNaN(n) {
			return n * 1000
		}
		return output(v[camel])
	}
	updated, created := one("updated_at", "updatedAt"), one("created_at", "createdAt")
	if key == "created_at" {
		return created
	}
	if key == "recency_at" {
		return math.Max(updated, created)
	}
	return updated
}
func visibilitySortID(item visibilityItem) string {
	return responseString(or(item.value["id"], ""))
}
func visibilityUUID(id string) bool {
	if len(id) != 36 {
		return false
	}
	for i, c := range id {
		if i == 8 || i == 13 || i == 18 || i == 23 {
			if c != '-' {
				return false
			}
		} else if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

// CompileThreadListVisibility owns the existing enabled caller's visibility
// response decision. It returns either unchanged (the caller keeps its exact
// original line) or the complete replacement wire line, including opaque data.
func CompileThreadListVisibility(ctx context.Context, raw []byte) ([]byte, error) {
	if len(raw) > MaxVisibilityInput {
		return nil, errVisibilityInput
	}
	request, err := jsondocument.Object(raw)
	if err != nil || len(request) != 5 || request["version"] != json.Number("1") {
		return nil, errVisibilityInput
	}
	home, homeOK := request["codexHome"].(string)
	line, lineOK := request["line"].(string)
	context, contextOK := request["context"].(map[string]any)
	options, optionsOK := request["options"].(map[string]any)
	if !homeOK || !lineOK || !contextOK || !optionsOK || len(options) != 1 || len(home) > 32768 || strings.ContainsRune(home, 0) {
		return nil, errVisibilityInput
	}
	titleBudget, ok := options["TitleMaxBytes"].(json.Number)
	if !ok {
		return nil, errVisibilityInput
	}
	budget, err := titleBudget.Int64()
	if err != nil {
		return nil, errVisibilityInput
	}
	parsed, err := visibilityFields([]byte(line))
	if err != nil {
		return nil, errVisibilityInput
	}
	result, err := visibilityFields(parsed.get("result"))
	if err != nil {
		return nil, errVisibilityInput
	}
	unchanged := func() ([]byte, error) {
		if ctx.Err() != nil {
			return nil, errors.New("codex_state_visibility_cancelled")
		}
		return []byte(`{"unchanged":true}`), nil
	}
	fail := func(code string) ([]byte, error) {
		// Preserve the public wrapper's own-id error convention, not a new ID.
		id := parsed.get("id")
		if id == nil {
			return unchanged()
		}
		errorRaw, _ := marshalWire(responseError{-32000, code})
		envelope := visibilityObject{{key: "id", raw: id}, {key: "error", raw: errorRaw}}
		out, err := marshalWire(struct {
			Unchanged bool   `json:"unchanged"`
			Line      string `json:"line"`
		}{false, string(envelope.bytes())})
		if len(out) >= MaxVisibilityInput {
			return nil, ErrBudget
		}
		return out, err
	}
	finish := func() ([]byte, error) {
		if ctx.Err() != nil {
			return nil, errors.New("codex_state_visibility_cancelled")
		}
		parsed.set("result", result.bytes())
		out, err := marshalWire(struct {
			Unchanged bool   `json:"unchanged"`
			Line      string `json:"line"`
		}{false, string(parsed.bytes())})
		if len(out) >= MaxVisibilityInput {
			return fail("codex_state_read_budget_exceeded")
		}
		return out, err
	}
	p := responseParams(context)
	p.Cwd = visibilityScopeCwd(context["cwd"])
	if p.Cwd == "" && !p.AllProjects {
		result.set("data", []byte("[]"))
		result.set("nextCursor", []byte("null"))
		result.set("backwardsCursor", []byte("null"))
		return finish()
	}
	home = responseTrim(home)
	hidden := map[string]bool{}
	if home != "" {
		ids, err := ReadHidden(ctx, home)
		if err != nil {
			return fail(visibilityReadCode(err))
		}
		for _, id := range ids {
			hidden[id] = true
		}
	}
	original := visibilityItems(result.get("data"))
	upstream := make([]visibilityItem, 0, len(original))
	for _, item := range original {
		if ctx.Err() != nil {
			return nil, errors.New("codex_state_visibility_cancelled")
		}
		cwd := responseString(or(item.value["cwd"], ""))
		if !hidden[visibilityID(item)] && !visibilitySubagent(item, hidden) && (p.Cwd == "" && p.AllProjects || p.Cwd != "" && visibilityMatchCwd(cwd, p.Cwd)) {
			upstream = append(upstream, item)
		}
	}
	filtered := len(upstream) != len(original)
	filteredOnly := func() ([]byte, error) {
		if !filtered {
			return unchanged()
		}
		result.set("data", visibilityData(upstream))
		return finish()
	}
	// Any truthy original cursor belongs to upstream here. AIH continuation is
	// consumed before forwarding, and must not change this branch's ordering.
	if truth(context["cursor"]) {
		return filteredOnly()
	}
	limit := 50.0
	if n := responseNumber(context["limit"]); !math.IsNaN(n) && !math.IsInf(n, 0) && n > 0 {
		limit = math.Floor(n)
	}
	stateLimit := math.Max(1, limit+float64(len(upstream)))
	if home != "" && stateLimit > maxPage {
		return fail("codex_state_read_budget_exceeded")
	}
	page := &Page{Rows: []Row{}}
	if home != "" {
		readParams := p
		readParams.Limit = int(stateLimit)
		readParams.Cursor = ""
		// The existing page transport stringifies source values, whereas the
		// public cursor signature keeps only string source kinds. Keep these
		// two established contracts separate instead of broadening a query.
		readParams.SourceKinds = nil
		if items, ok := context["sourceKinds"].([]any); ok {
			for _, item := range items {
				if value := responseTrim(responseString(or(item, ""))); value != "" {
					readParams.SourceKinds = append(readParams.SourceKinds, value)
				}
			}
		}
		page, err = ReadPage(ctx, home, readParams, ReadOptions{TitleMaxBytes: budget})
		if err != nil {
			return fail(visibilityReadCode(err))
		}
	}
	if len(page.Rows) == 0 {
		return filteredOnly()
	}
	merged := append([]visibilityItem{}, upstream...)
	seen := map[string]bool{}
	for _, item := range upstream {
		if id := visibilitySortID(item); id != "" {
			seen[id] = true
		}
	}
	for _, row := range page.Rows {
		thread, err := projectListThread(row)
		if err != nil {
			return fail("codex_state_read_unavailable")
		}
		if thread.ID != "" && seen[thread.ID] {
			continue
		}
		seen[thread.ID] = true
		wire, err := marshalWire(thread)
		if err != nil {
			return fail("codex_state_read_unavailable")
		}
		merged = append(merged, visibilityItems(append(append([]byte{'['}, wire...), ']'))...)
	}
	// localeCompare is only byte-equivalent for canonical lowercase UUIDs.
	// Do not silently invent a different ordering for arbitrary upstream IDs.
	groups := map[float64]string{}
	for _, item := range merged {
		value, id := visibilityTimestamp(item, p.SortKey), visibilitySortID(item)
		if math.IsNaN(value) || math.IsInf(value, 0) {
			return fail("codex_state_timestamp_nonfinite")
		}
		if previous, found := groups[value]; found && previous != id && (!visibilityUUID(previous) || !visibilityUUID(id)) {
			return fail("codex_state_sort_identity_unsupported")
		}
		groups[value] = id
	}
	sort.SliceStable(merged, func(i, j int) bool {
		a, b := visibilityTimestamp(merged[i], p.SortKey), visibilityTimestamp(merged[j], p.SortKey)
		if a != b {
			return a > b
		}
		return visibilitySortID(merged[i]) > visibilitySortID(merged[j])
	})
	capCount := int(math.Max(1, limit))
	if capCount > len(merged) {
		capCount = len(merged)
	}
	capped := merged[:capCount]
	next := result.get("nextCursor")
	var oldNext any
	_ = json.Unmarshal(next, &oldNext)
	if !truth(oldNext) {
		next = []byte("null")
	}
	if (page.HasMore || len(merged) > len(capped)) && len(capped) > 0 {
		last := capped[len(capped)-1]
		cursor := encodeCursor(p, visibilitySortID(last), visibilityTimestamp(last, p.SortKey))
		next, _ = marshalWire(cursor)
	}
	same := !filtered && len(capped) == len(upstream) && bytes.Equal(next, result.get("nextCursor"))
	// JS treats an absent/false nextCursor as null for this comparison.
	if !truth(oldNext) {
		same = !filtered && len(capped) == len(upstream) && bytes.Equal(next, []byte("null"))
	}
	if same {
		for i := range capped {
			if visibilityID(capped[i]) != visibilityID(upstream[i]) {
				same = false
				break
			}
		}
	}
	if same {
		return unchanged()
	}
	result.set("data", visibilityData(capped))
	result.set("nextCursor", next)
	return finish()
}
func visibilityReadCode(err error) string {
	for _, code := range []string{"codex_state_cursor_invalid", "codex_state_read_budget_exceeded", "codex_state_schema_unavailable", "codex_state_home_invalid"} {
		if strings.Contains(err.Error(), code) {
			return code
		}
	}
	return "codex_state_read_unavailable"
}

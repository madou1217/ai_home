package codexstatepage

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/jsondocument"
)

const MaxTitleResponseInput = 32 << 20

var errTitleResponseInput = errors.New("codex_title_response_input_invalid")

// titleResponseValue is used only for the established title/id coercions.
// Opaque values are edited through ordered RawMessage fields, never this map.
func titleResponseValue(raw []byte) any {
	var value any
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	_ = d.Decode(&value)
	return value
}
func titleResponseExisting(item visibilityItem) string {
	v := item.value
	return responseTrim(responseString(or(v["title"], or(v["name"], or(v["preview"], or(v["first_user_message"], ""))))))
}
func titleResponseObject(raw []byte) (visibilityItem, bool) {
	value, ok := titleResponseValue(raw).(map[string]any)
	return visibilityItem{raw: raw, value: value}, ok && value != nil
}

// encoding/json replaces lone surrogate escapes when decoding a string. For
// fields whose contents affect the decoration, reject that lossy conversion
// as an unavailable optional operation; opaque unrelated fields stay raw.
func titleResponseCoercionsLossless(item visibilityItem) bool {
	if item.value == nil {
		return true
	}
	fields, err := visibilityFields(item.raw)
	if err != nil {
		return false
	}
	for _, key := range []string{"id", "sessionId", "threadId", "title", "name", "preview", "first_user_message"} {
		if raw := fields.get(key); raw != nil {
			wrapped := append(append([]byte(`{"value":`), raw...), '}')
			if _, err := jsondocument.Object(wrapped); err != nil {
				return false
			}
		}
	}
	return true
}

// CompileTitleResponse owns optional title decoration of an already-received
// enabled response. ReadTitles remains the sole vendor read-only title owner;
// its absence/error must not suppress patches based on existing wire fields.
func CompileTitleResponse(ctx context.Context, raw []byte) ([]byte, error) {
	if len(raw) > MaxTitleResponseInput {
		return nil, errTitleResponseInput
	}
	request, err := jsondocument.Object(raw)
	if err != nil || len(request) != 3 || request["version"] != json.Number("1") {
		return nil, errTitleResponseInput
	}
	home, homeOK := request["codexHome"].(string)
	line, lineOK := request["line"].(string)
	if !homeOK || !lineOK || len(home) > 32768 || strings.ContainsRune(home, 0) {
		return nil, errTitleResponseInput
	}
	parsed, err := visibilityFields([]byte(line))
	if err != nil {
		return nil, errTitleResponseInput
	}
	unchanged := func() ([]byte, error) {
		if ctx.Err() != nil {
			return nil, errors.New("codex_title_response_cancelled")
		}
		return []byte(`{"unchanged":true}`), nil
	}
	if truth(titleResponseValue(parsed.get("error"))) {
		return unchanged()
	}
	result, err := visibilityFields(parsed.get("result"))
	if err != nil {
		return unchanged()
	}
	data := visibilityItems(result.get("data"))
	thread, hasThread := titleResponseObject(result.get("thread"))
	candidates := append([]visibilityItem{}, data...)
	if hasThread {
		candidates = append(candidates, thread)
	}
	for _, item := range candidates {
		if !titleResponseCoercionsLossless(item) {
			return nil, errTitleResponseInput
		}
	}
	missing := []string{}
	seen := map[string]bool{}
	for _, item := range candidates {
		if ctx.Err() != nil {
			return nil, errors.New("codex_title_response_cancelled")
		}
		if item.value == nil || titleResponseExisting(item) != "" {
			continue
		}
		id := visibilityID(item)
		if id != "" && !seen[id] {
			missing = append(missing, id)
			seen[id] = true
		}
	}
	titles := map[string]string{}
	home = responseTrim(home)
	if len(missing) > 0 && len(missing) <= maxMetadataIDs && home != "" {
		// Legacy optional metadata has a 256 KiB transport budget independent
		// of the response frame admission. Too many/large IDs simply provide
		// no metadata; existing title/name/preview fields still take priority.
		query, _ := marshalWire(struct {
			Operation string   `json:"operation"`
			Home      string   `json:"codexHome"`
			IDs       []string `json:"threadIds"`
		}{"titles", home, missing})
		if len(query) <= 256<<10 {
			if snapshot, err := ReadTitles(ctx, home, missing); err == nil {
				titles = snapshot
			}
		}
	}
	patch := func(item visibilityItem) (visibilityItem, bool, error) {
		if item.value == nil {
			return item, false, nil
		}
		title := titleResponseExisting(item)
		if title == "" {
			title = titles[visibilityID(item)]
		}
		if title == "" {
			return item, false, nil
		}
		object, err := visibilityFields(item.raw)
		if err != nil {
			return item, false, errTitleResponseInput
		}
		rawTitle, err := marshalWire(title)
		if err != nil {
			return item, false, errTitleResponseInput
		}
		changed := false
		for _, key := range []string{"title", "name", "preview"} {
			if responseTrim(responseString(or(item.value[key], ""))) == "" {
				object.set(key, rawTitle)
				changed = true
			}
		}
		if changed {
			item.raw = object.bytes()
		}
		return item, changed, nil
	}
	changed := false
	for i, item := range data {
		if ctx.Err() != nil {
			return nil, errors.New("codex_title_response_cancelled")
		}
		next, updated, err := patch(item)
		if err != nil {
			return nil, err
		}
		data[i] = next
		changed = changed || updated
	}
	if changed {
		result.set("data", visibilityData(data))
	}
	if hasThread {
		next, updated, err := patch(thread)
		if err != nil {
			return nil, err
		}
		if updated {
			result.set("thread", next.raw)
			changed = true
		}
	}
	if !changed {
		return unchanged()
	}
	if ctx.Err() != nil {
		return nil, errors.New("codex_title_response_cancelled")
	}
	parsed.set("result", result.bytes())
	out, err := marshalWire(struct {
		Unchanged bool   `json:"unchanged"`
		Line      string `json:"line"`
	}{false, string(parsed.bytes())})
	if len(out) >= MaxTitleResponseInput {
		return nil, ErrBudget
	}
	return out, err
}

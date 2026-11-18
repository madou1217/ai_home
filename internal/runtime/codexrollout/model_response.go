package codexrollout

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"strconv"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/jsondocument"
)

const MaxModelResponseInput = 32 << 20

var errModelResponseInput = errors.New("codex_model_response_input_invalid")

// Ordered fields retain opaque canonical wire values and their original key
// spellings. Only result.thread.turns[*].model is changed by this operation.
type modelResponseField struct {
	key    string
	keyRaw json.RawMessage
	raw    json.RawMessage
}
type modelResponseObject []modelResponseField

func modelResponseFields(raw []byte) (modelResponseObject, error) {
	d := json.NewDecoder(bytes.NewReader(raw))
	start, err := d.Token()
	if err != nil || start != json.Delim('{') {
		return nil, errModelResponseInput
	}
	out := modelResponseObject{}
	for d.More() {
		start := d.InputOffset()
		token, err := d.Token()
		key, ok := token.(string)
		if err != nil || !ok {
			return nil, errModelResponseInput
		}
		end := d.InputOffset()
		keyStart := int(start) + bytes.IndexByte(raw[start:end], '"')
		if keyStart < int(start) {
			return nil, errModelResponseInput
		}
		var value json.RawMessage
		if d.Decode(&value) != nil {
			return nil, errModelResponseInput
		}
		out = append(out, modelResponseField{key, raw[keyStart:end], value})
	}
	end, err := d.Token()
	var extra any
	if err != nil || end != json.Delim('}') || d.Decode(&extra) != io.EOF {
		return nil, errModelResponseInput
	}
	return out, nil
}
func (o modelResponseObject) get(key string) json.RawMessage {
	for _, f := range o {
		if f.key == key {
			return f.raw
		}
	}
	return nil
}
func (o *modelResponseObject) set(key string, raw json.RawMessage) {
	for i := range *o {
		if (*o)[i].key == key {
			(*o)[i].raw = raw
			return
		}
	}
	*o = append(*o, modelResponseField{key: key, raw: raw})
}
func (o modelResponseObject) bytes() []byte {
	out := []byte{'{'}
	for i, f := range o {
		if i > 0 {
			out = append(out, ',')
		}
		key := f.keyRaw
		if key == nil {
			key, _ = modelResponseJSON(f.key)
		}
		out = append(out, key...)
		out = append(out, ':')
		out = append(out, f.raw...)
	}
	return append(out, '}')
}
func modelResponseJSON(value any) ([]byte, error) {
	var b bytes.Buffer
	e := json.NewEncoder(&b)
	e.SetEscapeHTML(false)
	if err := e.Encode(value); err != nil {
		return nil, err
	}
	raw := bytes.TrimSuffix(b.Bytes(), []byte{'\n'})
	out := make([]byte, 0, len(raw))
	for i := 0; i < len(raw); {
		if raw[i] == '\\' && i+1 < len(raw) {
			if i+6 <= len(raw) && (string(raw[i:i+6]) == `\u2028` || string(raw[i:i+6]) == `\u2029`) {
				last := byte(0xa8)
				if raw[i+5] == '9' {
					last = 0xa9
				}
				out = append(out, 0xe2, 0x80, last)
				i += 6
				continue
			}
			out = append(out, raw[i:i+2]...)
			i += 2
			continue
		}
		out = append(out, raw[i])
		i++
	}
	return out, nil
}
func modelResponseTrim(s string) string {
	return strings.Trim(s, " \t\n\r\v\f\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff")
}

// JSON objects with an own noncallable toString do not have the normal
// JavaScript String conversion. Keep optional metadata unavailable rather than
// successfully matching another identity; opaque unused fields are untouched.
func modelResponseCoercible(value any) bool {
	switch v := value.(type) {
	case map[string]any:
		_, shadows := v["toString"]
		return !shadows
	case []any:
		for _, item := range v {
			if !modelResponseCoercible(item) {
				return false
			}
		}
	}
	return true
}
func modelResponseText(value any) string { return modelResponseTrim(modelResponseString(value)) }

// Array String coercion preserves each element until the final outer trim.
func modelResponseString(value any) string {
	switch v := value.(type) {
	case nil:
		return ""
	case string:
		return v
	case bool:
		return strconv.FormatBool(v)
	case json.Number:
		f, err := strconv.ParseFloat(string(v), 64)
		if err != nil || math.IsInf(f, 0) || math.IsNaN(f) {
			return ""
		}
		if f == 0 {
			return "0"
		}
		if math.Abs(f) >= 1e-6 && math.Abs(f) < 1e21 {
			return strconv.FormatFloat(f, 'f', -1, 64)
		}
		s := strconv.FormatFloat(f, 'e', -1, 64)
		s = strings.ReplaceAll(s, "e-0", "e-")
		return strings.ReplaceAll(s, "e+0", "e+")
	case []any:
		parts := make([]string, len(v))
		for i, item := range v {
			parts[i] = modelResponseString(item)
		}
		return strings.Join(parts, ",")
	default:
		return "[object Object]"
	}
}
func modelResponseValue(raw []byte) any {
	var value any
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	_ = d.Decode(&value)
	return value
}

// CompileModelResponse owns complete turn-model response decoration. ReadModels
// remains the sole read-only rollout scanner; unavailable metadata is an error
// for the optional caller to preserve the exact original upstream frame.
func CompileModelResponse(ctx context.Context, raw []byte) ([]byte, error) {
	if len(raw) > MaxModelResponseInput {
		return nil, ErrReadBudget
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	request, err := jsondocument.Object(raw)
	if err != nil || len(request) != 3 || request["version"] != json.Number("1") {
		return nil, errModelResponseInput
	}
	line, ok := request["line"].(string)
	if !ok {
		return nil, errModelResponseInput
	}
	if len(line)+1 > MaxModelResponseInput {
		return nil, ErrReadBudget
	}
	context, ok := request["context"].(map[string]any)
	if !ok || len(context) > 2 {
		return nil, errModelResponseInput
	}
	for key := range context {
		if key != "threadId" && key != "rolloutPath" {
			return nil, errModelResponseInput
		}
	}
	if !modelResponseCoercible(context["rolloutPath"]) || !modelResponseCoercible(context["threadId"]) {
		return nil, errModelResponseInput
	}
	path := modelResponseText(context["rolloutPath"])
	unchanged := func() ([]byte, error) {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		return []byte(`{"unchanged":true}`), nil
	}
	if path == "" {
		return unchanged()
	}
	if len(path) > 32768 || strings.ContainsRune(path, 0) {
		return nil, errModelResponseInput
	}
	// The adapter supplies JSON.parse/stringify canonical frames. Reject lossy
	// direct inputs instead of changing unrelated opaque fields on a patch.
	if _, err := jsondocument.Object([]byte(line)); err != nil {
		return nil, errModelResponseInput
	}
	response, err := modelResponseFields([]byte(line))
	if err != nil {
		return nil, err
	}
	result, err := modelResponseFields(response.get("result"))
	if err != nil {
		return unchanged()
	}
	thread, err := modelResponseFields(result.get("thread"))
	if err != nil {
		return unchanged()
	}
	if !modelResponseCoercible(modelResponseValue(thread.get("id"))) {
		return nil, errModelResponseInput
	}
	expectedID := modelResponseText(context["threadId"])
	if expectedID != "" && modelResponseText(modelResponseValue(thread.get("id"))) != expectedID {
		return unchanged()
	}
	var turns []json.RawMessage
	turnsRaw := thread.get("turns")
	if len(turnsRaw) == 0 || turnsRaw[0] != '[' || json.Unmarshal(turnsRaw, &turns) != nil {
		return unchanged()
	}
	wanted := []string{}
	seen := map[string]bool{}
	for _, rawTurn := range turns {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		turn, err := modelResponseFields(rawTurn)
		if err != nil {
			continue
		}
		if !modelResponseCoercible(modelResponseValue(turn.get("id"))) {
			return nil, errModelResponseInput
		}
		id := modelResponseText(modelResponseValue(turn.get("id")))
		if id != "" && !seen[id] {
			wanted = append(wanted, id)
			seen[id] = true
		}
	}
	if len(wanted) == 0 {
		return unchanged()
	}
	models, err := ReadModels(ctx, path, wanted)
	if err != nil {
		return nil, err
	}
	changed := false
	for i, rawTurn := range turns {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		turn, err := modelResponseFields(rawTurn)
		if err != nil {
			continue
		}
		value := modelResponseTrim(models[modelResponseText(modelResponseValue(turn.get("id")))])
		if value == "" || strings.EqualFold(value, "<synthetic>") {
			continue
		}
		if current, ok := modelResponseValue(turn.get("model")).(string); ok && current == value {
			continue
		}
		encoded, err := modelResponseJSON(value)
		if err != nil {
			return nil, err
		}
		turn.set("model", encoded)
		turns[i] = turn.bytes()
		changed = true
	}
	if !changed {
		return unchanged()
	}
	outTurns := []byte{'['}
	for i, turn := range turns {
		if i > 0 {
			outTurns = append(outTurns, ',')
		}
		outTurns = append(outTurns, turn...)
	}
	outTurns = append(outTurns, ']')
	thread.set("turns", outTurns)
	result.set("thread", thread.bytes())
	response.set("result", result.bytes())
	lineOut := response.bytes()
	if len(lineOut)+1 > MaxModelResponseInput {
		return nil, ErrReadBudget
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	out, err := modelResponseJSON(struct {
		Unchanged bool   `json:"unchanged"`
		Line      string `json:"line"`
	}{false, string(lineOut)})
	if len(out)+1 > MaxModelResponseInput {
		return nil, ErrReadBudget
	}
	return out, err
}

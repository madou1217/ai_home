package codexstatepage

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strconv"

	"github.com/madou1217/ai_home/internal/runtime/jsondocument"
)

const MaxConfigResponseInput = 32 << 20

var errConfigResponseInput = errors.New("codex_config_response_input_invalid")

// Object spread includes arrays in the existing JS mapper. Their enumerable
// numeric properties become ordered object fields, even for an empty array.
func configResponseObject(raw []byte) (visibilityObject, bool) {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 {
		return nil, false
	}
	if raw[0] == '{' {
		object, err := visibilityFields(raw)
		return object, err == nil
	}
	if raw[0] != '[' {
		return nil, false
	}
	var items []json.RawMessage
	if json.Unmarshal(raw, &items) != nil {
		return nil, false
	}
	object := visibilityObject{}
	for i, item := range items {
		object = append(object, visibilityField{key: strconv.Itoa(i), raw: item})
	}
	return object, true
}

// The context and parsed wire have different JS object identities. Strict
// equality is possible only for primitives, not separately parsed arrays/maps.
func configResponseEqual(left, right []byte) bool {
	if len(left) == 0 || len(right) == 0 {
		return false
	}
	l, r := titleResponseValue(left), titleResponseValue(right)
	switch v := l.(type) {
	case nil:
		return r == nil
	case string:
		x, ok := r.(string)
		return ok && v == x
	case bool:
		x, ok := r.(bool)
		return ok && v == x
	case json.Number:
		x, ok := r.(json.Number)
		if !ok {
			return false
		}
		lf, le := strconv.ParseFloat(string(v), 64)
		rf, re := strconv.ParseFloat(string(x), 64)
		return le == nil && re == nil && lf == rf
	}
	return false
}

// CompileConfigResponse owns all DTO gates and patch decisions. No config/DB
// reads or runtime reconciliation occur here; those remain with the caller.
func CompileConfigResponse(ctx context.Context, raw []byte) ([]byte, error) {
	if len(raw) > MaxConfigResponseInput {
		return nil, ErrBudget
	}
	request, err := jsondocument.Object(raw)
	if err != nil || len(request) != 3 || request["version"] != json.Number("1") {
		return nil, errConfigResponseInput
	}
	if _, exists := request["context"]; !exists {
		return nil, errConfigResponseInput
	}
	line, ok := request["line"].(string)
	if !ok || len(line)+1 > MaxConfigResponseInput {
		return nil, errConfigResponseInput
	}
	unchanged := func() ([]byte, error) {
		if ctx.Err() != nil {
			return nil, errors.New("codex_config_response_cancelled")
		}
		return []byte(`{"unchanged":true}`), nil
	}
	// Scalars have no relevant enumerable context properties. Actual caller
	// contexts are objects, but do not turn null/arrays into invented fields.
	contextValue, ok := request["context"].(map[string]any)
	if !ok || !truth(contextValue["modelProvider"]) && !truth(contextValue["model"]) {
		return unchanged()
	}
	contextFields, err := visibilityFields(raw)
	if err != nil {
		return nil, errConfigResponseInput
	}
	fields, err := visibilityFields(contextFields.get("context"))
	if err != nil {
		return nil, errConfigResponseInput
	}
	parsed, err := visibilityFields([]byte(line))
	if err != nil {
		return unchanged()
	}
	result, ok := configResponseObject(parsed.get("result"))
	if !ok {
		return unchanged()
	}
	// Relevant string equality must not silently replace lone surrogate escapes.
	// An unavailable optional decoration preserves the original upstream wire.
	if _, err := jsondocument.Object([]byte(line)); err != nil {
		return nil, errConfigResponseInput
	}
	changed := false
	provider, model := fields.get("modelProvider"), fields.get("model")
	providerActive := truth(contextValue["modelProvider"])
	if thread, ok := configResponseObject(result.get("thread")); ok {
		if providerActive && !configResponseEqual(thread.get("modelProvider"), provider) {
			thread.set("modelProvider", provider)
			changed = true
		}
		// JS spreads the thread even when only a top-level field later changes.
		result.set("thread", thread.bytes())
	}
	if value := result.get("modelProvider"); providerActive && value != nil && !configResponseEqual(value, provider) {
		result.set("modelProvider", provider)
		changed = true
	}
	if value := result.get("model"); truth(contextValue["model"]) && value != nil && !configResponseEqual(value, model) {
		result.set("model", model)
		changed = true
	}
	if !changed {
		return unchanged()
	}
	if ctx.Err() != nil {
		return nil, errors.New("codex_config_response_cancelled")
	}
	parsed.set("result", result.bytes())
	outputLine := parsed.bytes()
	if len(outputLine)+1 > MaxConfigResponseInput {
		return nil, ErrBudget
	}
	out, err := marshalWire(struct {
		Unchanged bool   `json:"unchanged"`
		Line      string `json:"line"`
	}{false, string(outputLine)})
	if len(out)+1 > MaxConfigResponseInput {
		return nil, ErrBudget
	}
	return out, err
}

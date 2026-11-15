package nativeresources

import (
	"bytes"
	"encoding/json"
	"strconv"

	"github.com/madou1217/ai_home/internal/runtime/jsondocument"
)

const maxManagedStateBytes = 8 * 1024 * 1024

func managedInteger(value any) (int64, bool) {
	n, ok := value.(json.Number)
	if !ok {
		return 0, false
	}
	v, err := strconv.ParseInt(string(n), 10, 64)
	return v, err == nil && v >= 0 && v <= 9007199254740991
}
func decodeManagedState(raw string, found bool) (ManagedState, error) {
	if !found {
		return emptyManagedState(), nil
	}
	if len(raw) > maxManagedStateBytes {
		return ManagedState{}, fail("managed_resource_state_too_large")
	}
	object, err := jsondocument.Object([]byte(raw))
	if err != nil {
		return ManagedState{}, fail("managed_resource_state_invalid")
	}
	version, ok := managedInteger(object["schemaVersion"])
	if !ok || version != 1 {
		return ManagedState{}, fail("managed_resource_schema_unsupported")
	}
	if _, ok := managedInteger(object["revision"]); !ok {
		return ManagedState{}, fail("managed_resource_state_invalid")
	}
	resources, ok := object["resources"].([]any)
	if !ok {
		return ManagedState{}, fail("managed_resource_state_invalid")
	}
	for _, value := range resources {
		rec, ok := value.(map[string]any)
		if !ok {
			return ManagedState{}, fail("managed_resource_record_invalid")
		}
		for _, key := range []string{"kind", "id"} {
			v, ok := rec[key].(string)
			if !ok || v == "" {
				return ManagedState{}, fail("managed_resource_record_invalid")
			}
		}
		if _, ok := rec["enabled"].(bool); !ok {
			return ManagedState{}, fail("managed_resource_record_invalid")
		}
		for _, key := range []string{"createdAt", "updatedAt"} {
			if _, ok := managedInteger(rec[key]); !ok {
				return ManagedState{}, fail("managed_resource_record_invalid")
			}
		}
	}
	var state ManagedState
	decoder := json.NewDecoder(bytes.NewReader([]byte(raw)))
	decoder.UseNumber()
	if err = decoder.Decode(&state); err != nil {
		return ManagedState{}, fail("managed_resource_state_invalid")
	}
	return state, nil
}

// Forward-compatible fields remain part of the owned state. Typed mutations
// change known fields only; they must not erase another adapter's metadata.
func mergeExtraJSON(known any, extra map[string]json.RawMessage) ([]byte, error) {
	data, err := json.Marshal(known)
	if err != nil {
		return nil, err
	}
	var fields map[string]json.RawMessage
	if err = json.Unmarshal(data, &fields); err != nil {
		return nil, err
	}
	for key, value := range extra {
		if _, exists := fields[key]; !exists {
			fields[key] = value
		}
	}
	return json.Marshal(fields)
}
func (state *ManagedState) UnmarshalJSON(raw []byte) error {
	type alias ManagedState
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value alias
	if err := decoder.Decode(&value); err != nil {
		return err
	}
	var extra map[string]json.RawMessage
	if err := json.Unmarshal(raw, &extra); err != nil {
		return err
	}
	for _, key := range []string{"schemaVersion", "revision", "resources"} {
		delete(extra, key)
	}
	*state = ManagedState(value)
	state.extra = extra
	return nil
}
func (state ManagedState) MarshalJSON() ([]byte, error) {
	type alias ManagedState
	return mergeExtraJSON(alias(state), state.extra)
}
func (record *ManagedRecord) UnmarshalJSON(raw []byte) error {
	type alias ManagedRecord
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value alias
	if err := decoder.Decode(&value); err != nil {
		return err
	}
	var extra map[string]json.RawMessage
	if err := json.Unmarshal(raw, &extra); err != nil {
		return err
	}
	for _, key := range []string{"kind", "id", "provider", "host", "scope", "target", "mode", "version", "digest", "enabled", "removed", "createdAt", "updatedAt", "projections", "server", "configFile", "nativeInstall", "projection"} {
		delete(extra, key)
	}
	*record = ManagedRecord(value)
	record.extra = extra
	return nil
}
func (record ManagedRecord) MarshalJSON() ([]byte, error) {
	type alias ManagedRecord
	return mergeExtraJSON(alias(record), record.extra)
}

func (server *MCPServerSpec) UnmarshalJSON(raw []byte) error {
	type alias MCPServerSpec
	var value alias
	if err := json.Unmarshal(raw, &value); err != nil {
		return err
	}
	var extra map[string]json.RawMessage
	if err := json.Unmarshal(raw, &extra); err != nil {
		return err
	}
	for _, key := range []string{"command", "args", "cwd", "env"} {
		delete(extra, key)
	}
	*server = MCPServerSpec(value)
	server.extra = extra
	return nil
}
func (server MCPServerSpec) MarshalJSON() ([]byte, error) {
	type alias MCPServerSpec
	return mergeExtraJSON(alias(server), server.extra)
}

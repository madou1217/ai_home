package codeassist

import (
	"bytes"
	"encoding/json"

	accountapp "github.com/madou1217/ai_home/application/accounts"
)

// decodeDeprecatedModelWires 只信任目录明确声明且终点仍可用的转发关系。
// 映射链在刷新时展开；推理热路径只做一次 map 读取，不访问上游目录。
func decodeDeprecatedModelWires(document modelCatalogDocument, available map[string]struct{}) (map[string]string, error) {
	raw := document.DeprecatedIDs
	if len(document.DeprecatedIDsSnake) > 0 {
		if len(raw) > 0 {
			return nil, ErrInvalidUpstreamResponse
		}
		raw = document.DeprecatedIDsSnake
	}
	wires := make(map[string]string)
	if len(raw) == 0 || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return wires, nil
	}
	var entries map[string]json.RawMessage
	if err := json.Unmarshal(raw, &entries); err != nil || len(entries) > accountapp.MaxDiscoveredModelsPerAccount {
		return nil, ErrInvalidUpstreamResponse
	}
	targets := make(map[string]string, len(entries))
	for publicID, entry := range entries {
		wireID := decodeDeprecatedModelTarget(entry)
		if validCatalogModelID(publicID) && validCatalogModelID(wireID) && publicID != wireID {
			targets[publicID] = wireID
		}
	}
	states := make(map[string]uint8, len(targets))
	var resolve func(string) string
	resolve = func(model string) string {
		if states[model] != 0 {
			return wires[model]
		}
		target, mapped := targets[model]
		if !mapped {
			if _, found := available[model]; found {
				return model
			}
			return ""
		}
		states[model] = 1
		wireID := resolve(target)
		states[model] = 2
		if wireID != "" {
			wires[model] = wireID
		}
		return wireID
	}
	for model := range targets {
		resolve(model)
	}
	return wires, nil
}

func decodeDeprecatedModelTarget(raw json.RawMessage) string {
	var target string
	if json.Unmarshal(raw, &target) == nil {
		return target
	}
	var detail struct {
		NewModelID      string `json:"newModelId"`
		NewModelIDSnake string `json:"new_model_id"`
	}
	if json.Unmarshal(raw, &detail) != nil ||
		(detail.NewModelID != "" && detail.NewModelIDSnake != "") {
		return ""
	}
	if detail.NewModelID != "" {
		return detail.NewModelID
	}
	return detail.NewModelIDSnake
}

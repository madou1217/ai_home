package codexrelay

import (
	_ "embed"
	"encoding/json"
)

//go:embed errors.json
var manifest []byte

type ErrorDefinition struct {
	Status  int    `json:"status"`
	Message string `json:"message"`
	Type    string `json:"type"`
}

var definitions = func() map[string]ErrorDefinition {
	var result map[string]ErrorDefinition
	if err := json.Unmarshal(manifest, &result); err != nil {
		panic(err)
	}
	return result
}()

func Error(code string) ErrorDefinition {
	if definition, found := definitions[code]; found {
		return definition
	}
	return definitions["upstream_temporarily_unavailable"]
}

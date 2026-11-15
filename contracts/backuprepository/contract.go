// Package backuprepository is the shared v2 layout and bounded I/O contract.
package backuprepository

import (
	_ "embed"
	"encoding/json"
)

//go:embed format.json
var FormatJSON []byte

type Layout struct {
	Kind             string `json:"kind"`
	Version          int    `json:"version"`
	ObjectEncoding   string `json:"objectEncoding"`
	MaxSnapshotBytes int    `json:"maxSnapshotBytes"`
	MaxObjectBytes   int    `json:"maxObjectBytes"`
	MaxManifestBytes int    `json:"maxManifestBytes"`
	MaxAccounts      int    `json:"maxAccounts"`
	LockPath         string `json:"lockPath"`
	FormatPath       string `json:"formatPath"`
	ManifestPath     string `json:"manifestPath"`
	ObjectsPrefix    string `json:"objectsPrefix"`
	ManifestsPrefix  string `json:"manifestsPrefix"`
}

var Contract = func() Layout {
	var v Layout
	if err := json.Unmarshal(FormatJSON, &v); err != nil {
		panic(err)
	}
	return v
}()

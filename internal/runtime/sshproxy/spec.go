package sshproxy

import (
	"encoding/json"
	"strings"

	"github.com/madou1217/ai_home/internal/adapters/sshremote"
	"github.com/madou1217/ai_home/internal/runtime/sshtunnel"
)

type spec struct {
	ID, Name string
	Config   sshremote.Config
	Error    string
}

func specs(raw []byte, home string, known map[string]string) ([]spec, error) {
	var records []map[string]any
	if len(strings.TrimSpace(string(raw))) == 0 {
		return nil, nil
	}
	if err := json.Unmarshal(raw, &records); err != nil {
		return nil, err
	}
	byID := map[string]map[string]any{}
	for _, r := range records {
		byID[text(r["id"])] = r
	}
	out := []spec{}
	for _, r := range records {
		enabled, _ := r["proxyEnabled"].(bool)
		if !enabled {
			continue
		}
		id := text(r["id"])
		if id == "" {
			continue
		}
		item := spec{ID: id, Name: text(r["label"])}
		if item.Name == "" {
			item.Name = id
		}
		config, err := sshtunnel.ConfigFromRecord(r, byID, home)
		config.HomeDir = home
		item.Config = sshtunnel.ApplyHostKeys(config, known)
		if err != nil {
			item.Error = err.Error()
		}
		out = append(out, item)
	}
	return out, nil
}
func text(v any) string    { return strings.TrimSpace(rawText(v)) }
func rawText(v any) string { s, _ := v.(string); return s }

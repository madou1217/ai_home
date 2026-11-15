package main

import (
	"encoding/json"
	"fmt"
	"io"
	"path/filepath"

	"github.com/madou1217/ai_home/internal/runtime/codexpreferences"
)

// runCodexConfigEdit is an internal compare-and-replace port for the existing
// config healer. Document text travels through stdin, never argv or diagnostics.
func runCodexConfigEdit(configPath string, runtime commandRuntime) error {
	if !filepath.IsAbs(configPath) || filepath.Base(configPath) != "config.toml" {
		return fmt.Errorf("invalid_codex_config_path")
	}
	const maxInput = 12 << 20
	data, err := io.ReadAll(io.LimitReader(runtime.stdin, maxInput+1))
	if err != nil || len(data) > maxInput {
		return fmt.Errorf("codex_config_edit_input_invalid")
	}
	var edit struct {
		Expected *string `json:"expected"`
		Next     *string `json:"next"`
	}
	if json.Unmarshal(data, &edit) != nil || edit.Expected == nil || edit.Next == nil {
		return fmt.Errorf("codex_config_edit_input_invalid")
	}
	if err := codexpreferences.ReplaceDocument(filepath.Dir(configPath), *edit.Expected, *edit.Next); err != nil {
		return fmt.Errorf("codex_config_edit_rejected")
	}
	return nil
}

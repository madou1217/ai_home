package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"

	"github.com/madou1217/ai_home/internal/runtime/claudedesktopconfig"
)

// Explicit private pipe adapter. Preparation is independent of GUI launch,
// server lifecycle and credentials; stdout contains only the bounded result.
func runClaudeDesktopConfig(ctx context.Context, runtime commandRuntime) error {
	raw, err := io.ReadAll(io.LimitReader(runtime.stdin, 64*1024+1))
	if err != nil || len(raw) > 64*1024 {
		return errors.New("desktop_config_request_invalid")
	}
	var options claudedesktopconfig.Options
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&options) != nil {
		return errors.New("desktop_config_request_invalid")
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return errors.New("desktop_config_request_invalid")
	}
	return json.NewEncoder(runtime.stdout).Encode(claudedesktopconfig.Prepare(ctx, options))
}

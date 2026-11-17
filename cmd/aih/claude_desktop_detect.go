package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"

	"github.com/madou1217/ai_home/internal/adapters/hostapps"
)

func runClaudeDesktopDetect(ctx context.Context, runtime commandRuntime) error {
	invalid := errors.New("desktop_detection_request_invalid")
	raw, err := io.ReadAll(io.LimitReader(runtime.stdin, 1025))
	if err != nil || len(raw) > 1024 {
		return invalid
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	for _, expected := range []any{json.Delim('{'), "intent", "host-claude-running", json.Delim('}')} {
		token, err := decoder.Token()
		if err != nil || token != expected {
			return invalid
		}
	}
	if _, err := decoder.Token(); err != io.EOF {
		return invalid
	}
	result, _ := hostapps.DetectClaudeDesktop(ctx)
	return json.NewEncoder(runtime.stdout).Encode(result)
}

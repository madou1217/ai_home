package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/hostapps"
	"github.com/madou1217/ai_home/internal/host/boundedinput"
)

func runCodexDesktopDetect(ctx context.Context, runtime commandRuntime) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	invalid := errors.New("desktop_detection_request_invalid")
	raw, err := boundedinput.Read(ctx, runtime.stdin, 1024)
	if err != nil {
		return invalid
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	for _, expected := range []any{json.Delim('{'), "intent", "host-codex-running", json.Delim('}')} {
		token, err := decoder.Token()
		if err != nil || token != expected {
			return invalid
		}
	}
	if _, err := decoder.Token(); err != io.EOF {
		return invalid
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	result, _ := hostapps.DetectCodexDesktop(ctx)
	if err := ctx.Err(); err != nil {
		return err
	}
	return json.NewEncoder(runtime.stdout).Encode(result)
}

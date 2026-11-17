package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"

	"github.com/madou1217/ai_home/internal/runtime/toolkit/apps"
)

func runClaudeDesktopLaunch(ctx context.Context, runtime commandRuntime) error {
	raw, err := io.ReadAll(io.LimitReader(runtime.stdin, 64*1024+1))
	invalid := errors.New("desktop_launch_request_invalid")
	if err != nil || len(raw) > 64*1024 {
		return invalid
	}
	fields, err := exactClaudeLaunchObject(raw, "intent", "aiHomeDir", "hostHomeDir", "accountRef", "selectedRecord", "prepared", "planOnly")
	if err != nil {
		return invalid
	}
	if _, err = exactClaudeLaunchObject(fields["selectedRecord"], "executablePath", "bundlePath"); err != nil {
		return invalid
	}
	if _, err = exactClaudeLaunchObject(fields["prepared"], "profileDir", "configId"); err != nil {
		return invalid
	}
	var request apps.ClaudeDesktopAccountLaunchRequest
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&request) != nil {
		return invalid
	}
	return json.NewEncoder(runtime.stdout).Encode(apps.LaunchClaudeDesktopAccount(ctx, request, apps.Options{}))
}

func exactClaudeLaunchObject(raw []byte, names ...string) (map[string]json.RawMessage, error) {
	invalid := errors.New("desktop_launch_request_invalid")
	allowed := make(map[string]bool, len(names))
	for _, name := range names {
		allowed[name] = true
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	if token, err := decoder.Token(); err != nil || token != json.Delim('{') {
		return nil, invalid
	}
	fields := make(map[string]json.RawMessage, len(names))
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return nil, invalid
		}
		name, ok := token.(string)
		if _, exists := fields[name]; !ok || !allowed[name] || exists {
			return nil, invalid
		}
		var value json.RawMessage
		if decoder.Decode(&value) != nil || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return nil, invalid
		}
		fields[name] = value
	}
	if token, err := decoder.Token(); err != nil || token != json.Delim('}') || len(fields) != len(names) {
		return nil, invalid
	}
	var trailing any
	if decoder.Decode(&trailing) != io.EOF {
		return nil, invalid
	}
	return fields, nil
}

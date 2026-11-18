package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/madou1217/ai_home/internal/host/boundedinput"
	"github.com/madou1217/ai_home/internal/runtime/toolkit/apps"
)

func runClaudeDesktopLaunch(ctx context.Context, runtime commandRuntime) error {
	ctx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	raw, err := boundedinput.Read(ctx, runtime.stdin, 64*1024)
	defer clear(raw)
	invalid := errors.New("desktop_launch_request_invalid")
	if err != nil {
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
	if decoder.Decode(&request) != nil ||
		(request.Intent != "account-api-launch" && request.Intent != "account-web-launch") {
		return invalid
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	result := apps.LaunchClaudeDesktopAccount(ctx, request, apps.Options{})
	if err := ctx.Err(); err != nil {
		return err
	}
	return json.NewEncoder(runtime.stdout).Encode(result)
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

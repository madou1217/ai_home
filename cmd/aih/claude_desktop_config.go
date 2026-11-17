package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"path/filepath"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/claudedesktopconfig"
	"github.com/madou1217/ai_home/internal/runtime/toolkit/apps"
)

type managedClaudeDesktopGatewayRequest struct {
	Intent      string `json:"intent"`
	AIHomeDir   string `json:"aiHomeDir"`
	HostHomeDir string `json:"hostHomeDir"`
	DryRun      bool   `json:"dryRun"`
}

type claudeDesktopAccountModeRequest struct {
	Intent     string `json:"intent"`
	AIHomeDir  string `json:"aiHomeDir"`
	AccountRef string `json:"accountRef"`
	Mode       string `json:"mode"`
	DryRun     bool   `json:"dryRun"`
}

// Explicit private pipe adapter. Preparation is independent of GUI launch and
// server lifecycle; managed requests leave config and helper selection in Go.
func runClaudeDesktopConfig(ctx context.Context, runtime commandRuntime) error {
	raw, err := io.ReadAll(io.LimitReader(runtime.stdin, 64*1024+1))
	if err != nil || len(raw) > 64*1024 {
		return errors.New("desktop_config_request_invalid")
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil {
		return errors.New("desktop_config_request_invalid")
	}
	if rawIntent, typed := fields["intent"]; typed {
		var intent string
		if json.Unmarshal(rawIntent, &intent) != nil {
			return errors.New("desktop_config_request_invalid")
		}
		result, prepareErr := prepareTypedClaudeDesktopConfig(ctx, raw, intent)
		if prepareErr != nil {
			return prepareErr
		}
		return json.NewEncoder(runtime.stdout).Encode(result)
	}
	var options claudedesktopconfig.Options
	if decodeClaudeDesktopConfigRequest(raw, &options) != nil {
		return errors.New("desktop_config_request_invalid")
	}
	return json.NewEncoder(runtime.stdout).Encode(claudedesktopconfig.Prepare(ctx, options))
}

func prepareTypedClaudeDesktopConfig(ctx context.Context, raw []byte, intent string) (claudedesktopconfig.Result, error) {
	invalid := errors.New("desktop_config_request_invalid")
	switch intent {
	case "managed-gateway":
		if validateTypedClaudeDesktopConfigRequest(raw, false, "intent", "aiHomeDir", "hostHomeDir", "dryRun") != nil {
			return claudedesktopconfig.Result{}, invalid
		}
		var request managedClaudeDesktopGatewayRequest
		if decodeClaudeDesktopConfigRequest(raw, &request) != nil {
			return claudedesktopconfig.Result{}, invalid
		}
		request.AIHomeDir = strings.TrimSpace(request.AIHomeDir)
		request.HostHomeDir = strings.TrimSpace(request.HostHomeDir)
		if !validClaudeDesktopConfigRoot(request.AIHomeDir) || !validClaudeDesktopConfigRoot(request.HostHomeDir) {
			return claudedesktopconfig.Result{}, invalid
		}
		return apps.PrepareClaudeDesktopGatewayResult(ctx, apps.Options{
			AIHomeDir: request.AIHomeDir, HostHomeDir: request.HostHomeDir,
		}, request.DryRun), nil
	case "account-mode":
		if validateTypedClaudeDesktopConfigRequest(raw, true, "intent", "aiHomeDir", "accountRef", "mode", "dryRun") != nil {
			return claudedesktopconfig.Result{}, invalid
		}
		var request claudeDesktopAccountModeRequest
		if decodeClaudeDesktopConfigRequest(raw, &request) != nil || !validClaudeDesktopConfigRoot(request.AIHomeDir) ||
			(request.Mode != "web" && request.Mode != "api") {
			return claudedesktopconfig.Result{}, invalid
		}
		return apps.PrepareClaudeDesktopAccountMode(ctx, apps.Options{
			AIHomeDir: request.AIHomeDir,
		}, request.AccountRef, request.Mode, request.DryRun), nil
	default:
		return claudedesktopconfig.Result{}, invalid
	}
}

func validClaudeDesktopConfigRoot(value string) bool {
	return filepath.IsAbs(value) && !strings.ContainsRune(value, 0)
}

func decodeClaudeDesktopConfigRequest(raw []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(target) != nil {
		return errors.New("desktop_config_request_invalid")
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return errors.New("desktop_config_request_invalid")
	}
	return nil
}

// Typed requests use exact field names and reject duplicate/null values; the
// legacy Options decoder retains its original compatibility contract.
func validateTypedClaudeDesktopConfigRequest(raw []byte, required bool, fields ...string) error {
	allowed := make(map[string]bool, len(fields))
	for _, field := range fields {
		allowed[field] = true
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	if token, err := decoder.Token(); err != nil || token != json.Delim('{') {
		return errors.New("desktop_config_request_invalid")
	}
	seen := make(map[string]bool)
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return errors.New("desktop_config_request_invalid")
		}
		key, ok := token.(string)
		if !ok || seen[key] {
			return errors.New("desktop_config_request_invalid")
		}
		if !allowed[key] {
			return errors.New("desktop_config_request_invalid")
		}
		seen[key] = true
		var value json.RawMessage
		if decoder.Decode(&value) != nil || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return errors.New("desktop_config_request_invalid")
		}
	}
	if _, err := decoder.Token(); err != nil || (required && len(seen) != len(allowed)) {
		return errors.New("desktop_config_request_invalid")
	}
	return nil
}

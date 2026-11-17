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
	if _, managed := fields["intent"]; managed {
		if validateManagedClaudeDesktopGatewayRequest(raw) != nil {
			return errors.New("desktop_config_request_invalid")
		}
		var request managedClaudeDesktopGatewayRequest
		if decodeClaudeDesktopConfigRequest(raw, &request) != nil || request.Intent != "managed-gateway" {
			return errors.New("desktop_config_request_invalid")
		}
		request.AIHomeDir = strings.TrimSpace(request.AIHomeDir)
		request.HostHomeDir = strings.TrimSpace(request.HostHomeDir)
		if !filepath.IsAbs(request.AIHomeDir) || !filepath.IsAbs(request.HostHomeDir) ||
			strings.ContainsRune(request.AIHomeDir, 0) || strings.ContainsRune(request.HostHomeDir, 0) {
			return errors.New("desktop_config_request_invalid")
		}
		result := apps.PrepareClaudeDesktopGatewayResult(ctx, apps.Options{
			AIHomeDir: request.AIHomeDir, HostHomeDir: request.HostHomeDir,
		}, request.DryRun)
		return json.NewEncoder(runtime.stdout).Encode(result)
	}
	var options claudedesktopconfig.Options
	if decodeClaudeDesktopConfigRequest(raw, &options) != nil {
		return errors.New("desktop_config_request_invalid")
	}
	return json.NewEncoder(runtime.stdout).Encode(claudedesktopconfig.Prepare(ctx, options))
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

// Managed requests use exact field names and reject duplicate/null values; the
// legacy Options decoder retains its original compatibility contract.
func validateManagedClaudeDesktopGatewayRequest(raw []byte) error {
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
		switch key {
		case "intent", "aiHomeDir", "hostHomeDir", "dryRun":
		default:
			return errors.New("desktop_config_request_invalid")
		}
		seen[key] = true
		var value json.RawMessage
		if decoder.Decode(&value) != nil || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return errors.New("desktop_config_request_invalid")
		}
	}
	if _, err := decoder.Token(); err != nil {
		return errors.New("desktop_config_request_invalid")
	}
	return nil
}

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"path/filepath"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/toolkit/apps"
)

// Private compatibility adapter: no server start, version probe or configuration
// contents in argv. Node legacy entrypoints share the Go ownership/write boundary.
func runProviderHookConfig(ctx context.Context, runtime commandRuntime) error {
	var input struct {
		Action         string            `json:"action"`
		Provider       string            `json:"provider"`
		HomeDir        string            `json:"homeDir"`
		ReceiverURL    string            `json:"receiverUrl"`
		CodexVersion   string            `json:"codexVersion"`
		DryRun         bool              `json:"dryRun"`
		Env            map[string]string `json:"env"`
		Events         []string          `json:"events"`
		HookName       string            `json:"hookName"`
		TimeoutSeconds int               `json:"timeoutSeconds"`
		TimeoutMs      int               `json:"timeoutMs"`
		SenderExec     string            `json:"senderExecPath"`
	}
	raw, readErr := io.ReadAll(io.LimitReader(runtime.stdin, 64*1024+1))
	if readErr != nil || len(raw) > 64*1024 {
		return errors.New("hook_bridge_invalid_request")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	if decoder.Decode(&input) != nil {
		return errors.New("hook_bridge_invalid_request")
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return errors.New("hook_bridge_invalid_request")
	}
	if !filepath.IsAbs(input.HomeDir) || strings.TrimSpace(input.Provider) == "" {
		return errors.New("hook_bridge_explicit_home_required")
	}
	opts := apps.Options{HostHomeDir: input.HomeDir, ReceiverURL: input.ReceiverURL, CodexVersion: input.CodexVersion, HookDryRun: input.DryRun, Env: input.Env, HookEvents: input.Events, HookName: input.HookName, HookTimeoutSeconds: input.TimeoutSeconds, HookTimeoutMilliseconds: input.TimeoutMs, SenderExecPath: input.SenderExec}
	var result apps.HookOperationOutcome
	switch input.Action {
	case "install":
		result = apps.InstallProviderHooks(ctx, input.Provider, opts)
	case "uninstall":
		result = apps.UninstallProviderHooks(input.Provider, opts)
	default:
		return errors.New("hook_bridge_invalid_action")
	}
	return json.NewEncoder(runtime.stdout).Encode(result)
}

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

const (
	execPolicyKey      = "policy:exec"
	execPolicyVersion  = 1
	defaultExecSandbox = "workspace-write"
	sandboxDangerFull  = "danger-full-access"
	sandboxReadOnly    = "read-only"
)

// execPolicy 与 Node lib/runtime/permission-policy.js 同结构（app-state policy:exec）。
type execPolicy struct {
	Version   int    "json:\"version\""
	UpdatedAt string "json:\"updatedAt\""
	Exec      struct {
		DefaultSandbox        string "json:\"defaultSandbox\""
		AllowDangerFullAccess bool   "json:\"allowDangerFullAccess\""
	} "json:\"exec\""
}

// runProviderPolicy 实现 aih codex policy [show|set <sandbox>]。
func runProviderPolicy(
	ctx context.Context,
	providerID string,
	arguments []string,
	runtime commandRuntime,
) error {
	if providerID != "codex" {
		return fmt.Errorf("%w: %s policy is unsupported. Only codex policy is available.", errInvalidCommand, providerID)
	}
	action := "show"
	value := ""
	if len(arguments) > 0 {
		action = strings.ToLower(strings.TrimSpace(arguments[0]))
	}
	if len(arguments) > 1 {
		value = strings.TrimSpace(arguments[1])
	}
	if len(arguments) > 2 || (action != "show" && action != "set") {
		return fmt.Errorf("%w: Usage: aih codex policy [set <workspace-write|read-only|danger-full-access>]", errInvalidCommand)
	}
	aiHomeDir, err := resolveAIHomeDir(runtime)
	if err != nil {
		return err
	}
	databasePath, err := appstate.DatabasePath(aiHomeDir)
	if err != nil {
		return err
	}
	policy, err := loadExecPolicy(ctx, databasePath)
	if err != nil {
		return err
	}
	if action == "set" {
		sandbox, sandboxErr := normalizePolicySandbox(value)
		if sandboxErr != nil {
			return sandboxErr
		}
		policy.Exec.DefaultSandbox = sandbox
		policy.Exec.AllowDangerFullAccess = sandbox == sandboxDangerFull
		policy.Version = execPolicyVersion
		policy.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
		if err := saveExecPolicy(ctx, databasePath, policy); err != nil {
			return fmt.Errorf("permission_policy_write_failed: %w", err)
		}
	}
	writeExecPolicy(runtime, policy)
	return nil
}

// loadExecPolicy 读取并归一 policy:exec；缺失或损坏时回退默认值。
func loadExecPolicy(ctx context.Context, databasePath string) (execPolicy, error) {
	raw, found, err := appstate.ReadKV(ctx, databasePath, execPolicyKey)
	if err != nil {
		return execPolicy{}, err
	}
	policy := defaultExecPolicy()
	if !found || strings.TrimSpace(raw) == "" {
		return policy, nil
	}
	var stored execPolicy
	if json.Unmarshal([]byte(raw), &stored) != nil {
		return policy, nil
	}
	policy.UpdatedAt = strings.TrimSpace(stored.UpdatedAt)
	policy.Exec.DefaultSandbox = normalizePolicySandboxOr(stored.Exec.DefaultSandbox)
	policy.Exec.AllowDangerFullAccess = stored.Exec.AllowDangerFullAccess
	return policy, nil
}

func saveExecPolicy(ctx context.Context, databasePath string, policy execPolicy) error {
	encoded, err := json.Marshal(policy)
	if err != nil {
		return err
	}
	return appstate.WriteKV(ctx, databasePath, execPolicyKey, string(encoded), time.Now().UnixMilli())
}

func defaultExecPolicy() execPolicy {
	policy := execPolicy{Version: execPolicyVersion}
	policy.Exec.DefaultSandbox = defaultExecSandbox
	return policy
}

// normalizePolicySandbox 只接受三种官方 sandbox；空值按 Node 文案报错。
func normalizePolicySandbox(value string) (string, error) {
	sandbox := strings.ToLower(strings.TrimSpace(value))
	if sandbox == "" {
		return "", fmt.Errorf("Missing sandbox value. Use: policy set <workspace-write|read-only|danger-full-access>")
	}
	switch sandbox {
	case sandboxDangerFull, sandboxReadOnly, defaultExecSandbox:
		return sandbox, nil
	default:
		return "", fmt.Errorf(
			"Invalid sandbox value '%s'. Expected workspace-write, read-only, or danger-full-access.",
			value,
		)
	}
}

// normalizePolicySandboxOr 读取时把未知值归一成 workspace-write。
func normalizePolicySandboxOr(value string) string {
	sandbox, err := normalizePolicySandbox(value)
	if err != nil {
		return defaultExecSandbox
	}
	return sandbox
}

// effectiveExecSandbox 与 Node 一致：只有显式允许时 danger 才生效。
func effectiveExecSandbox(policy execPolicy) string {
	if policy.Exec.DefaultSandbox == sandboxDangerFull && policy.Exec.AllowDangerFullAccess {
		return sandboxDangerFull
	}
	return policy.Exec.DefaultSandbox
}

func writeExecPolicy(runtime commandRuntime, policy execPolicy) {
	_, _ = fmt.Fprintf(runtime.stdout, "default_sandbox: %s\n", policy.Exec.DefaultSandbox)
	_, _ = fmt.Fprintf(runtime.stdout, "allow_danger_full_access: %t\n", policy.Exec.AllowDangerFullAccess)
	_, _ = fmt.Fprintf(runtime.stdout, "effective_exec_sandbox: %s\n", effectiveExecSandbox(policy))
}

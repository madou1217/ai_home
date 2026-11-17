package providercliupgrade

import (
	"context"
	"fmt"

	"github.com/madou1217/ai_home/internal/runtime/codexruntime"
)

// runCodexRuntime never updates a global npm prefix or an in-use original.
// The existing policy/ledger owns check/soak/busy decisions; this owns mutation.
func (d *RealDeps) runCodexRuntime(ctx context.Context, version, phase string) PlanResult {
	if NormalizeVersionSpec(version) != version || version == "" {
		return PlanResult{Error: "invalid_version"}
	}
	if value := lookupEnvMapOrOS(d.baseEnv, "AIH_CODEX_BINARY"); value != "" {
		return PlanResult{Error: "explicit_codex_override_requires_manual_update"}
	}
	tx, err := codexruntime.Begin(d.hostHomeDir)
	if err != nil {
		return PlanResult{Error: err.Error()}
	}
	defer tx.Close()
	if phase == "rollback" {
		if restored, restoreErr := tx.RestoreVersion(version); restored || restoreErr != nil {
			if restoreErr != nil {
				return PlanResult{Error: restoreErr.Error()}
			}
			return PlanResult{OK: true}
		}
	}
	command, args, err := d.codexNPMInstallCommand(version, tx.Prefix)
	if err != nil {
		return PlanResult{Error: err.Error()}
	}
	result := ExecuteInstallPlans(ctx, []InstallPlan{{ID: "codex_managed_install", Command: command, Args: args, Timeout: defaultNpmInstallTimeout}}, d.goos, d.baseEnv)
	if !result.OK {
		return result
	}
	binary, err := codexruntime.NativeFromPrefix(tx.Prefix)
	if err != nil {
		return PlanResult{Error: err.Error()}
	}
	if actual := d.probeVersion(ctx, binary); actual != version {
		return PlanResult{Error: fmt.Sprintf("candidate_version_mismatch:%s!=%s", actual, version)}
	}
	verdict := VerifyCodexAppServerBoot(ctx, CodexVerifyOptions{CLIPath: binary, Timeout: d.verifyTimeout, GoOS: d.goos, NodeExecutable: d.nodeExec, BaseEnv: d.baseEnv})
	if verdict.Verdict != VerdictPass {
		return PlanResult{Error: "candidate_boot_not_verified:" + verdict.Detail}
	}
	if err = tx.Activate(binary, version); err != nil {
		return PlanResult{Error: err.Error()}
	}
	// Verification must compare against the same managed ownership after the
	// generation switch; external channels retain their own lifecycle adapter.
	d.memoMu.Lock()
	d.channelMemo["codex"] = ChannelAIHManaged
	d.memoMu.Unlock()
	return PlanResult{OK: true, Stdout: "Codex " + version + " 已验证并启用；原版本保留。"}
}

func (d *RealDeps) codexNPMInstallCommand(version, prefix string) (string, []string, error) {
	userConfig := "/dev/null"
	if d.goos == "windows" {
		userConfig = "NUL"
	}
	args := []string{"install", "--global", "@openai/codex@" + version, "--prefix", prefix,
		"--userconfig=" + userConfig, "--registry=" + NpmRegistryURL, "--maxsockets=4", "--fetch-timeout=60000",
		"--fetch-retries=3", "--no-audit", "--no-fund"}
	return npmRuntimeCommand(args, d.goos, envSliceFromMap(d.baseEnv), d.nodeExec)
}

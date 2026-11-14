//go:build windows

package webuiserverrestartapi

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

//go:embed windows_task_guard.ps1
var windowsTaskGuard string

//go:embed windows_task_restart.ps1
var windowsTaskRestart string

func (r *NativeRestarter) restartPlatform(ctx context.Context, job RestartJob) (RestartOutcome, bool, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	home, err := canonicalWindowsPath(r.aiHomeDir)
	if err != nil || !windowsRestartJobID.MatchString(job.ID) {
		return RestartOutcome{}, true, ErrRestartUnavailable
	}
	statusDir := filepath.Join(home, "run", "server-restarts")
	if err := os.MkdirAll(statusDir, 0o700); err != nil {
		return RestartOutcome{}, true, err
	}
	actualDir, err := canonicalWindowsPath(statusDir)
	if err != nil || !strings.EqualFold(actualDir, statusDir) {
		return RestartOutcome{}, true, fmt.Errorf("server_restart_status_path_mismatch")
	}
	plan := windowsRestartPlan{JobID: job.ID, Home: home, OldPID: os.Getpid(), CreatedAt: job.CreatedAt,
		StatusPath: filepath.Join(statusDir, job.ID+".json"), LockPath: filepath.Join(statusDir, "windows-task.lock")}
	if err := writeWindowsRestartStatus(plan, "validating", ""); err != nil {
		return RestartOutcome{}, true, err
	}
	fail := func(code string) (RestartOutcome, bool, error) {
		_ = writeWindowsRestartStatus(plan, "failed", code)
		return RestartOutcome{}, true, fmt.Errorf("%s", code)
	}
	validated, err := readWindowsRestartPlan(r.aiHomeDir, job)
	if err != nil {
		return fail("server_restart_instance_validation_failed")
	}
	validated.StatusPath, validated.LockPath = plan.StatusPath, plan.LockPath
	plan = validated
	config, err := readPublicServerConfig(ctx, r.aiHomeDir)
	if err != nil {
		return fail("server_restart_config_unavailable")
	}
	if r.requestShutdown == nil {
		return fail("server_restart_shutdown_unavailable")
	}
	encodedPlan, err := json.Marshal(plan)
	if err != nil {
		return fail("server_restart_plan_invalid")
	}
	prelude := "$PlanBase64 = '" + base64.StdEncoding.EncodeToString(encodedPlan) + "'\n" + windowsTaskGuard
	// Validate before arming a detached worker or requesting graceful shutdown.
	probeCtx, probeCancel := context.WithTimeout(ctx, serviceProbeTimeout)
	probeOutput, err := runWindowsPowerShell(probeCtx, prelude+"\n$null = Assert-SafePlan\n[Console]::Write('validated')\n")
	probeCancel()
	if err != nil || string(bytes.TrimSpace(probeOutput)) != "validated" {
		return fail("server_restart_task_validation_failed")
	}
	powershell, err := windowsPowerShellPath()
	if err != nil {
		return fail("server_restart_powershell_unavailable")
	}
	workerPath := filepath.Join(statusDir, job.ID+".ps1")
	worker, err := os.OpenFile(workerPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return fail("server_restart_worker_file_failed")
	}
	_, writeErr := worker.WriteString(prelude + "\n" + windowsTaskRestart)
	closeErr := worker.Close()
	if writeErr != nil || closeErr != nil {
		return fail("server_restart_worker_file_failed")
	}
	// A local script file keeps the detached command below Windows' command-line limit.
	// Respect the current execution policy: never add ExecutionPolicy Bypass/RunAs.
	childCommand := `"` + powershell + `" -NoLogo -NoProfile -NonInteractive -File "` + workerPath + `"`
	// A normal detached child can still be killed with its scheduled-task job object.
	// Local WMI creates a same-user, noninteractive worker outside the stopped task;
	// no alternate credentials, RunAs, elevation or task registration is requested.
	launch := "$ErrorActionPreference='Stop'\n" +
		"$startup=([wmiclass]'Win32_ProcessStartup').CreateInstance()\n$startup.ShowWindow=0\n" +
		"$result=([wmiclass]'Win32_Process').Create(" + psString(childCommand) + "," + psString(plan.Home) + ",$startup)\n" +
		"if ($result.ReturnValue -ne 0 -or $result.ProcessId -le 0) { throw 'server_restart_worker_launch_failed' }\n" +
		"[Console]::Write(([pscustomobject]@{pid=[int]$result.ProcessId}|ConvertTo-Json -Compress))\n"
	launchCtx, launchCancel := context.WithTimeout(ctx, serviceProbeTimeout)
	output, err := runWindowsPowerShell(launchCtx, launch)
	launchCancel()
	if err != nil {
		return fail("server_restart_worker_launch_failed")
	}
	var launched struct {
		PID int `json:"pid"`
	}
	if json.Unmarshal(bytes.TrimSpace(output), &launched) != nil || launched.PID <= 0 {
		return fail("server_restart_worker_launch_invalid")
	}
	armedCtx, armedCancel := context.WithTimeout(ctx, 8*time.Second)
	defer armedCancel()
	if err := awaitWindowsRestartArmed(armedCtx, plan.StatusPath); err != nil {
		return fail("server_restart_worker_not_armed")
	}
	// Arming is not completion. The host callback carries no HTTP auth/transport dependency;
	// even a panic/uncertain host acknowledgement must not race the worker with terminal failure.
	func() {
		defer func() { _ = recover() }()
		r.requestShutdown()
	}()
	return RestartOutcome{PID: launched.PID, AppliedConfig: config, Pending: true}, true, nil

}

func writeWindowsRestartStatus(plan windowsRestartPlan, status, code string) error {
	raw, err := json.Marshal(map[string]any{
		"version": 1, "jobId": plan.JobID, "task": plan.Task, "status": status,
		"stage": "preflight", "oldPid": plan.OldPID, "newPid": 0,
		"createdAt": plan.CreatedAt, "updatedAt": time.Now().UnixMilli(), "error": code,
	})
	if err != nil {
		return err
	}
	return os.WriteFile(plan.StatusPath, raw, 0o600)
}

func (r *NativeRestarter) RestartStatus(_ context.Context, jobID string) (map[string]any, error) {
	if r == nil || !windowsRestartJobID.MatchString(jobID) {
		return nil, ErrRestartUnavailable
	}
	raw, err := readWindowsMetadata(filepath.Join(r.aiHomeDir, "run", "server-restarts", jobID+".json"), 16*1024)
	if err != nil {
		return nil, err
	}
	var status map[string]any
	if json.Unmarshal(raw, &status) != nil || status["jobId"] != jobID {
		return nil, ErrRestartUnavailable
	}
	return status, nil
}

func runWindowsPowerShell(ctx context.Context, script string) ([]byte, error) {
	binary, err := windowsPowerShellPath()
	if err != nil {
		return nil, err
	}
	cmd := exec.CommandContext(ctx, binary, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "-")
	cmd.Stdin = strings.NewReader("try { & {\n" + script + "\n} } catch { exit 1 }\n\n")
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	cmd.WaitDelay = time.Second
	// Do not return arbitrary stderr/COM exceptions; they may include command arguments.
	return cmd.Output()
}

func windowsPowerShellPath() (string, error) {
	root := os.Getenv("SystemRoot")
	if root == "" || !filepath.IsAbs(root) {
		return "", ErrRestartUnavailable
	}
	path := filepath.Join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
	if info, err := os.Stat(path); err != nil || !info.Mode().IsRegular() {
		return "", ErrRestartUnavailable
	}
	return path, nil
}

func psString(value string) string { return "'" + strings.ReplaceAll(value, "'", "''") + "'" }

func awaitWindowsRestartArmed(ctx context.Context, path string) error {
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		if raw, err := readWindowsMetadata(path, 16*1024); err == nil {
			var state struct {
				Status string `json:"status"`
			}
			if json.Unmarshal(raw, &state) == nil {
				if state.Status == "armed" {
					return nil
				}
				if state.Status == "failed" {
					return ErrRestartUnavailable
				}
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

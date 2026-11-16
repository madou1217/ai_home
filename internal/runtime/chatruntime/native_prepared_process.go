package chatruntime

import (
	"context"
	"errors"
	"net/http"
	"os"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/providercli"
	"github.com/madou1217/ai_home/internal/runtime/providercli/sessionchat"
	"github.com/madou1217/ai_home/internal/runtime/pty"
)

// Consume the host's prepared direct execution plan without reimplementing its
// account strategies, gateway topology or credential projection.
func (r *execNativeTurnRunner) startPreparedNativeProcess(
	ctx context.Context, req NativeRunRequest, command sessionchat.Command, interactive bool,
) (_ *NativeRunHandle, startErr error) {
	// GetTarget describes the provider, not this turn's resume transport. Check
	// before Prepare so unsupported ACP/desktop/transcript turns allocate nothing.
	if !interactive && !req.Slash {
		resume := strings.TrimSpace(req.NativeSessionID) != ""
		transport := sessionchat.ResolveNativeChatTransport(req.Provider, resume)
		if transport.Mode != sessionchat.ModeHeadlessStream || transport.PromptDelivery != sessionchat.PromptDeliveryArgv {
			return nil, NewError("native_execution_transport_unsupported", http.StatusUnprocessableEntity, map[string]any{
				"provider": sessionchat.NormalizeProvider(req.Provider), "transport": transport.Mode,
				"promptDelivery": transport.PromptDelivery, "resume": resume,
			})
		}
	}
	plan, err := r.prepareNativeLaunch(ctx, req, command)
	if err != nil {
		return nil, err
	}
	release := func() error { return releaseNativeLaunch(ctx, plan) }
	defer func() {
		if startErr != nil {
			startErr = errors.Join(startErr, release())
		}
	}()
	binPath, err := providercli.ResolveBinary(plan.Target.Provider, plan.BinaryName)
	if err != nil {
		return nil, NewError("provider_cli_not_found", http.StatusServiceUnavailable, map[string]any{
			"provider": plan.Target.Provider, "message": err.Error(),
		})
	}
	workDir := strings.TrimSpace(req.Session.ProjectPath)
	if workDir == "" {
		if dir, err := ChatWorkingDirectory(r.aiHomeDir, req.Session.SessionID); err == nil {
			workDir = dir
		}
	}
	if req.Slash && !pty.Available() {
		return nil, NewError("native_pty_unavailable", http.StatusServiceUnavailable, nil)
	}
	if plan.Target.ClientProtocol == NativeClientProtocolPTY && !interactive {
		// Do not claim an interactive descriptor while actually starting a stream runner.
		return nil, NewError("native_execution_transport_mismatch", http.StatusUnprocessableEntity, nil)
	}
	if plan.Target.Provider == "agy" {
		if err := verifyAGYStreamProtocol(ctx, binPath, workDir, plan.Env); err != nil {
			return nil, err
		}
	}
	if interactive {
		return r.startInteractivePTYWithLaunch(ctx, req, binPath, plan.Args, workDir, plan.Env, release)
	}
	args, cleanup := plan.Args, func() {}
	if strings.EqualFold(req.Provider, "claude") {
		args, cleanup = configureClaudeApprovalArgs(r.aiHomeDir, r.approvalCallbackURL, req.RunID, req.ApprovalMode, args)
	}
	return startNativeStreamProcess(ctx, req, binPath, args, workDir, plan.Env, release, cleanup)
}

// Preserve the existing unprepared PTY entry point. Account-bound launches must
// use startInteractivePTYWithLaunch with the host-prepared environment instead.
func (r *execNativeTurnRunner) startInteractivePTY(
	ctx context.Context, req NativeRunRequest, binPath string, args []string, workDir string,
) (*NativeRunHandle, error) {
	return r.startInteractivePTYWithLaunch(ctx, req, binPath, args, workDir, os.Environ(), nil)
}

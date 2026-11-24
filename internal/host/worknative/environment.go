package worknative

import (
	"context"
	"errors"
	"net/http"
	"os"
	"runtime"
	"sort"
	"strings"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/providerlaunch"
	"github.com/madou1217/ai_home/application/providerruntime"
	"github.com/madou1217/ai_home/internal/runtime/chatruntime"
)

func scopedBase(home string) map[string]string {
	source := make(map[string]string)
	for _, item := range os.Environ() {
		name, value, ok := strings.Cut(item, "=")
		if !ok {
			continue
		}
		if runtime.GOOS == "windows" {
			name = strings.ToUpper(name)
		}
		source[name] = value
	}
	return providerruntime.BuildHostScopedBaseEnv(providerruntime.StripAccountScopedEnv(source), home)
}
func applyPatch(env map[string]string, patch providerlaunch.EnvironmentPatch) {
	for _, name := range patch.UnsetNames() {
		delete(env, environmentKey(name))
	}
	for name, value := range patch.RevealSet() {
		env[environmentKey(name)] = value
	}
}
func environmentKey(name string) string {
	if runtime.GOOS == "windows" {
		return strings.ToUpper(name)
	}
	return name
}
func environmentSlice(env map[string]string) []string {
	keys := make([]string, 0, len(env))
	for k := range env {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := make([]string, 0, len(keys))
	for _, k := range keys {
		out = append(out, k+"="+env[k])
	}
	return out
}
func unavailable() error {
	return chatruntime.NewError("native_launch_preparer_unavailable", http.StatusServiceUnavailable, nil)
}
func selectionError(err error) error {
	switch {
	case errors.Is(err, accountapp.ErrAccountNotFound):
		return chatruntime.NewError("native_account_not_found", http.StatusNotFound, nil)
	case errors.Is(err, accountapp.ErrLaunchSelectionDisabled):
		return chatruntime.NewError("native_account_disabled", http.StatusConflict, nil)
	case errors.Is(err, accountapp.ErrLaunchSelectionProviderMismatch):
		return chatruntime.NewError("native_account_provider_mismatch", http.StatusUnprocessableEntity, nil)
	default:
		return chatruntime.NewError("native_account_unavailable", http.StatusUnprocessableEntity, nil)
	}
}
func (s *Service) gatewayTarget() (providerlaunch.GatewayTarget, error) {
	if s.opts.GatewayKey == nil {
		return providerlaunch.GatewayTarget{}, unavailable()
	}
	endpoint, err := providerlaunch.NewGatewayEndpoint(s.opts.GatewayURL, s.opts.GatewayKey())
	if err != nil {
		return providerlaunch.GatewayTarget{}, unavailable()
	}
	target, err := providerlaunch.NewGatewayTarget(endpoint, "")
	if err != nil {
		return providerlaunch.GatewayTarget{}, unavailable()
	}
	return target, nil
}

// CodexGatewayAppServer returns the app-server argv and environment for the
// Codex gateway runtime. The Codex driver owns its own long-lived app-server,
// so it must receive the same model_provider overrides and client key as the
// one-shot gateway launch; otherwise it falls back to official auth and 401s.
func (s *Service) CodexGatewayAppServer() ([]string, []string, error) {
	if s == nil {
		return nil, nil, unavailable()
	}
	strategy, ok := s.gateways["codex"]
	if !ok {
		return nil, nil, unavailable()
	}
	target, err := s.gatewayTarget()
	if err != nil {
		return nil, nil, err
	}
	result, err := strategy.Build(target)
	if err != nil {
		return nil, nil, unavailable()
	}
	args := []string{"app-server", "--listen", "stdio://", "-c", "thread_unload_delay_secs=0"}
	args = append(args, result.Arguments()...)
	env := scopedBase(s.opts.HostHomeDir)
	applyPatch(env, result.Environment())
	return args, environmentSlice(env), nil
}

func (s *Service) prepareGateway(ctx context.Context, req chatruntime.NativeLaunchRequest) (chatruntime.NativeLaunchPlan, error) {
	if err := ctx.Err(); err != nil {
		return chatruntime.NativeLaunchPlan{}, err
	}
	strategy, ok := s.gateways[req.Target.Provider]
	if !ok {
		return chatruntime.NativeLaunchPlan{}, unavailable()
	}
	target, err := s.gatewayTarget()
	if err != nil {
		return chatruntime.NativeLaunchPlan{}, err
	}
	result, err := strategy.Build(target)
	if err != nil || !validWorkCommand(req.Target.Provider, req.CommandName, result.Binary()) {
		return chatruntime.NativeLaunchPlan{}, unavailable()
	}
	// Gateway arguments use the same strategy merge contract as the CLI; these
	// currently have no forced argv for Claude, but keep the generic insertion.
	args := append(result.Arguments(), req.Args...)
	env := scopedBase(s.opts.HostHomeDir)
	applyPatch(env, result.Environment())
	env["AIH_PROVIDER_ACCOUNT_REF"] = chatruntime.GatewayRuntimeScope
	return chatruntime.NativeLaunchPlan{Target: req.Target, CommandName: req.CommandName, BinaryName: result.Binary(), Args: args, Env: environmentSlice(env)}, nil
}

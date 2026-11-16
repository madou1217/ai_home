package chatruntime

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"path/filepath"
	"runtime"
	"strings"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/internal/runtime/providercli/sessionchat"
)

const (
	NativeExecutionAccountNative          = "account-native"
	NativeExecutionGateway                = "gateway"
	NativeClientProtocolAGYStreamJSON     = "agy-stream-json"
	NativeClientProtocolHeadlessStream    = "headless-stream"
	NativeClientProtocolPTY               = "pty"
	NativeClientProtocolAnthropicMessages = string(inference.ClientProtocolAnthropicMessages)
)

// NativeExecutionDescriptor is safe for catalogs: no credentials, environment,
// argv or projection artifacts. Provider identifies the CLI that will run.
type NativeExecutionDescriptor struct {
	Mode           string
	Provider       string
	AccountRef     string
	ClientProtocol string
}

// NativeLaunchPreparer is supplied by the composition root. GetTarget only reads
// routing metadata; Prepare reuses providerlaunch/accountprojection and must
// reject stale or mismatched targets. Preparation failures are host-cleaned.
type NativeLaunchPreparer interface {
	GetTarget(ctx context.Context, provider, accountRef string) (NativeExecutionDescriptor, error)
	Prepare(ctx context.Context, request NativeLaunchRequest) (NativeLaunchPlan, error)
}

type NativeLaunchRequest struct {
	Target      NativeExecutionDescriptor
	CommandName string
	Args        []string `json:"-"`
}

// Env is the complete child environment, not a patch. Release includes Capture
// for credential projections and must be provided when such a projection exists.
// The runner never reads/writes credentials or opens the account database.
type NativeLaunchPlan struct {
	Target      NativeExecutionDescriptor
	CommandName string
	// BinaryName is the host-validated executable name; CommandName stays logical.
	BinaryName string
	Args       []string                    `json:"-"`
	Env        []string                    `json:"-"`
	Release    func(context.Context) error `json:"-"`
}

// Format prevents accidental diagnostic expansion of argv, tokens or closures.
func (plan NativeLaunchPlan) Format(state fmt.State, _ rune) {
	_, _ = fmt.Fprintf(state, "NativeLaunchPlan{provider=%s,command=%s,binary=%s,args=%d,env=%d}",
		plan.Target.Provider, plan.CommandName, plan.BinaryName, len(plan.Args), len(plan.Env))
}

func (request NativeLaunchRequest) Format(state fmt.State, _ rune) {
	_, _ = fmt.Fprintf(state, "NativeLaunchRequest{provider=%s,command=%s,args=%d}",
		request.Target.Provider, request.CommandName, len(request.Args))
}

func (r *execNativeTurnRunner) prepareNativeLaunch(ctx context.Context, req NativeRunRequest, command sessionchat.Command) (NativeLaunchPlan, error) {
	if r.launchPreparer == nil {
		return NativeLaunchPlan{}, NewError("native_launch_preparer_unavailable", http.StatusServiceUnavailable, nil)
	}
	provider, accountRef := sessionchat.NormalizeProvider(req.Provider), strings.TrimSpace(req.AccountRef)
	target, err := r.launchPreparer.GetTarget(ctx, provider, accountRef)
	if err != nil {
		return NativeLaunchPlan{}, err
	}
	if target.Provider != provider {
		return NativeLaunchPlan{}, NewError("native_execution_target_mismatch", http.StatusUnprocessableEntity, nil)
	}
	switch target.Mode {
	case NativeExecutionAccountNative:
		if target.AccountRef != accountRef {
			return NativeLaunchPlan{}, NewError("native_execution_target_mismatch", http.StatusUnprocessableEntity, nil)
		}
		if _, err := accountcore.ParseAccountRef(accountRef); err != nil {
			return NativeLaunchPlan{}, NewError("native_account_required", http.StatusUnprocessableEntity, nil)
		}
	case NativeExecutionGateway:
		if provider == "agy" {
			return NativeLaunchPlan{}, NewError("native_gateway_execution_unsupported", http.StatusUnprocessableEntity, nil)
		}
		if target.AccountRef != "" || !IsGatewayRuntimeScope(accountRef) {
			return NativeLaunchPlan{}, NewError("native_execution_target_mismatch", http.StatusUnprocessableEntity, nil)
		}
	default:
		return NativeLaunchPlan{}, NewError("native_execution_target_mismatch", http.StatusUnprocessableEntity, nil)
	}
	if provider == "agy" {
		if target.ClientProtocol != NativeClientProtocolAGYStreamJSON {
			return NativeLaunchPlan{}, NewError("native_execution_protocol_unsupported", http.StatusUnprocessableEntity, nil)
		}
	} else if target.Mode == NativeExecutionGateway {
		if provider != "claude" || target.ClientProtocol != NativeClientProtocolAnthropicMessages {
			return NativeLaunchPlan{}, NewError("native_gateway_execution_unsupported", http.StatusUnprocessableEntity, nil)
		}
	} else if target.ClientProtocol != NativeClientProtocolHeadlessStream && target.ClientProtocol != NativeClientProtocolPTY {
		return NativeLaunchPlan{}, NewError("native_execution_protocol_unsupported", http.StatusUnprocessableEntity, nil)
	}
	request := NativeLaunchRequest{Target: target, CommandName: command.CommandName, Args: append([]string(nil), command.Args...)}
	plan, err := r.launchPreparer.Prepare(ctx, request)
	if err != nil {
		return NativeLaunchPlan{}, err
	}
	plan.Args = append([]string(nil), plan.Args...)
	plan.Env = append([]string(nil), plan.Env...)
	plan.Release = onceNativeLaunchRelease(plan.Release)
	if plan.Target != request.Target || plan.CommandName != request.CommandName || len(plan.Args) == 0 ||
		!validNativeBinaryName(plan.BinaryName) || (provider == "agy" && plan.BinaryName != "agy") ||
		!validNativeLaunchEnvironment(plan.Env, target) {
		return NativeLaunchPlan{}, errors.Join(
			NewError("native_launch_binding_invalid", http.StatusUnprocessableEntity, nil),
			releaseNativeLaunch(ctx, plan),
		)
	}
	return plan, nil
}

// The host validates projection mode/root against LaunchSpec. The consumer also
// refuses empty/ambiguous environments and stale process-account markers.
func validNativeLaunchEnvironment(environment []string, target NativeExecutionDescriptor) bool {
	values := make(map[string]string, len(environment))
	for _, entry := range environment {
		name, value, ok := strings.Cut(entry, "=")
		if !ok || name == "" || strings.ContainsRune(entry, '\x00') {
			return false
		}
		if runtime.GOOS == "windows" {
			name = strings.ToUpper(name)
		}
		if _, duplicate := values[name]; duplicate {
			return false
		}
		values[name] = value
	}
	if !filepath.IsAbs(values["HOME"]) {
		return false
	}
	if target.Mode == NativeExecutionGateway {
		// A gateway pool is not the server process's inherited native account.
		return values["AIH_PROVIDER_ACCOUNT_REF"] == "gateway"
	}
	return values["AIH_PROVIDER_ACCOUNT_REF"] == target.AccountRef
}

// The host checks the provider's known binary aliases. The runner only accepts a
// single executable name here, never an injected path or a shell command string.
func validNativeBinaryName(name string) bool {
	return name != "" && name != "." && name != ".." &&
		!strings.ContainsAny(name, "/\\ \t\r\n\x00")
}

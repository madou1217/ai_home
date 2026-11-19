// Package codexclistartup owns the existing CLI startup argv and conditional
// cached-catalog projection. It never chooses accounts or changes native config.
package codexclistartup

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"unicode"

	"github.com/madou1217/ai_home/internal/runtime/codexappserverws"
	"github.com/madou1217/ai_home/internal/runtime/jsondocument"
)

const MaxInput = 2 << 20

var errInput = errors.New("codex_cli_startup_input_invalid")
var providerAssignment = regexp.MustCompile(`^model_provider\s*=`)
var refPattern = regexp.MustCompile(`^acct_[a-zA-Z0-9]+$`)
var sessionPattern = regexp.MustCompile(`^[A-Za-z0-9._:-]+$`)
var aliasPattern = regexp.MustCompile(`^[A-Za-z0-9._:/*=-]+$`)
var protocolPattern = regexp.MustCompile(`^[a-z][a-z0-9_]{0,63}$`)

type environment struct {
	hasAPIKey                                          bool
	baseURL, gatewayRef, sessionKey, modelAlias, flags string
	codexHome, home, userProfile                       string
}
type request struct {
	authMode, aiHomeDir string
	args                []string
	env                 environment
}
type Result struct {
	Version int      `json:"version"`
	Args    []string `json:"args"`
}

func trim(s string) string {
	return strings.TrimFunc(s, func(r rune) bool { return unicode.IsSpace(r) || r == '\ufeff' })
}

// Decode exact field names instead of encoding/json's case-insensitive struct
// aliases. jsondocument also rejects duplicates, bad Unicode and trailing JSON.
func decode(raw []byte) (request, error) {
	var out request
	if len(raw) > MaxInput {
		return out, errInput
	}
	obj, err := jsondocument.Object(raw)
	if err != nil || len(obj) != 5 || obj["version"] != json.Number("1") {
		return out, errInput
	}
	var ok bool
	out.authMode, ok = obj["authMode"].(string)
	if !ok {
		return out, errInput
	}
	switch out.authMode {
	case "apikey", "native-apikey", "oauth", "passthrough", "unavailable":
	default:
		return out, errInput
	}
	out.aiHomeDir, ok = obj["aiHomeDir"].(string)
	if !ok || strings.ContainsRune(out.aiHomeDir, 0) {
		return out, errInput
	}
	args, ok := obj["args"].([]any)
	if !ok || len(args) > 4096 {
		return out, errInput
	}
	out.args = make([]string, 0, len(args))
	total := 0
	for _, arg := range args {
		s, valid := arg.(string)
		if !valid || strings.ContainsRune(s, 0) {
			return out, errInput
		}
		total += len(s)
		if total > 1<<20 {
			return out, errInput
		}
		out.args = append(out.args, s)
	}
	env, ok := obj["environment"].(map[string]any)
	if !ok || len(env) != 9 {
		return out, errInput
	}
	out.env.hasAPIKey, ok = env["hasApiKey"].(bool)
	if !ok {
		return out, errInput
	}
	for key, target := range map[string]*string{"baseUrl": &out.env.baseURL, "gatewayAccountRef": &out.env.gatewayRef, "sessionKey": &out.env.sessionKey, "modelAlias": &out.env.modelAlias, "flags": &out.env.flags, "codexHome": &out.env.codexHome, "home": &out.env.home, "userProfile": &out.env.userProfile} {
		s, valid := env[key].(string)
		if !valid || strings.ContainsRune(s, 0) {
			return out, errInput
		}
		*target = s
	}
	return out, nil
}

// Compile keeps the old startup policy, including its intentionally narrow argv
// recognition. Configuration/cache read errors skip projection; output errors do
// not become success. No service-tier downgrade is inferred from a stale cache.
func Compile(ctx context.Context, raw []byte) (Result, error) {
	r, err := decode(raw)
	if err != nil {
		return Result{}, err
	}
	if err = ctx.Err(); err != nil {
		return Result{}, errors.New("codex_cli_startup_cancelled")
	}
	policy := []string{"-c", "suppress_unstable_features_warning=true", "-c", "check_for_update_on_startup=false"}
	explicitProvider := hasProvider(r.args)
	if r.authMode == "apikey" && r.env.gatewayRef != "" && !explicitProvider {
		policy = providerArgs(r.env)
	}
	if (r.authMode == "oauth" || r.authMode == "native-apikey") && !explicitProvider && !explicitTransport(r.args) {
		policy = append(policy, "-c", "model_provider=openai")
		if r.authMode == "native-apikey" && r.env.baseURL != "" {
			policy = append(policy, "-c", "openai_base_url="+r.env.baseURL)
		}
	}
	if r.authMode == "apikey" {
		projection, err := projectCatalog(ctx, r)
		if err != nil {
			return Result{}, err
		}
		policy = append(policy, projection...)
	}
	args := make([]string, 0, len(r.args)+len(policy))
	if len(r.args) > 0 && (trim(r.args[0]) == "exec" || trim(r.args[0]) == "resume" || trim(r.args[0]) == "app-server") {
		args = append(args, r.args[0])
		args = append(args, policy...)
		args = append(args, r.args[1:]...)
	} else {
		args = append(args, policy...)
		args = append(args, r.args...)
	}
	return Result{Version: 1, Args: args}, nil
}

func hasProvider(args []string) bool {
	for i, raw := range args {
		arg := trim(raw)
		if strings.HasPrefix(arg, "--config=") && providerAssignment.MatchString(strings.TrimPrefix(arg, "--config=")) {
			return true
		}
		if (arg == "-c" || arg == "--config") && i+1 < len(args) && providerAssignment.MatchString(trim(args[i+1])) {
			return true
		}
	}
	return false
}
func explicitTransport(args []string) bool {
	for _, arg := range args {
		switch arg {
		case "--remote", "--profile", "-p", "--oss", "--local-provider":
			return true
		}
		for _, prefix := range []string{"--remote=", "--profile=", "--local-provider=", "-cmodel_provider="} {
			if strings.HasPrefix(arg, prefix) {
				return true
			}
		}
	}
	return false
}
func providerArgs(env environment) []string {
	base := trim(env.baseURL)
	if !env.hasAPIKey && base == "" {
		return nil
	}
	values := []string{"suppress_unstable_features_warning=true", "check_for_update_on_startup=false", "model_provider=aih_server"}
	if base != "" {
		values = append(values, "model_providers.aih_server.base_url="+base)
	}
	values = append(values, "model_providers.aih_server.wire_api=responses")
	for _, pin := range []struct {
		key, value string
		pattern    *regexp.Regexp
	}{{"X-Account-Ref", trim(env.gatewayRef), refPattern}, {"X-Session-Id", trim(env.sessionKey), sessionPattern}, {"X-Aih-Model-Alias", trim(env.modelAlias), aliasPattern}} {
		if pin.pattern.MatchString(pin.value) {
			values = append(values, "model_providers.aih_server.http_headers."+pin.key+"="+pin.value)
		}
	}
	flags := codexappserverws.ParseCodexFlags(env.flags)
	if protocol := trim(flags["upstreamProtocol"]); protocolPattern.MatchString(protocol) {
		values = append(values, "model_providers.aih_server.http_headers.X-Aih-Upstream-Protocol="+protocol)
	}
	// 跨 Provider harness 的推理归属声明；旧值 node 统一归一到 go（Go 是唯一推理承接方）。
	if owner := flags["routeOwner"]; owner == "go" || owner == "node" {
		values = append(values, "model_providers.aih_server.http_headers.X-Aih-Route-Owner=go")
	}
	args := make([]string, 0, len(values)*2)
	for _, value := range values {
		args = append(args, "-c", value)
	}
	return args
}

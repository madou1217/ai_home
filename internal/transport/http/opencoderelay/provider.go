// Package opencoderelay implements OpenCode's official OpenAI-compatible API
// relay. It deliberately accepts only native API-key credentials: OAuth and
// CLI/free-tier flows retain their Node-owned semantics.
package opencoderelay

import (
	"encoding/json"
	"strings"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/transport/http/relaycore"
)

const (
	ProviderID          = "opencode"
	GoBaseURL           = "https://opencode.ai/zen/go/v1"
	ZenBaseURL          = "https://opencode.ai/zen/v1"
	ChatCompletionsPath = "/chat/completions"
)

// Provider is the account/model-aware OpenCode relay variant.
type Provider struct {
	relaycore.BaseProvider
	modelPrefix string
}

var _ relaycore.Provider = Provider{}

// NewProvider creates the default OpenCode Go endpoint variant.
func NewProvider() Provider {
	return Provider{BaseProvider: relaycore.NewBaseProvider(ProviderID, GoBaseURL+ChatCompletionsPath)}
}

func (provider Provider) Resolve(input relaycore.ResolveInput) (relaycore.Provider, bool) {
	if !strings.EqualFold(strings.TrimSpace(input.ProviderID), ProviderID) {
		return nil, false
	}
	resolved := provider
	model := strings.ToLower(strings.TrimSpace(input.ModelID.String()))
	if strings.HasPrefix(model, "opencode/") || strings.HasPrefix(model, "zen/") {
		resolved.modelPrefix = "opencode/"
		resolved.BaseProvider = relaycore.NewBaseProvider(ProviderID, ZenBaseURL+ChatCompletionsPath)
	} else {
		resolved.modelPrefix = "opencode-go/"
		resolved.BaseProvider = relaycore.NewBaseProvider(ProviderID, GoBaseURL+ChatCompletionsPath)
	}
	return resolved, true
}

func (provider Provider) AccessToken(credential accountapp.Credential) (string, error) {
	native, ok := credential.(*accountcore.NativeCredential)
	if !ok || native == nil || native.ProviderID() != ProviderID || native.AuthKind() != "api-key" {
		return "", relaycore.ErrUnsupportedCredential
	}
	fields, ok := relaycore.DecodeRawObject(native.Payload())
	if !ok {
		return "", relaycore.ErrUnsupportedCredential
	}
	auth, ok := relaycore.DecodeRawObject(fields["auth"])
	if !ok {
		auth = fields
	}
	preferred := []string{"opencode-go", "opencode"}
	if provider.modelPrefix == "opencode/" {
		preferred = []string{"opencode", "opencode-go"}
	}
	for _, name := range preferred {
		record, ok := relaycore.DecodeRawObject(auth[name])
		if !ok {
			continue
		}
		if typ, ok := relaycore.RawString(record["type"]); ok && typ != "" && !strings.EqualFold(strings.TrimSpace(typ), "api") && !strings.EqualFold(strings.TrimSpace(typ), "api-key") {
			continue
		}
		if key, ok := relaycore.RawString(record["key"]); ok && strings.TrimSpace(key) != "" {
			return strings.TrimSpace(key), nil
		}
	}
	return "", relaycore.ErrUnsupportedCredential
}

// RewriteRequest removes the provider namespace before sending to OpenCode.
func (provider Provider) RewriteRequest(body []byte) (relaycore.RewriteResult, error) {
	fields, ok := relaycore.DecodeRawObject(body)
	if !ok {
		return relaycore.RewriteResult{}, relaycore.ErrInvalidRequestBody
	}
	model, ok := relaycore.RawString(fields["model"])
	if !ok || strings.TrimSpace(model) == "" {
		return relaycore.RewriteResult{}, relaycore.ErrInvalidRequestBody
	}
	modelJSON, err := json.Marshal(stripModelPrefix(model))
	if err != nil {
		return relaycore.RewriteResult{}, err
	}
	fields["model"] = modelJSON
	rewritten, err := json.Marshal(fields)
	if err != nil {
		return relaycore.RewriteResult{}, err
	}
	return relaycore.RewriteResult{Body: rewritten}, nil
}

func stripModelPrefix(model string) string {
	value := strings.TrimSpace(model)
	lower := strings.ToLower(value)
	for _, prefix := range []string{"opencode-go/", "opencode/", "zen/", "go/"} {
		if strings.HasPrefix(lower, prefix) {
			return value[len(prefix):]
		}
	}
	return value
}

// SupportsCredential is shared by the account transport policy and model discovery.
func SupportsCredential(credential accountapp.Credential) bool {
	native, ok := credential.(*accountcore.NativeCredential)
	return ok && native != nil && native.ProviderID() == ProviderID && native.AuthKind() == "api-key"
}

// AccessTokenFromCredential exposes the same conservative extraction used by
// the relay and model discovery.
func AccessTokenFromCredential(credential accountapp.Credential) (string, error) {
	return NewProvider().AccessToken(credential)
}

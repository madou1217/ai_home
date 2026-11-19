package providerlaunch

import (
	"errors"
	"strings"
	"unicode"

	"github.com/madou1217/ai_home/core/providers"
)

var errModelAlias = errors.New("--model-alias 参数无效：使用 <target> 或 <source>=<target>，目标须为裸模型 ID")

// ModelAlias is a session-local override, not a persistent catalog alias.
type ModelAlias struct{ source, target string }

func (alias ModelAlias) Enabled() bool  { return alias.source != "" && alias.target != "" }
func (alias ModelAlias) Source() string { return alias.source }
func (alias ModelAlias) Target() string { return alias.target }
func (alias ModelAlias) Resolve(model string) string {
	if alias.Enabled() && (alias.source == "*" || strings.EqualFold(alias.source, model)) {
		return alias.target
	}
	return model
}

// parseClaudeModelAlias only sees tokens before the native escape marker.
func parseClaudeModelAlias(args []string) ([]string, ModelAlias, error) {
	forward := make([]string, 0, len(args))
	var raw, model string
	for index := 0; index < len(args); index++ {
		arg := args[index]
		if arg == "--model-alias" || strings.HasPrefix(arg, "--model-alias=") {
			if arg == "--model-alias" {
				index++
				if index >= len(args) || strings.HasPrefix(args[index], "-") {
					return nil, ModelAlias{}, errModelAlias
				}
				raw = strings.TrimSpace(args[index])
			} else {
				raw = strings.TrimSpace(strings.TrimPrefix(arg, "--model-alias="))
			}
			if raw == "" {
				return nil, ModelAlias{}, errModelAlias
			}
			continue
		}
		forward = append(forward, arg)
		if ClaudeOptionRequiresValue(arg) && index+1 < len(args) {
			index++
			forward = append(forward, args[index])
			if arg == "--model" {
				model = args[index]
			}
		} else if strings.HasPrefix(arg, "--model=") {
			model = strings.TrimPrefix(arg, "--model=")
		}
	}
	if raw == "" {
		return forward, ModelAlias{}, nil
	}
	source, target, explicit := strings.Cut(raw, "=")
	if !explicit {
		target, source = raw, model
	}
	source, target = strings.TrimSpace(source), strings.TrimSpace(target)
	if source == "" {
		source = "*"
	}
	for _, value := range []string{source, target} {
		if value == "" || strings.ContainsFunc(value, func(r rune) bool {
			return unicode.IsSpace(r) || unicode.IsControl(r) || r == '='
		}) {
			return nil, ModelAlias{}, errModelAlias
		}
	}
	// Claude expands shortcuts before sending the request. A literal shortcut
	// cannot safely match the wire model (which may depend on host settings).
	switch strings.TrimSuffix(strings.ToLower(source), "[1m]") {
	case "sonnet", "opus", "haiku", "default", "opusplan", "best", "fable":
		return nil, ModelAlias{}, errors.New("--model-alias 的 source 不能使用 Claude 模型快捷名；请使用真实模型 ID 或显式 *=<target>")
	}
	// Never silently interpret a provider/account pin as a literal model. The
	// existing relay prefix is the supported explicit account selection contract.
	if prefix, _, found := strings.Cut(target, "."); found {
		catalog, err := providers.NewCatalog(providers.BuiltinManifest())
		if err != nil {
			return nil, ModelAlias{}, err
		}
		if _, known := catalog.CanonicalID(prefix); known {
			return nil, ModelAlias{}, errors.New("Go Claude --model-alias 请使用裸模型 ID；固定 Provider/账号请使用 aih claude relay <provider> <account_id>")
		}
	}
	return forward, ModelAlias{source: source, target: target}, nil
}

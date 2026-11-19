package harnessrun

import (
	"context"
	"path/filepath"
	"strings"
)

const (
	piProviderID     = "aih"
	piExtensionFile  = "aih-model-refresh.ts"
	piExtensionEntry = "extensions"
)

type piCompat struct {
	SupportsDeveloperRole   bool   `json:"supportsDeveloperRole"`
	SupportsReasoningEffort bool   `json:"supportsReasoningEffort"`
	MaxTokensField          string `json:"maxTokensField"`
}

type piProviderConfig struct {
	Name    string            `json:"name"`
	BaseURL string            `json:"baseUrl"`
	API     string            `json:"api"`
	APIKey  string            `json:"apiKey"`
	Headers routeOwnerHeaders `json:"headers"`
	Compat  piCompat          `json:"compat"`
	Models  []piModelEntry    `json:"models"`
}

type piModelsDocument struct {
	Providers map[string]piProviderConfig `json:"providers"`
}

// buildPiModelsDocument 复刻 buildPiModelsDocument。
//
// apiKey 同时写 `$OPENAI_API_KEY` 字面量并注入同名（带 $）的子进程 env：
// Pi <=0.77 按整串查环境变量名，>=0.78 只展开 `$VAR` 模板。
func buildPiModelsDocument(baseURL string, accountRef string, models []harnessModel) piModelsDocument {
	return piModelsDocument{
		Providers: map[string]piProviderConfig{
			piProviderID: {
				Name:    "AIH Gateway",
				BaseURL: strings.TrimRight(strings.TrimSpace(baseURL), "/"),
				API:     "openai-completions",
				APIKey:  "$OPENAI_API_KEY",
				Headers: routeOwnerHeaders{
					RouteOwner: "node",
					AccountRef: strings.TrimSpace(accountRef),
				},
				Compat: piCompat{
					SupportsDeveloperRole:   false,
					SupportsReasoningEffort: false,
					MaxTokensField:          "max_tokens",
				},
				Models: buildPiModelEntries(models),
			},
		},
	}
}

func buildPiLaunchArgs(model string, nativeArgs []string) []string {
	args := []string{"--provider", piProviderID}
	if strings.TrimSpace(model) != "" {
		args = append(args, "--model", strings.TrimSpace(model))
	}
	return append(args, nativeArgs...)
}

// preparePiHarness 复刻 preparePiHarness 的文件、env 与参数。
func preparePiHarness(input prepareInput) (preparedLaunch, error) {
	models, model, err := resolveHarnessModels(input)
	if err != nil {
		return preparedLaunch{}, err
	}
	agentDir, err := resolveProjectionRoot(input.AIHomeDir, "pi", input.AccountRef)
	if err != nil {
		return preparedLaunch{}, err
	}
	extensionsDir := filepath.Join(agentDir, piExtensionEntry)
	if err := writePrivateText(filepath.Join(extensionsDir, piExtensionFile), piExtensionSource); err != nil {
		return preparedLaunch{}, err
	}
	if err := writePrivateJSON(
		filepath.Join(agentDir, "models.json"),
		buildPiModelsDocument(input.Gateway.BaseURL, input.AccountRef, models),
	); err != nil {
		return preparedLaunch{}, err
	}
	linkHostSessions(agentDir, input.HostHomeDir, []string{".pi", "agent"})

	pluginArgs, pluginErr := buildHostPluginArgs(context.Background(), input.AIHomeDir, input.HostHomeDir, "pi")
	if pluginErr != nil {
		return preparedLaunch{}, pluginErr
	}
	nativeArgs := append([]string(nil), pluginArgs...)
	nativeArgs = append(nativeArgs, input.NativeArgs...)

	return preparedLaunch{
		File: "pi",
		Args: buildPiLaunchArgs(model, nativeArgs),
		Env: map[string]string{
			"PI_CODING_AGENT_DIR": agentDir,
			"OPENAI_API_KEY":      input.Gateway.APIKey,
			"$OPENAI_API_KEY":     input.Gateway.APIKey,
		},
		Model: model,
	}, nil
}

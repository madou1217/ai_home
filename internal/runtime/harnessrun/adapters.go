package harnessrun

import (
	"context"
	"errors"
	"os"
	"strings"

	"github.com/madou1217/ai_home/application/modelmetadata"
)

// prepareInput 是三个投影适配器共享的已解析启动事实。
type prepareInput struct {
	HarnessID      string
	Provider       string
	AccountRef     string
	RequestedModel string
	NativeArgs     []string
	AIHomeDir      string
	HostHomeDir    string
	Gateway        gatewayConnection
	BinPath        string
	NodeExec       string
	BaseEnv        map[string]string
	Metadata       modelmetadata.FactsSource
}

// preparedLaunch 只保留 spawn 需要的命令与环境。
type preparedLaunch struct {
	File  string
	Args  []string
	Env   map[string]string
	Model string
}

type prepareFunc func(prepareInput) (preparedLaunch, error)

// harnessAdapters 对应 Node lib/harness/adapters.js。
//
// Go 的 core/harnesses 目前没有 adapter 字段（Node 描述符有），三个 harness
// 与适配器恰为 1:1，因此按 harness ID 注册；新增 harness 时应先把 adapter
// 合并进注册表，而不是在这里加名字分支。
var harnessAdapters = map[string]prepareFunc{
	"pi":      preparePiHarness,
	"dsh":     prepareDshHarness,
	"dsh-tui": prepareDshTuiHarness,
}

// prepareHarness 按 harness ID 选择投影适配器。
func prepareHarness(input prepareInput) (preparedLaunch, error) {
	adapter, ok := harnessAdapters[strings.ToLower(strings.TrimSpace(input.HarnessID))]
	if !ok {
		return preparedLaunch{}, errors.New("external_harness_unsupported")
	}
	if strings.TrimSpace(input.AIHomeDir) == "" {
		return preparedLaunch{}, errors.New("ai_home_dir_missing")
	}
	if strings.TrimSpace(input.Gateway.BaseURL) == "" {
		return preparedLaunch{}, errors.New("gateway_base_url_missing")
	}
	if strings.TrimSpace(input.Gateway.APIKey) == "" {
		return preparedLaunch{}, errors.New("gateway_api_key_missing")
	}
	return adapter(input)
}

// resolveHarnessModels 复刻 fetchGatewayModelCatalog → withModelMetadata →
// ensureRequestedModel → buildHarnessModelEntries → 选模型。
func resolveHarnessModels(input prepareInput) ([]harnessModel, string, error) {
	catalog, err := fetchGatewayModelCatalog(
		context.Background(),
		input.Gateway.BaseURL,
		input.Gateway.APIKey,
		input.AccountRef,
	)
	if err != nil {
		return nil, "", err
	}
	// 钉选账号的默认模型已在 Run 里按 Node pinned-default-model 口径解析；
	// RequestedModel 仍是用户显式模型或该默认值。
	launchModel := strings.TrimSpace(input.RequestedModel)
	catalog = ensureRequestedModel(catalog, launchModel, input.Provider, input.Metadata)
	models := buildHarnessModels(catalog, input.Provider, input.Metadata)
	if len(models) == 0 {
		return nil, "", errors.New("gateway_model_catalog_empty")
	}
	return models, selectLaunchModel(models, launchModel), nil
}

// firstEnvMap 把 os.Environ 转为可覆盖的 map（保持最后出现的值）。
func firstEnvMap(entries []string) map[string]string {
	env := make(map[string]string, len(entries))
	for _, entry := range entries {
		key, value, ok := strings.Cut(entry, "=")
		if !ok || key == "" {
			continue
		}
		env[key] = value
	}
	return env
}

// envSlice 把 map 转为 exec.Cmd.Env；排序不是语义要求，但稳定输出便于诊断。
func envSlice(env map[string]string) []string {
	keys := make([]string, 0, len(env))
	for key := range env {
		keys = append(keys, key)
	}
	sortStrings(keys)
	entries := make([]string, 0, len(keys))
	for _, key := range keys {
		entries = append(entries, key+"="+env[key])
	}
	return entries
}

func sortStrings(values []string) {
	for index := 1; index < len(values); index++ {
		for cursor := index; cursor > 0 && values[cursor] < values[cursor-1]; cursor-- {
			values[cursor], values[cursor-1] = values[cursor-1], values[cursor]
		}
	}
}

func mergeEnv(base map[string]string, overrides ...map[string]string) map[string]string {
	merged := make(map[string]string, len(base)+8)
	for key, value := range base {
		merged[key] = value
	}
	for _, patch := range overrides {
		for key, value := range patch {
			merged[key] = value
		}
	}
	return merged
}

// nativeCredentialEnv 与 Node run.js 的 NATIVE_CREDENTIAL_ENV 逐项一致。
var nativeCredentialEnv = []string{
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_BASE_URL",
	"OPENAI_API_KEY",
	"$OPENAI_API_KEY",
	"OPENAI_BASE_URL",
	"OPENAI_ORG_ID",
	"OPENAI_PROJECT_ID",
	"GOOGLE_API_KEY",
	"GEMINI_API_KEY",
	"GOOGLE_GENERATIVE_AI_API_KEY",
	"XAI_API_KEY",
	"DEEPSEEK_API_KEY",
	"OPENROUTER_API_KEY",
	"MOONSHOT_API_KEY",
	"Z_AI_API_KEY",
	"QWEN_API_KEY",
	"DASHSCOPE_API_KEY",
	"GROQ_API_KEY",
	"MISTRAL_API_KEY",
	"COHERE_API_KEY",
	"PERPLEXITY_API_KEY",
	"FIREWORKS_API_KEY",
	"TOGETHER_API_KEY",
	"CODEX_HOME",
	"CLAUDE_CONFIG_DIR",
	"PI_MODEL",
	"PI_PROVIDER",
}

// buildExternalHarnessEnv 剥离宿主原生凭据后合并适配器 additions。
func buildExternalHarnessEnv(base map[string]string, additions map[string]string) map[string]string {
	env := make(map[string]string, len(base)+8)
	for key, value := range base {
		env[key] = value
	}
	for _, key := range nativeCredentialEnv {
		delete(env, key)
	}
	for key, value := range additions {
		env[key] = value
	}
	return env
}

func currentProcessEnv() map[string]string {
	return firstEnvMap(os.Environ())
}

func nodePathEnv(entryPath string, existing string) map[string]string {
	nodePathEntry := resolveDshNodePath(entryPath)
	if nodePathEntry == "" {
		return map[string]string{}
	}
	current := strings.TrimSpace(existing)
	if current != "" {
		return map[string]string{"NODE_PATH": nodePathEntry + string(os.PathListSeparator) + current}
	}
	return map[string]string{"NODE_PATH": nodePathEntry}
}

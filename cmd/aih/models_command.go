package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/madou1217/ai_home/core/harnesses"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/managementapi"
	"github.com/madou1217/ai_home/internal/runtime/harnessrun"
)

const modelsCommandUsage = `用法：
  aih <provider> models [accountID|accountRef] [--json]
  aih provider models <provider> [accountID|accountRef] [--json]
  aih <harness> models [accountRef] [--json]
  aih harness <id> models [--provider <p>] [--account <n|ref>] [--json]

只读目标 Server 已缓存的模型目录；不启动原生 CLI、不刷新 Provider、不修改配置。
省略账号时查看 Provider 聚合目录或网关账号池；指定账号时只列有效模型，不混入全局别名。
Harness 视图排除纯图片输出模型；支持的 Provider/Harness 以 AIH 注册表为准。
数字账号必须带 Provider；accountRef 在目标 Server 解析归属，归属不匹配时明确报错。
连接使用 AIH_SERVER_BASE_URL 和 AIH_SERVER_MANAGEMENT_KEY（沿用本机管理密钥读取）。
`

type modelsInvocation struct {
	scope harnessrun.ModelsScope
	json  bool
	help  bool
	form  string
}

// runModelsCommand must run before native/harness launch routing. Only an
// explicit models verb is intercepted; `aih pi -- models` remains an escape.
func runModelsCommand(ctx context.Context, arguments []string, runtime commandRuntime) (bool, error) {
	invocation, handled, err := parseModelsInvocation(arguments)
	if !handled {
		return false, nil
	}
	if err != nil {
		_, _ = fmt.Fprint(runtime.stderr, modelsCommandUsage)
		return true, err
	}
	if invocation.help {
		_, _ = fmt.Fprint(runtime.stdout, modelsCommandUsage)
		return true, nil
	}
	key := lookupOrDefault(runtime.lookupEnv, "AIH_SERVER_MANAGEMENT_KEY", "")
	if key == "" {
		return true, fmt.Errorf("models 需要 AIH_SERVER_MANAGEMENT_KEY")
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	result, err := harnessrun.ListModels(ctx, runtime.managementAPI, managementapi.Config{
		BaseURL:       resolveManagementBaseURL(runtime),
		ManagementKey: key,
	}, invocation.scope)
	if err != nil {
		return true, fmt.Errorf("读取 Server 模型目录失败: %w", err)
	}
	if invocation.json {
		encoder := json.NewEncoder(runtime.stdout)
		encoder.SetEscapeHTML(false)
		return true, encoder.Encode(result)
	}
	writeModelsList(runtime.stdout, result)
	return true, nil
}

func parseModelsInvocation(arguments []string) (modelsInvocation, bool, error) {
	invocation := modelsInvocation{}
	if len(arguments) < 2 {
		return invocation, false, nil
	}
	var rest []string
	switch {
	case arguments[0] == "provider" && arguments[1] == "models":
		invocation.form = "provider"
		if len(arguments) < 3 {
			return invocation, true, fmt.Errorf("models 需要 <provider>")
		}
		if isRootHelp(arguments[2]) {
			invocation.help = true
			return invocation, true, nil
		}
		invocation.scope.Provider, rest = arguments[2], arguments[3:]
	case arguments[0] == "harness" && len(arguments) >= 3 && arguments[2] == "models":
		invocation.form = "harness"
		invocation.scope.Harness, rest = arguments[1], arguments[3:]
	case arguments[1] == "models":
		if harness, found := harnesses.Get(arguments[0]); found {
			invocation.form = "shorthand"
			invocation.scope.Harness = harness.ID
		} else if isRegisteredProvider(arguments[0]) {
			invocation.form = "provider"
			invocation.scope.Provider = arguments[0]
		} else {
			return invocation, false, nil
		}
		rest = arguments[2:]
	default:
		return invocation, false, nil
	}
	if invocation.scope.Harness != "" {
		if _, found := harnesses.Get(invocation.scope.Harness); !found {
			return invocation, true, fmt.Errorf("未知 harness：%s", invocation.scope.Harness)
		}
	}
	for index := 0; index < len(rest); index++ {
		token := rest[index]
		switch {
		case token == "--help" || token == "-h":
			invocation.help = true
		case token == "--json":
			invocation.json = true
		case invocation.form == "harness" && (token == "--provider" || token == "--account" || strings.HasPrefix(token, "--provider=") || strings.HasPrefix(token, "--account=")):
			flag, value, inline := strings.Cut(token, "=")
			if !inline {
				if index+1 >= len(rest) || strings.HasPrefix(rest[index+1], "-") {
					return invocation, true, fmt.Errorf("%s 缺少值", flag)
				}
				index++
				value = rest[index]
			}
			if strings.TrimSpace(value) == "" {
				return invocation, true, fmt.Errorf("%s 缺少值", flag)
			}
			destination := &invocation.scope.Provider
			if flag == "--account" {
				destination = &invocation.scope.Account
			}
			if *destination != "" {
				return invocation, true, fmt.Errorf("%s 不能重复", flag)
			}
			*destination = value
		case !strings.HasPrefix(token, "-") && invocation.form != "harness" && invocation.scope.Account == "":
			invocation.scope.Account = token
		default:
			return invocation, true, fmt.Errorf("未知 models 参数：%s", token)
		}
	}
	if invocation.scope.Provider != "" {
		catalog, err := providers.NewCatalog(providers.BuiltinManifest())
		if err != nil {
			return invocation, true, err
		}
		canonical, found := catalog.CanonicalID(invocation.scope.Provider)
		if !found {
			return invocation, true, fmt.Errorf("未知 Provider：%s", invocation.scope.Provider)
		}
		invocation.scope.Provider = canonical
	}
	if invocation.scope.Account != "" {
		allowNumeric := invocation.form != "shorthand" && invocation.scope.Provider != ""
		if !harnessrun.ModelsAccountValid(invocation.scope.Account, allowNumeric) {
			return invocation, true, fmt.Errorf("models 账号需要 accountRef；Provider 视图或显式 --provider 也接受正整数 ID")
		}
	}
	return invocation, true, nil
}

func writeModelsList(output io.Writer, result harnessrun.ModelsList) {
	provider := result.Provider
	if provider == "" {
		provider = "pool"
	}
	scope := provider
	if result.Harness != "" {
		scope = result.Harness + " / " + provider
	}
	if result.AccountRef != "" {
		scope += " / " + result.AccountRef
	}
	_, _ = fmt.Fprintf(output, "模型（%s，共 %d 个）：\n", scope, len(result.Data))
	if len(result.Data) == 0 {
		_, _ = fmt.Fprintln(output, "当前没有可见模型。")
	} else {
		writer := tabwriter.NewWriter(output, 0, 4, 2, ' ', 0)
		_, _ = fmt.Fprintln(writer, "MODEL\tPROVIDERS\tINPUT\tOUTPUT\tREASONING")
		for _, model := range result.Data {
			input, out := []string(nil), []string(nil)
			if model.Modalities != nil {
				input, out = model.Modalities.Input, model.Modalities.Output
			}
			_, _ = fmt.Fprintf(writer, "%s\t%s\t%s\t%s\t%s\n", model.ID, modelListLabel(model.Providers), modelListLabel(input), modelListLabel(out), modelListLabel(model.ReasoningEfforts))
		}
		_ = writer.Flush()
	}
	_, _ = fmt.Fprintln(output, "来源：目标 Server 缓存目录（只读；未刷新 Provider，未启动原生 CLI）。")
}

func modelListLabel(values []string) string {
	if len(values) == 0 {
		return "-"
	}
	return strings.Join(values, ",")
}

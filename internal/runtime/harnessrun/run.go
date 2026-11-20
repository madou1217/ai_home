package harnessrun

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/madou1217/ai_home/core/harnesses"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/modelmetadata/modelsdev"
)

// Runtime 隔离环境、家目录、终端 I/O 与工作目录，便于 cmd/aih 注入。
type Runtime struct {
	LookupEnv   func(string) (string, bool)
	UserHomeDir func() (string, error)
	Stdin       io.Reader
	Stdout      io.Writer
	Stderr      io.Writer
	WorkDir     func() (string, error)
}

// normalizeRuntime 补齐未注入的端口：调用方只关心自己要替换的那几项。
func normalizeRuntime(rt Runtime) Runtime {
	if rt.LookupEnv == nil {
		rt.LookupEnv = os.LookupEnv
	}
	if rt.UserHomeDir == nil {
		rt.UserHomeDir = os.UserHomeDir
	}
	if rt.Stdin == nil {
		rt.Stdin = os.Stdin
	}
	if rt.Stdout == nil {
		rt.Stdout = os.Stdout
	}
	if rt.Stderr == nil {
		rt.Stderr = os.Stderr
	}
	if rt.WorkDir == nil {
		rt.WorkDir = os.Getwd
	}
	return rt
}

// Run 执行一次 `aih harness`，返回进程退出码。
//
// 所有用户可见错误都在这里写到 stderr（与 Node 的消息逐字一致），
// 因此 cmd/aih 只需把非零码转成静默退出。
func Run(arguments []string, rt Runtime) int {
	rt = normalizeRuntime(rt)

	views := harnessViews()
	parsed := parseHarnessArgs(arguments)
	if parsed.Help {
		_, _ = fmt.Fprint(rt.Stdout, helpText)
		return 0
	}
	if parsed.List || parsed.HarnessID == "" {
		_, _ = fmt.Fprintf(rt.Stdout, "%s\n", formatHarnessList(views))
		return 0
	}
	harness, found := harnesses.Get(parsed.HarnessID)
	if !found {
		_, _ = fmt.Fprintf(rt.Stderr, "[aih] 未知 harness：%s\n%s\n", parsed.HarnessID, formatHarnessList(views))
		return 1
	}
	// `aih harness <id>` 的合同要求显式 --provider：数字账号只在某个 Provider 内
	// 唯一，没有 Provider 无法解释。accountRef（acct_…）自带归属，可以省略。
	// 两者都缺省时是账号池模式（Node 简写 aih <harness> 的语义），由网关池承接。
	if parsed.Provider == "" && parsed.Account != "" && !isAccountRef(parsed.Account) {
		_, _ = fmt.Fprintln(rt.Stderr, "[aih] 需要 --provider <p>（这个 harness 要用哪个 Provider 的账号跑）")
		return 1
	}

	catalog, catalogErr := providers.NewCatalog(providers.BuiltinManifest())
	if catalogErr != nil {
		rootRouterFailed(rt, catalogErr)
		return 1
	}
	aiHomeDir := resolveAIHomeDir(rt)
	hostHomeDir := resolveHostHomeDir(rt)
	selection := accountSelection{}
	if parsed.Provider != "" || parsed.Account != "" {
		var selectionError string
		selection, selectionError = selectAccount(
			context.Background(), aiHomeDir, catalog, parsed.Provider, parsed.Account,
		)
		if selectionError != "" {
			hint := ""
			if selectionError == "account_not_found" {
				hint = fmt.Sprintf("（%s 下没有可用账号；先 aih %s login）", parsed.Provider, parsed.Provider)
			}
			_, _ = fmt.Fprintf(rt.Stderr, "[aih] 选账号失败：%s%s\n", selectionError, hint)
			return 1
		}
	}
	// accountRef 钉选时归属以账号事实为准；Provider 只用于展示与模型过滤。
	// 池模式（两者都缺省）下 effectiveProvider 保持空串：网关按账号池承接，
	// 展示层再回落成 "pool"，不把展示词写进启动合同。
	effectiveProvider := parsed.Provider
	if effectiveProvider == "" {
		effectiveProvider = selection.Provider
	}
	providerLabel := effectiveProvider
	if providerLabel == "" {
		providerLabel = "pool"
	}

	// `--model-alias`：harness 的模型在启动时定死，因此等价于直接按目标模型启动。
	launchModel, aliasRule, aliasOK := resolveHarnessAliasLaunchModel(
		parsed.Model, parsed.ModelAlias, func(provider string) bool { return catalog.Contains(provider) },
	)
	if !aliasOK {
		_, _ = fmt.Fprintf(rt.Stderr, "[aih] --model-alias 的值无法解析：%s\n", parsed.ModelAlias)
		return 1
	}
	if aliasRule != nil {
		source := aliasRule.Source
		if source == "*" {
			source = "任意模型"
		}
		_, _ = fmt.Fprintf(
			rt.Stderr,
			"\x1b[33m[aih]\x1b[0m --model-alias：本次启动改用 %s（%s → %s）\n",
			aliasRule.Target, source, aliasRule.Target,
		)
	}

	plan := planOutput{
		OK:           true,
		Harness:      harness.ID,
		Label:        harness.Label,
		Provider:     providerLabel,
		AccountRef:   selection.AccountRef,
		CLIAccountID: selection.CLIAccountID,
		Model:        launchModel,
		NativeArgs:   append([]string{}, parsed.NativeArgs...),
	}
	if parsed.JSON {
		writePlanJSON(rt.Stdout, plan)
		return 0
	}
	if launchModel == "" {
		launchModel = resolvePinnedHarnessDefaultModel(context.Background(), aiHomeDir, selection.AccountRef)
	}

	accountLabel := ""
	if selection.CLIAccountID != "" {
		accountLabel = " #" + selection.CLIAccountID
	}
	_, _ = fmt.Fprintf(
		rt.Stdout,
		"\x1b[36m[aih]\x1b[0m harness %s ← %s%s (%s…)\n",
		harness.ID, providerLabel, accountLabel, accountRefPrefix(selection.AccountRef),
	)

	gateway, gatewayErr := readGatewayConnection(context.Background(), aiHomeDir, rt.LookupEnv, selection.AccountRef)
	if gatewayErr != nil {
		rootRouterFailed(rt, gatewayErr)
		return 1
	}
	if strings.TrimSpace(gateway.BaseURL) == "" || strings.TrimSpace(gateway.APIKey) == "" {
		harnessStartupFailed(rt, "AIH gateway connection is not configured")
		return 1
	}

	baseEnv := currentProcessEnv()
	nodeExec := ""
	if harness.ID != "pi" {
		// 只有真正执行 JS 入口的 DSH 家族需要 Node；pi 由 PATH 直接解析。
		nodeExec, _ = resolveNodeExecutable(rt.LookupEnv)
	}
	binaryPath := ""
	if harness.ID != "pi" {
		binaryPath = resolveHarnessBinaryPath(harness.BinaryName)
	}
	var metadata *modelsdev.Index
	if index, err := modelsdev.New(); err == nil {
		metadata = index
	}

	prepared, prepareErr := prepareHarness(prepareInput{
		HarnessID:      harness.ID,
		Provider:       effectiveProvider,
		AccountRef:     selection.AccountRef,
		RequestedModel: launchModel,
		NativeArgs:     parsed.NativeArgs,
		AIHomeDir:      aiHomeDir,
		HostHomeDir:    hostHomeDir,
		Gateway:        gateway,
		BinPath:        binaryPath,
		NodeExec:       nodeExec,
		BaseEnv:        baseEnv,
		Metadata:       metadata,
	})
	if prepareErr != nil {
		rootRouterFailed(rt, prepareErr)
		return 1
	}

	workDir := ""
	if dir, err := rt.WorkDir(); err == nil {
		workDir = dir
	}
	exitCode, message, spawnOK := spawnPrepared(prepared, rt, workDir, baseEnv)
	if !spawnOK {
		harnessStartupFailed(rt, message)
		return 1
	}
	return exitCode
}

// planOutput 字段顺序与 Node JSON.stringify(plan, null, 2) 一致。
type planOutput struct {
	OK           bool     `json:"ok"`
	Harness      string   `json:"harness"`
	Label        string   `json:"label"`
	Provider     string   `json:"provider"`
	AccountRef   string   `json:"accountRef"`
	CLIAccountID string   `json:"cliAccountId"`
	Model        string   `json:"model"`
	NativeArgs   []string `json:"nativeArgs"`
}

func writePlanJSON(writer io.Writer, plan planOutput) {
	encoder := json.NewEncoder(writer)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	_ = encoder.Encode(plan)
}

// spawnPrepared 以 inherit stdio 启动 harness，返回退出码、错误消息与是否成功启动。
func spawnPrepared(
	prepared preparedLaunch,
	rt Runtime,
	workDir string,
	baseEnv map[string]string,
) (int, string, bool) {
	file := strings.TrimSpace(prepared.File)
	if file == "" {
		return 0, "external_harness_binary_missing", false
	}
	command := exec.Command(file, prepared.Args...)
	command.Stdin = rt.Stdin
	command.Stdout = rt.Stdout
	command.Stderr = rt.Stderr
	command.Dir = workDir
	command.Env = envSlice(buildExternalHarnessEnv(baseEnv, prepared.Env))
	err := command.Run()
	if err == nil {
		return 0, "", true
	}
	var exitError *exec.ExitError
	if errors.As(err, &exitError) {
		state := exitError.ProcessState
		if state != nil && !state.Exited() {
			// Node 对任何信号都返回 130。
			return 130, "", true
		}
		code := exitError.ExitCode()
		if code < 0 {
			code = 0
		}
		return code, "", true
	}
	return 0, spawnFailureMessage(file, err), false
}

func spawnFailureMessage(file string, err error) string {
	if err == nil {
		return ""
	}
	if errors.Is(err, exec.ErrNotFound) || os.IsNotExist(err) {
		return "spawn " + file + " ENOENT"
	}
	if os.IsPermission(err) {
		return "spawn " + file + " EACCES"
	}
	text := err.Error()
	if strings.Contains(strings.ToLower(text), "executable file not found") ||
		strings.Contains(strings.ToLower(text), "no such file") {
		return "spawn " + file + " ENOENT"
	}
	return text
}

func accountRefPrefix(accountRef string) string {
	if len(accountRef) <= 11 {
		return accountRef
	}
	return accountRef[:11]
}

func harnessStartupFailed(rt Runtime, message string) {
	_, _ = fmt.Fprintf(rt.Stderr, "[aih] harness 启动失败：%s\n", message)
}

// rootRouterFailed 复刻 Node 顶层 catch 的用户可见错误行。
func rootRouterFailed(rt Runtime, err error) {
	_, _ = fmt.Fprintf(rt.Stderr, "\x1b[31m[aih] root router failed: %s\x1b[0m\n", err.Error())
}

// resolveAIHomeDir 优先级：AIH_HOME_DIR → AI_HOME → <宿主 home>/.ai_home。
func resolveAIHomeDir(rt Runtime) string {
	if value := firstEnvValue(rt.LookupEnv, "AIH_HOME_DIR", "AI_HOME"); value != "" {
		return value
	}
	return filepath.Join(resolveHostHomeDir(rt), ".ai_home")
}

// resolveHostHomeDir 与 Node lib/runtime/host-home.js 同优先级。
func resolveHostHomeDir(rt Runtime) string {
	if value := firstEnvValue(rt.LookupEnv, "AIH_HOST_HOME"); value != "" {
		return normalizeHostHome(value)
	}
	if runtime.GOOS == "windows" {
		if value := firstEnvValue(rt.LookupEnv, "USERPROFILE"); value != "" {
			return normalizeHostHome(value)
		}
		drive := firstEnvValue(rt.LookupEnv, "HOMEDRIVE")
		homePath := firstEnvValue(rt.LookupEnv, "HOMEPATH")
		if drive != "" && homePath != "" {
			return normalizeHostHome(drive + homePath)
		}
	}
	if value := firstEnvValue(rt.LookupEnv, "HOME"); value != "" {
		return normalizeHostHome(value)
	}
	if rt.UserHomeDir != nil {
		if home, err := rt.UserHomeDir(); err == nil && strings.TrimSpace(home) != "" {
			return normalizeHostHome(home)
		}
	}
	return ""
}

// normalizeHostHome 去掉误传进来的 /.codex 后缀（Node stripNestedCodexHome）。
func normalizeHostHome(value string) string {
	text := strings.TrimSpace(value)
	if text == "" {
		return ""
	}
	normalized := strings.TrimRight(strings.ReplaceAll(text, "\\", "/"), "/")
	if strings.HasSuffix(strings.ToLower(normalized), "/.codex") {
		root := normalized[:len(normalized)-len("/.codex")]
		if root != "" {
			return root
		}
	}
	return text
}

func resolveHarnessBinaryPath(binaryName string) string {
	name := strings.TrimSpace(binaryName)
	if name == "" {
		return ""
	}
	if path, err := exec.LookPath(name); err == nil {
		return strings.TrimSpace(path)
	}
	return ""
}

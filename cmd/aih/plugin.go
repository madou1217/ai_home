package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/madou1217/ai_home/application/serverconfig"
	"github.com/madou1217/ai_home/internal/adapters/pluginartifact"
	"github.com/madou1217/ai_home/internal/adapters/plugintrust"
	"github.com/madou1217/ai_home/internal/pluginerr"
	"github.com/madou1217/ai_home/internal/runtime/pluginhost"
	"github.com/madou1217/ai_home/internal/transport/http/webuiserverconfigapi"
)

// pluginUsage 是 `aih plugin` 的帮助文本。
const pluginUsage = `Usage: aih plugin <command> [options]

  validate <dir> [--load]          校验 plugin.json 或 canonical 包；--load 在一次性宿主里试加载
  pack <dir> [out.aih-plugin]      打包成离线插件包（--signing-key <pem> --key-id <id>）
  keygen [--out <dir>]             生成 Ed25519 发布密钥对（private.pem / public.pem）
  trust <public.pem> [--key-id <id>]   把发布公钥加入本机信任根
  untrust <keyId>                  从本机信任根移除发布公钥
  trusted                          列出本机信任的发布公钥
  install <file.aih-plugin> [--require-signed] [--trust-key <public.pem>] [--expect-fingerprint <hex>]
                                   安装插件包；--trust-key 一步登记发布公钥再安装，--require-signed 拒绝未签名/未验证包
  list                             已安装插件、实例与运行状态
  enable <pluginId> [--instance <id>] [--version <v>] [--config-json <json>|@file|-] [--accept-permissions]
  disable <instanceId> [--remove]  停用实例（--remove 同时删除实例配置）
  uninstall <pluginId> [--version <v>]
  call <contributionId> [--value-json <json>|@file|-]   调试调用一个贡献项（@file/stdin 避免 shell 吞引号）
  doctor                           检查制品、签名、权限、审计与运行时

  通用选项：--json  以 JSON 输出；--expected-revision <n>  并发保护`

// pluginBooleanFlags 是不带值的开关；其它 --name 都吃掉后一个参数。
var pluginBooleanFlags = map[string]bool{
	"--json":               true,
	"--load":               true,
	"--remove":             true,
	"--require-signed":     true,
	"--accept-permissions": true,
}

// pluginExitCode 用于打印完错误后以指定退出码结束，避免 main 再打印一次。
type pluginExitCode int

func (code pluginExitCode) Error() string { return "" }
func (code pluginExitCode) ExitCode() int { return int(code) }
func (code pluginExitCode) SilentExit()   {}

// runPlugin 执行 `aih plugin <command>`。
//
// 离线命令（validate/pack/keygen/trust）直接调用 Go 适配器；运行态命令通过
// 管理密钥调用 Go Server 的插件管理路由，由服务端独占插件宿主。
func runPlugin(ctx context.Context, arguments []string, runtime commandRuntime) error {
	args := append([]string(nil), arguments...)
	command := ""
	if len(args) > 0 {
		command = strings.TrimSpace(args[0])
	}
	rest := args[1:]
	jsonOutput := pluginHasFlag(rest, "--json")
	if command == "" || command == "help" || command == "--help" || command == "-h" {
		_, _ = fmt.Fprintln(runtime.stdout, pluginUsage)
		return nil
	}
	if !pluginKnownCommand(command) {
		_, _ = fmt.Fprintf(runtime.stdout, "[aih] 未识别的子命令 '%s'，以下是可用用法：\n%s\n", command, pluginUsage)
		return nil
	}

	var (
		result map[string]any
		err    error
	)
	switch command {
	case "validate":
		result, err = pluginValidate(ctx, rest, runtime)
	case "pack":
		result, err = pluginPack(rest)
	case "keygen":
		result, err = pluginKeygen(rest)
	case "trust":
		result, err = pluginTrust(rest, runtime)
	case "untrust":
		result, err = pluginUntrust(rest, runtime)
	case "trusted":
		result, err = pluginTrusted(runtime)
	case "install":
		result, err = pluginInstall(ctx, rest, runtime)
	case "list", "status":
		result, err = pluginRequest(ctx, "GET", "/v1/management/plugins", nil, runtime)
	case "doctor":
		result, err = pluginRequest(ctx, "GET", "/v1/management/webui/plugins/doctor", nil, runtime)
	case "enable":
		result, err = pluginEnable(ctx, rest, runtime)
	case "disable":
		result, err = pluginDisable(ctx, rest, runtime)
	case "uninstall":
		result, err = pluginUninstall(ctx, rest, runtime)
	case "call":
		result, err = pluginCall(ctx, rest, runtime)
	}
	if err != nil {
		var argumentError *pluginArgumentError
		if errors.As(err, &argumentError) {
			_, _ = fmt.Fprintf(runtime.stdout, "[aih] 参数不足：%s\n%s\n", argumentError.Message, pluginUsage)
			return nil
		}
		printPluginFailure(runtime, command, err)
		return pluginExitCode(1)
	}
	if jsonOutput {
		if err := printPluginJSON(runtime.stdout, result); err != nil {
			return err
		}
		return nil
	}
	if command == "list" || command == "status" {
		_, _ = fmt.Fprintln(runtime.stdout, renderPluginList(result))
		return nil
	}
	if command == "doctor" {
		_, _ = fmt.Fprintln(runtime.stdout, renderPluginDoctor(result))
		return nil
	}
	return printPluginJSON(runtime.stdout, result)
}

func pluginKnownCommand(command string) bool {
	switch command {
	case "validate", "pack", "keygen", "trust", "untrust", "trusted",
		"install", "list", "status", "doctor", "enable", "disable", "uninstall", "call":
		return true
	default:
		return false
	}
}

// pluginArgumentError 表示缺参数；Node 的 CLI 对此只打印用法并以 0 退出。
type pluginArgumentError struct {
	Message string
}

func (err *pluginArgumentError) Error() string { return err.Message }

func pluginArgumentRequired(message string) error {
	return &pluginArgumentError{Message: message}
}

func pluginOption(args []string, name string) string {
	for index, item := range args {
		// 同时接受 `--name value` 与 `--name=value`：Windows 的 shell 习惯后者，
		// 少一层参数切分就少一次引号被吞的机会。
		if strings.HasPrefix(item, name+"=") {
			return strings.TrimSpace(strings.TrimPrefix(item, name+"="))
		}
		if item == name && index+1 < len(args) {
			return strings.TrimSpace(args[index+1])
		}
	}
	return ""
}

func pluginPositional(args []string, index int) string {
	values := make([]string, 0, len(args))
	for position := 0; position < len(args); position++ {
		item := args[position]
		if strings.HasPrefix(item, "--") {
			if !pluginBooleanFlags[item] {
				position++
			}
			continue
		}
		values = append(values, item)
	}
	if index < 0 || index >= len(values) {
		return ""
	}
	return strings.TrimSpace(values[index])
}

func pluginHasFlag(args []string, name string) bool {
	for _, item := range args {
		if item == name {
			return true
		}
	}
	return false
}

// maxPluginJSONInputBytes 限制 @文件 / stdin 形式的 JSON 输入，避免误读巨型文件。
const maxPluginJSONInputBytes = 1 << 20

// pluginJSONOption 解析 JSON 选项，三种取值形式：
//   - 内联 JSON：`--value-json '{"a":1}'`
//   - `@<路径>`：从文件读取（Windows PowerShell 会吞掉内联 JSON 的引号，这是可靠写法）
//   - `-`：从 stdin 读取
func pluginJSONOption(args []string, name string, stdin io.Reader) (any, error) {
	value := pluginOption(args, name)
	if value == "" {
		return nil, nil
	}
	raw, err := pluginJSONInput(value, stdin)
	if err != nil {
		return nil, err
	}
	var parsed any
	if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
		return nil, pluginerr.New("plugin_json_invalid",
			name+" 不是合法 JSON（Windows PowerShell 5 会吞掉内联 JSON 的引号，改用 "+name+" @文件 或 "+name+" - 从 stdin 读）")
	}
	return parsed, nil
}

func pluginJSONInput(value string, stdin io.Reader) (string, error) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "-" {
		if stdin == nil {
			return "", pluginerr.New("plugin_json_input_unreadable", "当前命令没有可读的标准输入")
		}
		data, err := io.ReadAll(io.LimitReader(stdin, maxPluginJSONInputBytes+1))
		if err != nil {
			return "", pluginerr.New("plugin_json_input_unreadable", "无法读取标准输入")
		}
		if len(data) > maxPluginJSONInputBytes {
			return "", pluginerr.New("plugin_json_input_too_large", "标准输入的 JSON 超过 1MiB")
		}
		return strings.TrimSpace(string(data)), nil
	}
	if strings.HasPrefix(trimmed, "@") {
		path := strings.TrimSpace(strings.TrimPrefix(trimmed, "@"))
		if path == "" {
			return "", pluginerr.New("plugin_json_input_unreadable", "@ 后必须给出 JSON 文件路径")
		}
		info, statErr := os.Stat(path)
		if statErr != nil || info.IsDir() {
			return "", pluginerr.New("plugin_json_input_unreadable", "无法读取 JSON 文件："+path)
		}
		if info.Size() > maxPluginJSONInputBytes {
			return "", pluginerr.New("plugin_json_input_too_large", "JSON 文件超过 1MiB："+path)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return "", pluginerr.New("plugin_json_input_unreadable", "无法读取 JSON 文件："+path)
		}
		return strings.TrimSpace(string(data)), nil
	}
	return trimmed, nil
}

// pluginNodeVersion 返回本机 Node 运行时版本，供 engines.node 判定使用。
//
// Plugin Host 的 Node 后端就是本机 Node；CLI 不猜版本，取不到时让清单校验
// 对 engines.node 约束 fail closed（与安装路径同口径）。
// pluginNodeVersion 复用插件宿主的唯一版本事实来源（AIH_NODE_VERSION → node --version）。
func pluginNodeVersion() string {
	return pluginhost.ResolveNodeVersion(os.LookupEnv)
}

func pluginValidate(ctx context.Context, args []string, runtime commandRuntime) (map[string]any, error) {
	dir := pluginPositional(args, 0)
	if dir == "" {
		return nil, pluginArgumentRequired("validate 需要插件目录（aih plugin validate <dir>）")
	}
	absolute, err := filepath.Abs(dir)
	if err != nil {
		return nil, pluginerr.New("plugin_package_source_invalid", "插件目录不可用")
	}
	source, err := pluginartifact.ReadSourceManifest(absolute)
	if err != nil {
		return nil, err
	}
	manifest, err := pluginartifact.ValidateManifest(source.Manifest, pluginartifact.ManifestOptions{
		NodeVersion: pluginNodeVersion(),
	})
	if err != nil {
		return nil, err
	}
	contributions := make([]any, 0)
	if list, ok := manifest["contributes"].([]any); ok {
		for _, item := range list {
			if contribution, ok := item.(map[string]any); ok {
				if id, ok := contribution["id"].(string); ok {
					contributions = append(contributions, id)
				}
			}
		}
	}
	result := map[string]any{
		"ok":          true,
		"pluginId":    manifest["pluginId"],
		"version":     manifest["version"],
		"contributes": contributions,
	}
	if pluginHasFlag(args, "--load") {
		loaded, loadErr := pluginValidateLoad(ctx, absolute, manifest)
		if loadErr != nil {
			return nil, loadErr
		}
		result["loaded"] = loaded
	}
	return result, nil
}

// pluginValidateLoad 在一次性 Go 插件宿主里试加载候选，宿主用完即停。
func pluginValidateLoad(ctx context.Context, directory string, manifest map[string]any) (map[string]any, error) {
	tempDir, err := os.MkdirTemp("", "aihv-")
	if err != nil {
		return nil, pluginerr.New("plugin_candidate_rejected", "无法创建临时宿主目录")
	}
	defer func() { _ = os.RemoveAll(tempDir) }()
	pluginID, _ := manifest["pluginId"].(string)
	version, _ := manifest["version"].(string)
	socketPath := filepath.Join(tempDir, "h.sock")
	supervisor, err := pluginhost.NewSupervisor(pluginhost.SupervisorOptions{
		AIHomeDir:  tempDir,
		RepoRoot:   resolvePluginRepoRoot(),
		SocketPath: socketPath,
	})
	if err != nil {
		return nil, pluginerr.New("plugin_runtime_unavailable", "无法创建插件宿主")
	}
	processHost := pluginhost.NewProcessHost(nil)
	host := pluginhost.NewHybridHost(supervisor, processHost)
	defer func() { _ = host.Stop(context.Background()) }()
	spec := pluginhost.NewPluginSpec(directory, pluginID, pluginID, version, manifest, map[string]any{})
	prepared, err := host.Prepare(ctx, 1, []pluginhost.PluginSpec{spec})
	if err != nil {
		return nil, pluginCandidateError(err)
	}
	return map[string]any{
		"state":         prepared.State,
		"contributions": prepared.Contributions,
		"diagnostics":   prepared.Diagnostics,
	}, nil
}

func pluginCandidateError(err error) error {
	if coded, ok := pluginerr.From(err); ok {
		message := coded.Message
		if message == "" {
			message = "试加载失败"
		}
		wrapped := pluginerr.New("plugin_candidate_rejected", message)
		wrapped.Diagnostics = coded.Diagnostics
		return wrapped
	}
	return pluginerr.New("plugin_candidate_rejected", "试加载失败")
}

// resolvePluginRepoRoot 定位包含 lib/plugins/host 的仓库根；找不到时返回空由宿主自行从 cwd 搜索。
func resolvePluginRepoRoot() string {
	if root := strings.TrimSpace(os.Getenv("AIH_PACKAGE_ROOT")); root != "" {
		return root
	}
	candidates := make([]string, 0, 8)
	if executable, err := os.Executable(); err == nil {
		dir := filepath.Dir(executable)
		for index := 0; index < 6; index++ {
			candidates = append(candidates, dir)
			parent := filepath.Dir(dir)
			if parent == dir {
				break
			}
			dir = parent
		}
	}
	if cwd, err := os.Getwd(); err == nil {
		dir := cwd
		for index := 0; index < 6; index++ {
			candidates = append(candidates, dir)
			parent := filepath.Dir(dir)
			if parent == dir {
				break
			}
			dir = parent
		}
	}
	for _, candidate := range candidates {
		if _, err := os.Stat(filepath.Join(candidate, "lib", "plugins", "host", "host-entry.mjs")); err == nil {
			return candidate
		}
	}
	return ""
}

func pluginPack(args []string) (map[string]any, error) {
	dir := pluginPositional(args, 0)
	if dir == "" {
		return nil, pluginArgumentRequired("pack 需要插件目录（aih plugin pack <dir> [out.aih-plugin]）")
	}
	output := pluginPositional(args, 1)
	signingKey := pluginOption(args, "--signing-key")
	if signingKey == "" {
		signingKey = pluginOption(args, "--key")
	}
	result, err := pluginartifact.BuildArtifact(dir, output, pluginartifact.BuildOptions{
		SigningKey:  signingKey,
		KeyID:       pluginOption(args, "--key-id"),
		NodeVersion: pluginNodeVersion(),
	})
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"ok":        true,
		"file":      result.File,
		"digest":    result.Digest,
		"bytes":     result.Bytes,
		"files":     result.Files,
		"signature": result.Signature,
	}, nil
}

func pluginKeygen(args []string) (map[string]any, error) {
	outDir := pluginOption(args, "--out")
	if outDir == "" {
		outDir = "aih-plugin-keys"
	}
	absolute, err := filepath.Abs(outDir)
	if err != nil {
		return nil, pluginerr.New("plugin_output_invalid", "输出目录不可用")
	}
	if err := os.MkdirAll(absolute, 0o700); err != nil {
		return nil, pluginerr.New("plugin_output_invalid", "输出目录不可写")
	}
	privatePEM, publicPEM, keyID, err := pluginartifact.GenerateSigningKeyPair()
	if err != nil {
		return nil, pluginerr.New("plugin_signature_key_invalid", err.Error())
	}
	privateFile := filepath.Join(absolute, "private.pem")
	publicFile := filepath.Join(absolute, "public.pem")
	if err := os.WriteFile(privateFile, []byte(privatePEM), 0o600); err != nil {
		return nil, pluginerr.New("plugin_output_invalid", "私钥文件写入失败")
	}
	if err := os.WriteFile(publicFile, []byte(publicPEM), 0o644); err != nil {
		return nil, pluginerr.New("plugin_output_invalid", "公钥文件写入失败")
	}
	return map[string]any{
		"ok":         true,
		"privateKey": privateFile,
		"publicKey":  publicFile,
		"keyId":      keyID,
	}, nil
}

func pluginTrust(args []string, runtime commandRuntime) (map[string]any, error) {
	file := pluginPositional(args, 0)
	if file == "" {
		return nil, pluginArgumentRequired("trust 需要公钥文件（aih plugin trust <public.pem>）")
	}
	data, err := os.ReadFile(file)
	if err != nil {
		return nil, pluginerr.New("plugin_signature_key_invalid", "公钥文件不可读")
	}
	home, err := resolveAIHome(runtime)
	if err != nil {
		return nil, pluginerr.New("plugin_home_unavailable", "无法定位 AIH_HOME_DIR")
	}
	store, err := plugintrust.NewTrustStore(home)
	if err != nil {
		return nil, err
	}
	result, err := store.Add(plugintrust.AddInput{
		PublicKey: string(data),
		KeyID:     pluginOption(args, "--key-id"),
	})
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"ok":          true,
		"keyId":       result.KeyID,
		"fingerprint": result.Fingerprint,
		"file":        result.File,
	}, nil
}

func pluginUntrust(args []string, runtime commandRuntime) (map[string]any, error) {
	keyID := pluginPositional(args, 0)
	if keyID == "" {
		keyID = pluginOption(args, "--key-id")
	}
	if keyID == "" {
		return nil, pluginArgumentRequired("untrust 需要 keyId（aih plugin untrust <keyId>）")
	}
	home, err := resolveAIHome(runtime)
	if err != nil {
		return nil, pluginerr.New("plugin_home_unavailable", "无法定位 AIH_HOME_DIR")
	}
	store, err := plugintrust.NewTrustStore(home)
	if err != nil {
		return nil, err
	}
	result, err := store.Remove(keyID)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"ok":      true,
		"keyId":   result.KeyID,
		"removed": result.Removed,
		"file":    result.File,
	}, nil
}

func pluginTrusted(runtime commandRuntime) (map[string]any, error) {
	home, err := resolveAIHome(runtime)
	if err != nil {
		return nil, pluginerr.New("plugin_home_unavailable", "无法定位 AIH_HOME_DIR")
	}
	store, err := plugintrust.NewTrustStore(home)
	if err != nil {
		return nil, err
	}
	keys, err := store.List()
	if err != nil {
		return nil, err
	}
	return map[string]any{"ok": true, "keys": keys}, nil
}

func pluginInstall(ctx context.Context, args []string, runtime commandRuntime) (map[string]any, error) {
	file := pluginPositional(args, 0)
	if file == "" {
		return nil, pluginArgumentRequired("install 需要插件包（aih plugin install <file.aih-plugin>）")
	}
	absolute, err := filepath.Abs(file)
	if err != nil {
		return nil, pluginerr.New("plugin_package_missing", "插件包路径不可用")
	}
	if trustKey := strings.TrimSpace(pluginOption(args, "--trust-key")); trustKey != "" {
		if err := trustPackageKey(absolute, trustKey, args, runtime); err != nil {
			return nil, err
		}
	}
	result, err := pluginRequest(ctx, "POST", "/v1/management/plugins/install", map[string]any{
		"file":          absolute,
		"requireSigned": pluginHasFlag(args, "--require-signed"),
	}, runtime)
	if err != nil {
		return nil, err
	}
	if signature, ok := result["signature"].(map[string]any); ok && signature["status"] == "untrusted" {
		keyID := strings.TrimSpace(stringValue(signature["keyId"]))
		_, _ = fmt.Fprintf(runtime.stderr,
			"[aih] 签名未验证：包由 keyId %s 签名，但本机未登记该公钥。确认来源后可运行 aih plugin trust <public.pem> --key-id %s，或下次安装加 --trust-key <public.pem>。\n",
			keyID, keyID)
	}
	return result, nil
}

// trustPackageKey 实现「一步信任」：从包内读取签名 keyId，把用户给的公钥
// 登记到同一个槽位，再交给服务端安装并验签。keyId 冲突默认拒绝，避免
// 同名标签悄悄覆盖已信任的发布者。
func trustPackageKey(packageFile string, publicKeyFile string, args []string, runtime commandRuntime) error {
	info, err := pluginartifact.ReadSignatureInfo(packageFile)
	if err != nil {
		return err
	}
	if info.Status != "signed" || strings.TrimSpace(info.KeyID) == "" {
		return pluginerr.New("plugin_signature_required", "该插件包没有签名，--trust-key 无意义")
	}
	data, err := os.ReadFile(publicKeyFile)
	if err != nil {
		return pluginerr.New("plugin_signature_key_invalid", "公钥文件不可读")
	}
	normalized, err := plugintrust.NormalizePublicKey(string(data))
	if err != nil {
		return err
	}
	fingerprint := plugintrust.Fingerprint(normalized)
	if expected := strings.TrimSpace(pluginOption(args, "--expect-fingerprint")); expected != "" && !strings.EqualFold(expected, fingerprint) {
		return pluginerr.New("plugin_signature_key_invalid",
			fmt.Sprintf("公钥指纹不匹配：期望 %s，实际 %s", expected, fingerprint))
	}
	home, err := resolveAIHome(runtime)
	if err != nil {
		return pluginerr.New("plugin_home_unavailable", "无法定位 AIH_HOME_DIR")
	}
	store, err := plugintrust.NewTrustStore(home)
	if err != nil {
		return err
	}
	keys, err := store.Read()
	if err != nil {
		return err
	}
	if existing, present := keys[info.KeyID]; present && existing != normalized && !pluginHasFlag(args, "--replace-key") {
		return pluginerr.New("plugin_signature_key_conflict",
			fmt.Sprintf("keyId %s 已登记为另一把公钥；确认要替换请加 --replace-key", info.KeyID))
	}
	added, err := store.Add(plugintrust.AddInput{PublicKey: normalized, KeyID: info.KeyID})
	if err != nil {
		return err
	}
	_, _ = fmt.Fprintf(runtime.stderr, "[aih] 已信任 %s（指纹 %s）\n", added.KeyID, added.Fingerprint)
	return nil
}

func pluginEnable(ctx context.Context, args []string, runtime commandRuntime) (map[string]any, error) {
	pluginID := pluginPositional(args, 0)
	if pluginID == "" {
		return nil, pluginArgumentRequired("enable 需要 pluginId（aih plugin enable <pluginId>）")
	}
	instanceID := pluginOption(args, "--instance")
	if instanceID == "" {
		instanceID = pluginID
	}
	configuration, err := pluginJSONOption(args, "--config-json", runtime.stdin)
	if err != nil {
		return nil, err
	}
	payload := map[string]any{
		"pluginId":          pluginID,
		"instanceId":        instanceID,
		"version":           pluginOption(args, "--version"),
		"acceptPermissions": pluginHasFlag(args, "--accept-permissions"),
	}
	if configuration != nil {
		payload["configuration"] = configuration
	}
	if expected := pluginOption(args, "--expected-revision"); expected != "" {
		payload["expectedRevision"] = expected
	}
	return pluginRequest(ctx, "POST", "/v1/management/plugins/instances/"+urlPathEscape(instanceID)+"/enable", payload, runtime)
}

func pluginDisable(ctx context.Context, args []string, runtime commandRuntime) (map[string]any, error) {
	instanceID := pluginPositional(args, 0)
	if instanceID == "" {
		return nil, pluginArgumentRequired("disable 需要 instanceId（aih plugin disable <instanceId>）")
	}
	payload := map[string]any{"remove": pluginHasFlag(args, "--remove")}
	if expected := pluginOption(args, "--expected-revision"); expected != "" {
		payload["expectedRevision"] = expected
	}
	return pluginRequest(ctx, "POST", "/v1/management/plugins/instances/"+urlPathEscape(instanceID)+"/disable", payload, runtime)
}

func pluginUninstall(ctx context.Context, args []string, runtime commandRuntime) (map[string]any, error) {
	pluginID := pluginPositional(args, 0)
	if pluginID == "" {
		return nil, pluginArgumentRequired("uninstall 需要 pluginId（aih plugin uninstall <pluginId>）")
	}
	payload := map[string]any{
		"pluginId": pluginID,
		"version":  pluginOption(args, "--version"),
	}
	if expected := pluginOption(args, "--expected-revision"); expected != "" {
		payload["expectedRevision"] = expected
	}
	return pluginRequest(ctx, "POST", "/v1/management/plugins/uninstall", payload, runtime)
}

func pluginCall(ctx context.Context, args []string, runtime commandRuntime) (map[string]any, error) {
	contributionID := pluginPositional(args, 0)
	if contributionID == "" {
		return nil, pluginArgumentRequired("call 需要 contributionId（aih plugin call <contributionId>）")
	}
	value, err := pluginJSONOption(args, "--value-json", runtime.stdin)
	if err != nil {
		return nil, err
	}
	payload := map[string]any{"contributionId": contributionID}
	if value != nil {
		payload["value"] = value
	}
	return pluginRequest(ctx, "POST", "/v1/management/webui/plugins/invoke", payload, runtime)
}

func urlPathEscape(value string) string {
	return strings.ReplaceAll(strings.ReplaceAll(strings.TrimSpace(value), "%", "%25"), "/", "%2F")
}

func pluginRequest(ctx context.Context, method, path string, payload map[string]any, runtime commandRuntime) (map[string]any, error) {
	home, err := resolveAIHome(runtime)
	if err != nil {
		return nil, pluginerr.New("plugin_home_unavailable", "无法定位 AIH_HOME_DIR")
	}
	baseURL, key, err := pluginServerConnection(ctx, home)
	if err != nil {
		return nil, err
	}
	if key == "" {
		return nil, pluginerr.New("plugin_management_key_missing",
			"需要管理密钥：请先运行 aih server config，或设置 AIH_SERVER_MANAGEMENT_KEY")
	}
	var body io.Reader
	if payload != nil {
		encoded, err := json.Marshal(payload)
		if err != nil {
			return nil, pluginerr.New("plugin_request_invalid", "请求体无法编码")
		}
		body = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(baseURL, "/")+path, body)
	if err != nil {
		return nil, pluginerr.New("plugin_request_invalid", "请求无法创建")
	}
	request.Header.Set("Authorization", "Bearer "+key)
	// 宿主事实必须随请求带上：服务端用它判定插件 engines，不能由 Go 猜。
	request.Header.Set("X-Aih-Host-Version", "1.0.0")
	if nodeVersion := pluginNodeVersion(); nodeVersion != "" {
		request.Header.Set("X-Aih-JS-Runtime-Version", nodeVersion)
	}
	if payload != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := runtime.managementAPI.Do(request)
	if err != nil {
		return nil, pluginerr.New("plugin_server_unreachable", "连不上 aih server（"+baseURL+"）："+err.Error()+"。请先运行 aih server start")
	}
	defer func() { _ = response.Body.Close() }()
	raw, readErr := io.ReadAll(io.LimitReader(response.Body, 8<<20))
	if readErr != nil {
		return nil, pluginerr.New("plugin_request_invalid", "服务端响应不可读")
	}
	var decoded map[string]any
	_ = json.Unmarshal(raw, &decoded)
	if response.StatusCode < 200 || response.StatusCode >= 300 || decoded == nil || decoded["ok"] == false {
		code, _ := decoded["error"].(string)
		if code == "" {
			code = "http_" + strconv.Itoa(response.StatusCode)
		}
		message, _ := decoded["message"].(string)
		if message == "" {
			message = code
		}
		failure := pluginerr.New(code, message)
		if diagnostics, ok := decoded["diagnostics"].([]any); ok {
			failure.Diagnostics = diagnostics
		}
		return nil, failure
	}
	return decoded, nil
}

func pluginServerConnection(ctx context.Context, home string) (string, string, error) {
	key := strings.TrimSpace(os.Getenv("AIH_SERVER_MANAGEMENT_KEY"))
	baseURL := strings.TrimSpace(os.Getenv("AIH_SERVER_BASE_URL"))
	config, err := webuiserverconfigapi.ReadFullConfig(ctx, home)
	if err == nil {
		if key == "" {
			key = strings.TrimSpace(config.ManagementKey)
		}
		if baseURL == "" {
			baseURL = serverconfig.BaseURL(serverconfig.NormalizeLoopbackHost(strings.Trim(strings.TrimSpace(config.Host), "[]")), config.Port, "")
		}
	}
	if baseURL == "" {
		baseURL = serverconfig.BaseURL(serverconfig.DefaultHost, serverconfig.DefaultPort, "")
	}
	return baseURL, key, nil
}

func printPluginFailure(runtime commandRuntime, command string, err error) {
	message := err.Error()
	var diagnostics []any
	if coded, ok := pluginerr.From(err); ok {
		if coded.Message != "" {
			message = coded.Message
		}
		diagnostics = coded.Diagnostics
	}
	_, _ = fmt.Fprintf(runtime.stderr, "[aih] plugin %s 失败：%s\n", command, message)
	for _, item := range diagnostics {
		entry, _ := item.(map[string]any)
		detail, _ := entry["detail"].(string)
		instance, _ := entry["instanceId"].(string)
		itemCode, _ := entry["code"].(string)
		_, _ = fmt.Fprintf(runtime.stderr, "  %s  %s %s\n", itemCode, instance, detail)
	}
}

func printPluginJSON(output io.Writer, value map[string]any) error {
	encoded, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	_, _ = fmt.Fprintln(output, string(encoded))
	return nil
}

func renderPluginList(result map[string]any) string {
	runtimeState := nestedString(result, "runtime", "state")
	if runtimeState == "" {
		runtimeState = "unknown"
	}
	lines := []string{fmt.Sprintf("revision %v · 运行时 %s · 代次 %v",
		numberText(result["revision"]),
		runtimeState,
		numberText(nestedValue(result, "runtime", "activeGeneration")))}
	installed, _ := result["installed"].([]any)
	for _, item := range installed {
		entry, _ := item.(map[string]any)
		signature := "未签名"
		if sig, ok := entry["signature"].(map[string]any); ok {
			switch sig["status"] {
			case "signed":
				signature = "签名 " + stringValue(sig["keyId"])
			case "untrusted":
				signature = "签名未验证 " + stringValue(sig["keyId"])
			}
		}
		digest := stringValue(entry["digest"])
		if len(digest) > 12 {
			digest = digest[:12]
		}
		lines = append(lines, fmt.Sprintf("  已安装 %s@%s  %s  %s",
			stringValue(entry["pluginId"]), stringValue(entry["version"]), digest, signature))
	}
	instances, _ := result["instances"].([]any)
	for _, item := range instances {
		entry, _ := item.(map[string]any)
		state := "已停用"
		if enabled, _ := entry["enabled"].(bool); enabled {
			state = "已启用"
		}
		lines = append(lines, fmt.Sprintf("  实例 %s → %s@%s  %s",
			stringValue(entry["instanceId"]), stringValue(entry["pluginId"]), stringValue(entry["version"]), state))
	}
	if len(installed) == 0 {
		lines = append(lines, "  （没有已安装的插件）")
	}
	return strings.Join(lines, "\n")
}

func renderPluginDoctor(result map[string]any) string {
	lines := make([]string, 0)
	if healthy, _ := result["healthy"].(bool); healthy {
		lines = append(lines, "插件状态正常（revision "+numberText(result["revision"])+"）")
	} else {
		lines = append(lines, "发现问题：")
		issues, _ := result["issues"].([]any)
		for _, item := range issues {
			entry, _ := item.(map[string]any)
			lines = append(lines, fmt.Sprintf("  %s  %s %s",
				stringValue(entry["code"]), firstString(entry, "pluginId", "instanceId"), stringValue(entry["detail"])))
		}
	}
	if warnings, _ := result["warnings"].([]any); len(warnings) > 0 {
		lines = append(lines, "警告：")
		for _, item := range warnings {
			entry, _ := item.(map[string]any)
			lines = append(lines, fmt.Sprintf("  %s  %s %s",
				stringValue(entry["code"]), stringValue(entry["pluginId"]), stringValue(entry["detail"])))
		}
	}
	if pricing, ok := result["pricing"].(map[string]any); ok {
		sources, _ := pricing["sources"].([]any)
		lines = append(lines, fmt.Sprintf("价格源 %d 个 · 生效报价 %s 条 · 待复核 %s 条",
			len(sources), numberText(pricing["records"]), numberText(pricing["pendingReviews"])))
		for _, item := range sources {
			entry, _ := item.(map[string]any)
			lines = append(lines, fmt.Sprintf("  %s  %s  %s  %v 条",
				stringValue(entry["sourceId"]), stringValue(entry["kind"]),
				stringValue(entry["fetchedAt"]), entry["quotes"]))
		}
	}
	return strings.Join(lines, "\n")
}

func nestedValue(root map[string]any, path ...string) any {
	var current any = root
	for _, key := range path {
		object, ok := current.(map[string]any)
		if !ok {
			return nil
		}
		current = object[key]
	}
	return current
}

func nestedString(root map[string]any, path ...string) string {
	return stringValue(nestedValue(root, path...))
}

func stringValue(value any) string {
	text, _ := value.(string)
	return strings.TrimSpace(text)
}

func numberText(value any) string {
	switch typed := value.(type) {
	case float64:
		return strconv.FormatFloat(typed, 'f', -1, 64)
	case int:
		return strconv.Itoa(typed)
	case int64:
		return strconv.FormatInt(typed, 10)
	case json.Number:
		return typed.String()
	default:
		return ""
	}
}

func firstString(entry map[string]any, keys ...string) string {
	for _, key := range keys {
		if value := stringValue(entry[key]); value != "" {
			return value
		}
	}
	return ""
}

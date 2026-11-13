package webuiopenappapi

import (
	"crypto/rand"
	"encoding/hex"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/madou1217/ai_home/core/harnesses"
	"github.com/madou1217/ai_home/core/providers"
)

const (
	// 平台键使用 Provider 合同里的取值（不是 runtime.GOOS 的 darwin/win32）。
	platformMacOS   = "macos"
	platformWindows = "windows"
	platformLinux   = "linux"

	// defaultTerminalID 与 Node 的 DEFAULT_TERMINAL_ID 一致：调用方没指定终端时
	// 交给系统默认终端适配器。
	defaultTerminalID = "system-default"

	// 启动语义词表与 Node lib/harness/launch-plan.js 一致。
	kindDesktop = "desktop"
	kindCLI     = "cli"

	actionOpen  = "open"
	actionClose = "close"

	transportNative = "native"
	transportWebUI  = "webui"
)

// proxyHeaders 与 Node 的 webui-terminal-transport-policy 同名单：出现任一请求头
// 即视为经过代理 / 另一台 Server 中转，浏览器不再与 Server 同机。
var proxyHeaders = []string{
	"x-forwarded-for",
	"x-real-ip",
	"cf-connecting-ip",
	"forwarded",
	"x-aih-server-id",
}

// planInput 是一次启动判定所需的全部输入：请求已归一化的字段 + 身份 Provider 合同。
type planInput struct {
	catalog    ProviderCatalog
	definition providers.Definition
	provider   string
	accountRef string
	kind       string
	action     string
	harness    string
	model      string
	terminalID string
	workdir    string
	transport  string
	sessionKey string
}

// planError 是判定阶段的可直接回写的失败：status 与 Node 的错误码保持一致。
type planError struct {
	status  int
	code    string
	message string
}

func newPlanError(status int, code string, message string) *planError {
	return &planError{status: status, code: code, message: message}
}

// resolvePlan 把请求字段翻译成一份启动计划。
//
// 规则逐条对齐 Node lib/harness/launch-plan.js：
//   - kind / action 只接受固定词表；
//   - harness 缺省为身份 Provider 自己；
//   - desktop 只认身份 Provider 的桌面客户端声明，harness 恒为自身；
//   - cli 允许跨 Provider harness，但 harness 必须在 Provider 合同里且声明了 CLI；
//   - 身份 Provider 没有 CLI 合同时直接 unsupported_provider（Node 同口径）。
//
// 本包不识别 pi / dsh 这类外部 harness：它们不在 Go 的 Provider 合同内，
// 传入时会落到 cli_not_supported，并在响应的 unfilledFields 里说明。
func resolvePlan(input planInput) (Request, *planError) {
	if input.kind != kindDesktop && input.kind != kindCLI {
		return Request{}, newPlanError(http.StatusBadRequest, "unsupported_kind", "kind 只支持 desktop 或 cli")
	}
	if input.action != actionOpen && input.action != actionClose {
		return Request{}, newPlanError(http.StatusBadRequest, "unsupported_action", "action 只支持 open 或 close")
	}

	harnessID := harnesses.NormalizeID(input.harness)
	if harnessID == "" {
		harnessID = input.provider
	}
	// 外部 harness（pi / dsh / dsh-tui）不是 Provider：只允许作为 CLI 入口，
	// 身份仍绑定账号所属 Provider；这与 Node launch-plan 的判定一致。
	externalHarness, isExternal := harnesses.Get(harnessID)
	if input.kind == kindDesktop && isExternal {
		return Request{}, newPlanError(http.StatusBadRequest, "desktop_not_supported", "外部 harness 没有桌面客户端")
	}
	// 身份 Provider 的 CLI 合同是「能否以它为身份启动」的前提；外部 harness 可以
	// 借用没有自身 CLI 的 Provider 身份（Node 同样只在外部 harness 时放行）。
	if input.definition.CLI == nil && !(input.kind == kindCLI && isExternal) {
		return Request{}, newPlanError(http.StatusBadRequest, "unsupported_provider", "该 Provider 没有 CLI 合同，无法判定启动方式")
	}

	if input.kind == kindDesktop {
		if !input.definition.Clients.Desktop {
			return Request{}, newPlanError(http.StatusBadRequest, "desktop_not_supported", "该 Provider 没有桌面客户端")
		}
		return Request{
			Provider:      input.provider,
			AccountRef:    input.accountRef,
			Kind:          kindDesktop,
			Action:        input.action,
			Harness:       input.provider,
			HarnessKind:   "native",
			CrossProvider: false,
			ManagedAppID:  input.provider,
			BinaryName:    binaryName(input.definition, input.provider),
			Transport:     input.transport,
			SessionKey:    input.sessionKey,
		}, nil
	}

	crossProvider := harnessID != input.provider
	harnessDefinition := input.definition
	harnessKind := "native"
	managedAppID := harnessID
	binary := ""
	if isExternal {
		harnessKind = "external"
		managedAppID = externalHarness.ManagedAppID
		if managedAppID == "" {
			managedAppID = harnessID
		}
		binary = externalHarness.BinaryName
		if crossProvider && !externalHarness.SupportsCrossProvider {
			return Request{}, newPlanError(http.StatusBadRequest, "cross_provider_relay_unsupported",
				"harness "+harnessID+" 不支持以其它 Provider 的账号跨 Provider 启动")
		}
	} else {
		if crossProvider {
			found, ok := input.catalog.Get(harnessID)
			if !ok || !found.Clients.CLI {
				return Request{}, newPlanError(http.StatusBadRequest, "cli_not_supported",
					"harness "+harnessID+" 不在 Provider 合同内或没有 CLI 声明")
			}
			if !harnesses.SupportsCrossProvider(harnessID) {
				return Request{}, newPlanError(http.StatusBadRequest, "cross_provider_relay_unsupported",
					"harness "+harnessID+" 不支持以其它 Provider 的账号跨 Provider 启动")
			}
			harnessDefinition = found
		} else if !input.definition.Clients.CLI {
			return Request{}, newPlanError(http.StatusBadRequest, "cli_not_supported", "该 Provider 没有 CLI")
		}
		binary = binaryName(harnessDefinition, harnessID)
	}

	terminalID := strings.ToLower(strings.TrimSpace(input.terminalID))
	if terminalID == "" {
		terminalID = defaultTerminalID
	}
	return Request{
		Provider:      input.provider,
		AccountRef:    input.accountRef,
		Kind:          kindCLI,
		Action:        input.action,
		Harness:       harnessID,
		HarnessKind:   harnessKind,
		CrossProvider: crossProvider,
		ManagedAppID:  managedAppID,
		BinaryName:    binary,
		Model:         input.model,
		TerminalID:    terminalID,
		Workdir:       input.workdir,
		Transport:     input.transport,
		SessionKey:    input.sessionKey,
	}, nil
}

// binaryName 取合同里的可执行文件名；未声明时与 Node 一样按 Provider ID 调用。
func binaryName(definition providers.Definition, fallback string) string {
	if definition.CLI != nil {
		if name := strings.TrimSpace(definition.CLI.BinaryName); name != "" {
			return name
		}
	}
	return fallback
}

// inferKind 在调用方没带 kind 时按宿主机与 Provider 能力推导：
// 有桌面会话且 Provider 声明了桌面客户端就开 App，否则回落到 CLI。
//
// 这是 Go 侧的便利规则：Node 的前端总会显式带 kind，缺省时 Node 直接
// unsupported_kind。推导只走合同声明，不猜未声明的能力。
func inferKind(definition providers.Definition, desktopHost bool) string {
	if desktopHost && definition.Clients.Desktop {
		return kindDesktop
	}
	if definition.Clients.CLI {
		return kindCLI
	}
	return ""
}

// resolveTerminalTransport 返回本次 CLI 的承载方式：native（本机窗口）或 webui（Server 端 PTY）。
//
// 与 Node 的判定同义：只有「本机浏览器 → 本机 Server，且 Server 有桌面」才允许
// 原生终端窗口；客户端只能把本机请求降级到 webui，不能把远端请求升级为 native。
func resolveTerminalTransport(request *http.Request, requested string, desktopHost bool) string {
	if !desktopHost || !isSameMachineRequest(request) {
		return transportWebUI
	}
	if strings.ToLower(strings.TrimSpace(requested)) == transportWebUI {
		return transportWebUI
	}
	return transportNative
}

// isSameMachineRequest 判断浏览器是否与 Server 同机：回环直连且没有代理中转。
func isSameMachineRequest(request *http.Request) bool {
	if request == nil {
		return false
	}
	address := strings.ToLower(strings.TrimSpace(request.RemoteAddr))
	if host, _, err := net.SplitHostPort(address); err == nil {
		address = host
	}
	normalized := strings.TrimPrefix(address, "::ffff:")
	if normalized != "::1" && !strings.HasPrefix(normalized, "127.") {
		return false
	}
	for _, header := range proxyHeaders {
		if strings.TrimSpace(request.Header.Get(header)) != "" {
			return false
		}
	}
	return true
}

// defaultWebTerminalSessionKey 与 Node 的同名函数同语义：每次打开都是新的 PTY。
//
// 编码口径向 encodeURIComponent 靠拢（空格是 %20 而不是 +），再做 150 字符截断。
func defaultWebTerminalSessionKey(accountRef, harness, model, workdir string) string {
	nonce := make([]byte, 8)
	if _, err := rand.Read(nonce); err != nil {
		// 随机源不可用时退化为纳秒时间戳：仍保证每次请求的键不同。
		return "account-cli:" + strconv.FormatInt(time.Now().UnixNano(), 16)
	}
	raw := strings.Join([]string{
		hex.EncodeToString(nonce),
		accountRef,
		harness,
		model,
		workdir,
	}, "|")
	encoded := strings.ReplaceAll(url.QueryEscape(raw), "+", "%20")
	if len(encoded) > 150 {
		encoded = encoded[:150]
	}
	return "account-cli:" + encoded
}

// resolveExecutable 尽力解析本机可执行入口，供计划展示与 Launcher 参考。
//
// 只覆盖 PATH 与少数固定落点；Node 的完整原生 CLI 解析链（运行时工具目录、
// npm 全局前缀、按 Provider 的安装器声明）仍归 Launcher，解析不到时留空。
func (handler *Handler) resolveExecutable(definition providers.Definition, plan Request) string {
	if plan.Kind == kindDesktop {
		return handler.resolveDesktopApp(definition)
	}
	return handler.resolveCLI(plan.BinaryName)
}

// resolveDesktopApp 按平台声明解析桌面 App 安装位置。
//
// macOS 以 manifest 的 installPaths（.app bundle）为准；其它平台先看安装路径，
// 再用 ExecNames 走 PATH。{hostHomeDir} 占位符按宿主 HOME 展开。
func (handler *Handler) resolveDesktopApp(definition providers.Definition) string {
	if definition.CLI == nil || definition.CLI.DesktopClient == nil {
		return ""
	}
	platformConfig := desktopPlatformFor(definition.CLI.DesktopClient, handler.platform)
	if platformConfig == nil {
		return ""
	}
	for _, rawPath := range platformConfig.InstallPaths {
		candidate := strings.ReplaceAll(strings.TrimSpace(rawPath), "{hostHomeDir}", handler.hostHomeDir)
		if candidate == "" {
			continue
		}
		if pathExists(candidate) {
			return candidate
		}
	}
	for _, rawName := range platformConfig.ExecNames {
		name := strings.TrimSpace(rawName)
		if name == "" {
			continue
		}
		if path, err := handler.lookPath(name); err == nil {
			return path
		}
	}
	return ""
}

// resolveCLI 依次尝试 PATH、$AIHOME/bin、$HOST_HOME/.local/bin 与 Homebrew 前缀。
func (handler *Handler) resolveCLI(binaryName string) string {
	if binaryName == "" {
		return ""
	}
	if path, err := handler.lookPath(binaryName); err == nil {
		return path
	}
	candidates := make([]string, 0, 4)
	if handler.aiHomeDir != "" {
		candidates = append(candidates, filepath.Join(handler.aiHomeDir, "bin", binaryName))
	}
	if handler.hostHomeDir != "" {
		candidates = append(candidates, filepath.Join(handler.hostHomeDir, ".local", "bin", binaryName))
	}
	if handler.platform != platformWindows {
		candidates = append(candidates,
			filepath.Join("/usr/local/bin", binaryName),
			filepath.Join("/opt/homebrew/bin", binaryName),
		)
	}
	for _, candidate := range candidates {
		if isExecutableFile(candidate, handler.platform) {
			return candidate
		}
	}
	return ""
}

// desktopPlatformFor 取当前平台对应的桌面客户端声明；未声明时返回 nil。
func desktopPlatformFor(client *providers.DesktopClient, platform string) *providers.DesktopPlatform {
	if client == nil {
		return nil
	}
	switch platform {
	case platformMacOS:
		return client.MacOS
	case platformWindows:
		return client.Windows
	case platformLinux:
		return client.Linux
	}
	return nil
}

// resolvePlatformKey 把 runtime.GOOS 归一到 Provider 合同的平台键。
func resolvePlatformKey(goos string) string {
	switch strings.ToLower(strings.TrimSpace(goos)) {
	case "darwin":
		return platformMacOS
	case "windows":
		return platformWindows
	default:
		return platformLinux
	}
}

// defaultDesktopHost 与 Node 的 isDesktopHost 同义：macOS / Windows 恒为桌面宿主；
// Linux 取决于是否有图形会话信号。
func defaultDesktopHost() bool {
	switch runtime.GOOS {
	case "darwin", "windows":
		return true
	case "linux":
		return strings.TrimSpace(os.Getenv("DISPLAY")) != "" ||
			strings.TrimSpace(os.Getenv("WAYLAND_DISPLAY")) != ""
	}
	return false
}

// isExecutableFile 要求候选是文件且具备可执行位（Windows 不区分可执行位）。
func isExecutableFile(candidate string, platform string) bool {
	info, err := os.Stat(candidate)
	if err != nil || info.IsDir() {
		return false
	}
	if platform == platformWindows {
		return true
	}
	return info.Mode().Perm()&0o111 != 0
}

func pathExists(candidate string) bool {
	if candidate == "" {
		return false
	}
	_, err := os.Stat(candidate)
	return err == nil
}

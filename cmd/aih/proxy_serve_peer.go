package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/sshremote"
	"github.com/madou1217/ai_home/internal/runtime/proxytransport"
)

// proxy serve --peer：在远端 AIH 上启动它自己的代理入口，只把入口端口经
// SSH direct-tcpip 转发到本机。远端的 Management Key 始终留在远端，不需要
// 拷贝到本机；本机只拿到远端入口的租约 URL。
const peerDiagnosticLimit = 4096

var (
	peerSelectorPattern = regexp.MustCompile(`^[A-Za-z0-9._:-]+$`)
	peerCommandPattern  = regexp.MustCompile(`^[A-Za-z0-9 _./:\\-]+$`)
	peerUserinfoPattern = regexp.MustCompile(`://[^/\s@]+@`)
)

type peerServePayload struct {
	OK        bool   `json:"ok"`
	HTTPURL   string `json:"httpUrl"`
	SOCKS5URL string `json:"socks5Url"`
	Name      string `json:"name"`
	Selector  string `json:"selector"`
	Error     string `json:"error"`
}

type peerStreamResult struct {
	code int
	err  error
}

// peerConnector 共享一条 SSH 客户端给多个转发器；转发器关闭时不能关闭客户端。
type peerConnector struct {
	client *sshremote.Client
}

func (connector peerConnector) DialTCP(ctx context.Context, network, address string) (net.Conn, error) {
	return connector.client.DialTCP(ctx, network, address)
}

func (connector peerConnector) Close() error { return nil }

func runProxyServePeer(ctx context.Context, options proxyServeOptions, runtime commandRuntime) (err error) {
	client, err := openSSHClient(ctx, runtime, options.peer, options.peerVia)
	if err != nil {
		return fmt.Errorf("无法连接对等节点: %w", err)
	}
	defer func() { _ = client.Close() }()
	command, err := resolvePeerCommand(ctx, client, options)
	if err != nil {
		return err
	}

	streamCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	reader, writer := io.Pipe()
	diagnostics := &peerTail{limit: peerDiagnosticLimit}
	streamDone := make(chan peerStreamResult, 1)
	go func() {
		code, streamErr := client.Stream(streamCtx, command, writer, diagnostics)
		_ = writer.Close()
		streamDone <- peerStreamResult{code: code, err: streamErr}
	}()

	var payload peerServePayload
	decodeDone := make(chan error, 1)
	go func() { decodeDone <- json.NewDecoder(reader).Decode(&payload) }()
	select {
	case err = <-decodeDone:
		if err != nil {
			cancel()
			return fmt.Errorf("对等节点没有返回代理入口%s", peerDiagnosticSuffix(diagnostics.String(), ""))
		}
	case <-time.After(30 * time.Second):
		cancel()
		return errors.New("等待对等节点代理入口超时")
	case <-ctx.Done():
		cancel()
		return nil
	}
	// JSON 模式只写一次入口信息；继续排空 stdout，避免远端写管道阻塞。
	go func() { _, _ = io.Copy(io.Discard, reader) }()
	if !payload.OK {
		cancel()
		message := strings.TrimSpace(payload.Error)
		if message == "" {
			message = "对等节点拒绝了代理入口"
		}
		return errors.New(message)
	}
	remoteHTTP, err := peerRemoteAddress(payload.HTTPURL, "http")
	if err != nil {
		cancel()
		return err
	}
	remoteSOCKS := ""
	if strings.TrimSpace(payload.SOCKS5URL) != "" {
		remoteSOCKS, err = peerRemoteAddress(payload.SOCKS5URL, "socks5")
		if err != nil {
			cancel()
			return err
		}
	}

	httpForward, err := proxytransport.NewSSH(streamCtx, peerConnector{client}, proxytransport.SSHOptions{
		RemoteAddress: remoteHTTP,
		ListenAddress: options.listen,
	})
	if err != nil {
		cancel()
		return fmt.Errorf("无法建立对等 HTTP 转发: %w", err)
	}
	defer func() { _ = httpForward.Close() }()

	var socksForward *proxytransport.SSH
	if remoteSOCKS != "" {
		socksForward, err = proxytransport.NewSSH(streamCtx, peerConnector{client}, proxytransport.SSHOptions{
			RemoteAddress: remoteSOCKS,
			ListenAddress: peerSOCKSListenAddress(options.listen),
		})
		if err != nil {
			cancel()
			return fmt.Errorf("无法建立对等 SOCKS5 转发: %w", err)
		}
		defer func() { _ = socksForward.Close() }()
	}

	localHTTP, err := rewritePeerProxyURL(payload.HTTPURL, httpForward.BaseURL(), "http")
	if err != nil {
		cancel()
		return err
	}
	localSOCKS := ""
	if socksForward != nil {
		localSOCKS, err = rewritePeerProxyURL(payload.SOCKS5URL, socksForward.BaseURL(), "socks5")
		if err != nil {
			cancel()
			return err
		}
	}
	writePeerServeOutput(runtime, options, payload, localHTTP, localSOCKS)

	select {
	case <-ctx.Done():
		return nil
	case result := <-streamDone:
		if ctx.Err() != nil {
			return nil
		}
		if result.err != nil && !errors.Is(result.err, context.Canceled) {
			return fmt.Errorf("对等链路中断: %w", result.err)
		}
		return fmt.Errorf("对等节点的代理入口已退出（exit %d）%s", result.code, peerDiagnosticSuffix(diagnostics.String(), ""))
	}
}

// resolvePeerCommand 先探测对等节点上的 aih 可执行文件，再拼出固定的 serve 命令。
// 非交互 SSH 的 PATH 往往缺少 Homebrew/用户目录；默认路径找不到时按常见安装位置回退。
func resolvePeerCommand(ctx context.Context, client *sshremote.Client, options proxyServeOptions) (string, error) {
	if client == nil {
		return "", errors.New("对等节点 SSH 连接不可用")
	}
	selector := strings.TrimSpace(options.selector)
	if selector == "" || !peerSelectorPattern.MatchString(selector) {
		return "", errors.New("--peer 模式下 --selector 只允许字母、数字、点、下划线、冒号和连字符")
	}
	requested := strings.TrimSpace(options.peerAih)
	if requested == "" {
		requested = "aih"
	}
	if requested != "aih" && !peerCommandPattern.MatchString(requested) {
		return "", errors.New("--peer-aih 含不可安全转义的字符")
	}
	var last string
	for _, prefix := range peerCommandPrefixes(requested) {
		probeCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
		result, probeErr := client.Run(probeCtx, prefix+" proxy --help", 2048)
		cancel()
		if probeErr == nil && result.Code == 0 {
			command := prefix + " proxy serve --json --selector " + selector
			if options.noSocks {
				command += " --no-socks"
			}
			return command, nil
		}
		if probeErr != nil {
			last = probeErr.Error()
		} else if detail := sanitizePeerDiagnostic(string(result.Stderr), ""); detail != "" {
			last = detail
		}
	}
	if requested != "aih" {
		return "", fmt.Errorf("对等节点上的 aih 不可执行：%s%s", requested, peerDiagnosticSuffix(last, ""))
	}
	if last == "" {
		last = "未找到 aih"
	}
	return "", fmt.Errorf("对等节点未找到可用的 aih，请用 --peer-aih 指定路径（%s）", last)
}

// peerCommandPrefixes 覆盖 POSIX shell、Windows cmd 与 PowerShell 的调用写法。
// 非交互 SSH 没有统一 shell，因此按“固定候选逐个探测”而不是猜测远端平台。
func peerCommandPrefixes(requested string) []string {
	if requested != "aih" {
		if strings.ContainsAny(requested, " \t") {
			return []string{requested, `"` + requested + `"`, `& "` + requested + `"`}
		}
		return []string{requested}
	}
	return []string{
		"aih",
		"/opt/homebrew/bin/aih",
		"/usr/local/bin/aih",
		`"$HOME/.ai_home/bin/aih-go"`,
		`& "$HOME/.ai_home/bin/aih-go"`,
		`& "$env:USERPROFILE\.ai_home\bin\aih-go.exe"`,
		`"%USERPROFILE%\.ai_home\bin\aih-go.exe"`,
		`$env:USERPROFILE\.ai_home\bin\aih-go.exe`,
		`& "$env:LOCALAPPDATA\aih\aih.exe"`,
		`& "$env:USERPROFILE\AppData\Local\aih\aih.exe"`,
		`"%LOCALAPPDATA%\aih\aih.exe"`,
		`"%USERPROFILE%\AppData\Local\aih\aih.exe"`,
		`$env:LOCALAPPDATA\aih\aih.exe`,
		`$env:USERPROFILE\AppData\Local\aih\aih.exe`,
	}
}

func peerRemoteAddress(raw, scheme string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed == nil || !strings.EqualFold(parsed.Scheme, scheme) || parsed.Host == "" {
		return "", errors.New("对等节点返回的代理入口 URL 无效")
	}
	host, port, err := net.SplitHostPort(parsed.Host)
	if err != nil || port == "" {
		return "", errors.New("对等节点返回的代理入口端口无效")
	}
	if !isLoopbackPeerHost(host) {
		return "", errors.New("对等节点的代理入口不在 loopback 上")
	}
	return net.JoinHostPort(host, port), nil
}

func isLoopbackPeerHost(host string) bool {
	trimmed := strings.Trim(host, "[]")
	if strings.EqualFold(trimmed, "localhost") {
		return true
	}
	ip := net.ParseIP(trimmed)
	return ip != nil && ip.IsLoopback()
}

func rewritePeerProxyURL(raw, baseURL, scheme string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed == nil || parsed.Host == "" {
		return "", errors.New("对等节点返回的代理入口 URL 无效")
	}
	base, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil || base == nil || base.Host == "" {
		return "", errors.New("本机对等转发地址无效")
	}
	parsed.Scheme = scheme
	parsed.Host = base.Host
	return parsed.String(), nil
}

func peerSOCKSListenAddress(listen string) string {
	host, port, err := net.SplitHostPort(strings.TrimSpace(listen))
	if err != nil || port == "0" {
		return listen
	}
	return net.JoinHostPort(host, "0")
}

func writePeerServeOutput(runtime commandRuntime, options proxyServeOptions, payload peerServePayload, httpURL, socksURL string) {
	name := strings.TrimSpace(payload.Name)
	if name == "" {
		name = "对等节点"
	}
	if options.json {
		encoded, err := json.MarshalIndent(map[string]any{
			"ok":        true,
			"httpUrl":   httpURL,
			"socks5Url": socksURL,
			"name":      name,
			"selector":  options.selector,
			"transport": "ssh-peer",
			"peer":      options.peer,
			"via":       options.peerVia,
		}, "", "  ")
		if err == nil {
			_, _ = fmt.Fprintln(runtime.stdout, string(encoded))
		}
		return
	}
	_, _ = fmt.Fprintf(runtime.stdout, "[aih] SSH 对等中继：%s\n", options.peer)
	_, _ = fmt.Fprintf(runtime.stdout, "[aih] HTTP 代理入口：%s\n", httpURL)
	if socksURL != "" {
		_, _ = fmt.Fprintf(runtime.stdout, "[aih] SOCKS5 代理入口：%s\n", socksURL)
	}
	_, _ = fmt.Fprintf(runtime.stdout, "[aih] 出口：%s（在远端节点解析）\n", name)
	allProxy := httpURL
	if socksURL != "" {
		allProxy = socksURL
	}
	_, _ = fmt.Fprintf(runtime.stdout, "export HTTP_PROXY='%s' HTTPS_PROXY='%s' ALL_PROXY='%s'\n", httpURL, httpURL, allProxy)
	_, _ = fmt.Fprintln(runtime.stdout, "[aih] 按 Ctrl+C 结束本机转发；远端入口随 SSH 会话结束。")
}

func peerDiagnosticSuffix(raw, managementKey string) string {
	reason := sanitizePeerDiagnostic(raw, managementKey)
	if reason == "" {
		return ""
	}
	return "：" + reason
}

func sanitizePeerDiagnostic(raw, managementKey string) string {
	lines := strings.Split(strings.TrimSpace(raw), "\n")
	reason := ""
	for index := len(lines) - 1; index >= 0; index-- {
		if line := strings.TrimSpace(lines[index]); line != "" {
			reason = line
			break
		}
	}
	if reason == "" {
		return ""
	}
	if managementKey != "" {
		reason = strings.ReplaceAll(reason, managementKey, "***")
	}
	reason = peerUserinfoPattern.ReplaceAllString(reason, "://***@")
	if len(reason) > 400 {
		reason = reason[:400] + "…"
	}
	return reason
}

// peerTail 只保留最近 limit 字节的对等命令 stderr。
type peerTail struct {
	mu     sync.Mutex
	buffer []byte
	limit  int
}

func (tail *peerTail) Write(data []byte) (int, error) {
	if tail == nil {
		return len(data), nil
	}
	tail.mu.Lock()
	defer tail.mu.Unlock()
	tail.buffer = append(tail.buffer, data...)
	if tail.limit > 0 && len(tail.buffer) > tail.limit {
		tail.buffer = append([]byte(nil), tail.buffer[len(tail.buffer)-tail.limit:]...)
	}
	return len(data), nil
}

func (tail *peerTail) String() string {
	if tail == nil {
		return ""
	}
	tail.mu.Lock()
	defer tail.mu.Unlock()
	return string(tail.buffer)
}

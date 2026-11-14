package edgeproxy

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/hostexec"
	"github.com/madou1217/ai_home/internal/runtime/platform"
	"github.com/madou1217/ai_home/internal/runtime/toolkit/environment"
)

// ExecResult 抽象外部命令执行输出，便于单测注入。
type ExecResult struct {
	ExitCode int
	Stdout   string
	Stderr   string
}

// Runner 抽象命令执行器接口。
type Runner interface {
	Run(ctx context.Context, command string, args []string, timeout time.Duration) ExecResult
}

type hostExecRunner struct {
	exec hostexec.Executor
}

func (r hostExecRunner) Run(ctx context.Context, command string, args []string, timeout time.Duration) ExecResult {
	res := r.exec.Run(ctx, command, args, environment.ExecOptions{Timeout: timeout})
	exitCode := -1
	if res.ExitCode != nil {
		exitCode = *res.ExitCode
	}
	return ExecResult{
		ExitCode: exitCode,
		Stdout:   res.Stdout,
		Stderr:   res.Stderr,
	}
}

// FS 抽象本机文件系统探测与读写操作，支持单测注入虚拟/隔离实现。
type FS interface {
	Exists(path string) bool
	IsExecutable(path string) bool
	IsWritable(path string) bool
	ReadFile(path string) ([]byte, error)
	WriteFile(path string, data []byte, perm os.FileMode) error
	Rename(oldPath, newPath string) error
	Remove(path string) error
}

type osFS struct{}

func (osFS) Exists(path string) bool {
	if path == "" {
		return false
	}
	_, err := os.Stat(path)
	return err == nil
}

func (osFS) IsExecutable(path string) bool {
	if path == "" {
		return false
	}
	return platform.IsExecutable(path)
}

func (osFS) IsWritable(path string) bool {
	return platform.IsWritable(path)
}

func (osFS) ReadFile(path string) ([]byte, error) {
	return os.ReadFile(path)
}

func (osFS) WriteFile(path string, data []byte, perm os.FileMode) error {
	return os.WriteFile(path, data, perm)
}

func (osFS) Rename(oldPath, newPath string) error {
	return os.Rename(oldPath, newPath)
}

func (osFS) Remove(path string) error {
	return os.Remove(path)
}

// EdgeError 表示 Edge Proxy 业务领域错误，HTTP 层据此映射状态码。
type EdgeError struct {
	Code       string `json:"error"`
	Message    string `json:"message,omitempty"`
	Provider   string `json:"provider,omitempty"`
	ConfigPath string `json:"configPath,omitempty"`
	Detail     string `json:"detail,omitempty"`
	Mode       string `json:"mode,omitempty"`
}

func (e *EdgeError) Error() string {
	if e.Message != "" {
		return e.Message
	}
	return e.Code
}

// HTTPStatus 返回规范对应的 HTTP 状态码。
func (e *EdgeError) HTTPStatus() int {
	switch e.Code {
	case "edge_unknown_provider", "edge_domain_required", "edge_remote_port_required", "edge_invalid_mode":
		return 400
	case "edge_config_not_found":
		return 404
	case "edge_provider_not_installed":
		return 409
	case "edge_config_not_writable":
		return 403
	case "edge_config_rejected":
		return 422
	case "edge_apply_busy":
		return 429
	default:
		return 500
	}
}

// FrpEntry 表示一条 frpc 转发规则。
type FrpEntry struct {
	Name       string `json:"name"`
	Type       string `json:"type"`
	LocalIP    string `json:"localIP,omitempty"`
	LocalPort  int    `json:"localPort"`
	RemotePort int    `json:"remotePort"`
}

// PlanFile 表示计划生成或修改的单个配置文件。
type PlanFile struct {
	Path     string `json:"path"`
	Content  string `json:"content"`
	TopLevel bool   `json:"topLevel,omitempty"`
	Append   bool   `json:"append,omitempty"`
}

// Plan 表示针对指定边缘组件生成的配置变更方案。
type Plan struct {
	Kind    string     `json:"kind"`
	Name    string     `json:"name,omitempty"`
	Domain  string     `json:"domain,omitempty"`
	Mode    string     `json:"mode,omitempty"`
	Entries []FrpEntry `json:"entries,omitempty"`
	Files   []PlanFile `json:"files,omitempty"`
	Summary string     `json:"summary"`
	Notes   []string   `json:"notes"`
}

// FrpStatus 描述本机 frpc 探测状态。
type FrpStatus struct {
	Installed  bool       `json:"installed"`
	Binary     string     `json:"binary"`
	ConfigPath string     `json:"configPath"`
	Writable   bool       `json:"writable"`
	Proxies    []FrpProxy `json:"proxies"`
}

// NginxStatus 描述本机 nginx 探测状态。
type NginxStatus struct {
	Installed bool   `json:"installed"`
	Binary    string `json:"binary"`
	ConfigDir string `json:"configDir"`
	Version   string `json:"version"`
}

// CaddyStatus 描述本机 caddy 探测状态。
type CaddyStatus struct {
	Installed  bool   `json:"installed"`
	Binary     string `json:"binary"`
	ConfigPath string `json:"configPath"`
	Writable   bool   `json:"writable"`
}

// ProvidersStatus 汇总三大边缘代理状态。
type ProvidersStatus struct {
	Frp   FrpStatus   `json:"frp"`
	Nginx NginxStatus `json:"nginx"`
	Caddy CaddyStatus `json:"caddy"`
}

// StatusResponse 对应 GET /v0/webui/toolkit/edge 响应结构。
type StatusResponse struct {
	OK        bool            `json:"ok"`
	Platform  string          `json:"platform"`
	AIHPort   int             `json:"aihPort"`
	Providers ProvidersStatus `json:"providers"`
}

// PlanOptions 定义生成/应用边缘配置时的入参。
type PlanOptions struct {
	Domain            string
	Mode              string
	Name              string
	LocalPort         int
	RemotePort        int
	UDP               bool
	AIHPort           int
	CertDir           string
	TLSTerminatorPort int
	Reload            bool
	DryRun            bool
}

// WrittenFile 记录已写入配置及备份以便校验失败回滚。
type WrittenFile struct {
	Path       string `json:"path"`
	BackupPath string `json:"backupPath"`
	Existed    bool   `json:"existed"`
}

// ApplyResult 表示 POST /edge/apply 的完整结果。
type ApplyResult struct {
	OK          bool          `json:"ok"`
	DryRun      bool          `json:"dryRun,omitempty"`
	Plan        *Plan         `json:"plan,omitempty"`
	Provider    string        `json:"provider,omitempty"`
	ConfigPath  string        `json:"configPath,omitempty"`
	Summary     string        `json:"summary,omitempty"`
	BackupPath  string        `json:"backupPath,omitempty"`
	Entries     []FrpEntry    `json:"entries,omitempty"`
	Files       []WrittenFile `json:"files,omitempty"`
	Reloaded    bool          `json:"reloaded,omitempty"`
	ReloadedVia string        `json:"reloadedVia,omitempty"`
	Hint        string        `json:"hint,omitempty"`
	Detail      string        `json:"detail,omitempty"`
	ErrorCode   string        `json:"error,omitempty"`
}

// Service 提供边缘代理探测、方案生成及带回滚的应用执行能力。
type Service struct {
	fs        FS
	runner    Runner
	env       map[string]string
	now       func() time.Time
	applyLock sync.Mutex
}

// NewService 构造默认绑定真实 OS 文件系统与 hostexec 的 EdgeProxy 服务。
func NewService() *Service {
	return &Service{
		fs:     osFS{},
		runner: hostExecRunner{},
		env:    envMapFromOS(),
		now:    time.Now,
	}
}

// NewServiceWithDeps 允许测试注入自定义文件系统、执行器、环境变量与时钟。
func NewServiceWithDeps(fsImpl FS, runner Runner, env map[string]string, now func() time.Time) *Service {
	if fsImpl == nil {
		fsImpl = osFS{}
	}
	if runner == nil {
		runner = hostExecRunner{}
	}
	if env == nil {
		env = envMapFromOS()
	}
	if now == nil {
		now = time.Now
	}
	return &Service{
		fs:     fsImpl,
		runner: runner,
		env:    env,
		now:    now,
	}
}

func envMapFromOS() map[string]string {
	env := make(map[string]string)
	for _, entry := range os.Environ() {
		idx := strings.IndexByte(entry, '=')
		if idx <= 0 {
			continue
		}
		env[entry[:idx]] = entry[idx+1:]
	}
	return env
}

func nodePlatform() string {
	if runtime.GOOS == "windows" {
		return "win32"
	}
	return runtime.GOOS
}

func timestampSlug(t time.Time) string {
	utc := t.UTC().Format("2006-01-02T15:04:05.000Z")
	replacer := strings.NewReplacer(":", "-", ".", "-")
	return replacer.Replace(utc)
}

func (s *Service) resolveEnv() map[string]string {
	// 若使用真实进程环境，每次探测动态读取 OS 环境变量，避免 AIH_EDGE_CONTEXT 运行期变化丢失。
	if _, isOS := s.fs.(osFS); isOS {
		return envMapFromOS()
	}
	return s.env
}

func (s *Service) resolveBinary(contextKey string, defaults []string, env map[string]string) string {
	candidates := make([]string, 0, 1+len(defaults))
	if explicit := strings.TrimSpace(readEdgeContextField(env, contextKey)); explicit != "" {
		candidates = append(candidates, explicit)
	}
	candidates = append(candidates, defaults...)
	for _, c := range candidates {
		if s.fs.IsExecutable(c) {
			return c
		}
	}
	return ""
}

func (s *Service) resolveFrpConfigPath(env map[string]string) string {
	if explicit := strings.TrimSpace(readEdgeContextField(env, "frpcConfig")); explicit != "" {
		return explicit
	}
	for _, c := range frpConfigCandidates {
		if s.fs.Exists(c) {
			return c
		}
	}
	return ""
}

func (s *Service) resolveCaddyConfigPath(env map[string]string) string {
	if explicit := strings.TrimSpace(readEdgeContextField(env, "caddyfile")); explicit != "" {
		return explicit
	}
	for _, c := range caddyConfigCandidates {
		if s.fs.Exists(c) {
			return c
		}
	}
	return ""
}

func (s *Service) resolveNginxConfigDir(env map[string]string, versionOutput string) string {
	if explicit := strings.TrimSpace(readEdgeContextField(env, "nginxConfDir")); explicit != "" {
		return explicit
	}
	fromVersion := nginxConfigDirFromVersion(versionOutput)
	candidates := make([]string, 0, 1+len(nginxDirCandidates))
	if fromVersion != "" {
		candidates = append(candidates, fromVersion)
	}
	candidates = append(candidates, nginxDirCandidates...)
	for _, c := range candidates {
		if s.fs.Exists(c) {
			return c
		}
	}
	return ""
}

// Status 探测本机 frp / nginx / caddy 安装与配置状态。
func (s *Service) Status(ctx context.Context, aihPort int) StatusResponse {
	if aihPort <= 0 {
		aihPort = DefaultAIHPort
	}
	env := s.resolveEnv()

	frpBinary := s.resolveBinary("frpcBin", frpBinCandidates, env)
	frpConfig := s.resolveFrpConfigPath(env)
	proxies := []FrpProxy{}
	if frpConfig != "" {
		if raw, err := s.fs.ReadFile(frpConfig); err == nil {
			proxies = ListFrpProxies(string(raw))
		}
	}

	nginxBinary := s.resolveBinary("nginxBin", nginxBinCandidates, env)
	var nginxVersionOutput string
	if nginxBinary != "" {
		res := s.runner.Run(ctx, nginxBinary, []string{"-v"}, 15*time.Second)
		nginxVersionOutput = res.Stderr + res.Stdout
	}
	nginxVer := ""
	if m := reNginxVersion.FindStringSubmatch(nginxVersionOutput); m != nil {
		nginxVer = m[1]
	}

	caddyBinary := s.resolveBinary("caddyBin", caddyBinCandidates, env)
	caddyConfig := s.resolveCaddyConfigPath(env)

	return StatusResponse{
		OK:       true,
		Platform: nodePlatform(),
		AIHPort:  aihPort,
		Providers: ProvidersStatus{
			Frp: FrpStatus{
				Installed:  frpBinary != "",
				Binary:     frpBinary,
				ConfigPath: frpConfig,
				Writable:   s.fs.IsWritable(frpConfig),
				Proxies:    proxies,
			},
			Nginx: NginxStatus{
				Installed: nginxBinary != "",
				Binary:    nginxBinary,
				ConfigDir: s.resolveNginxConfigDir(env, nginxVersionOutput),
				Version:   nginxVer,
			},
			Caddy: CaddyStatus{
				Installed:  caddyBinary != "",
				Binary:     caddyBinary,
				ConfigPath: caddyConfig,
				Writable:   s.fs.IsWritable(caddyConfig),
			},
		},
	}
}

// Plan 生成不落盘的配置方案（dry-run / 复制粘贴用）。
func (s *Service) Plan(kind string, opts PlanOptions) (*Plan, *EdgeError) {
	aihPort := opts.AIHPort
	if aihPort <= 0 {
		aihPort = DefaultAIHPort
	}
	env := s.resolveEnv()

	switch kind {
	case "frp":
		return s.planFrp(opts, aihPort)
	case "nginx":
		return s.planNginx(opts, aihPort, env)
	case "caddy":
		return s.planCaddy(opts, aihPort, env)
	default:
		return nil, &EdgeError{
			Code:     "edge_unknown_provider",
			Provider: kind,
		}
	}
}

func (s *Service) planFrp(opts PlanOptions, aihPort int) (*Plan, *EdgeError) {
	if opts.RemotePort <= 0 {
		return nil, &EdgeError{Code: "edge_remote_port_required"}
	}
	name := strings.TrimSpace(opts.Name)
	if name == "" {
		name = "aih-server"
	}
	localPort := opts.LocalPort
	if localPort <= 0 {
		localPort = aihPort
	}
	entries := []FrpEntry{
		{Name: name, Type: "tcp", LocalPort: localPort, RemotePort: opts.RemotePort},
	}
	if opts.UDP {
		entries = append(entries, FrpEntry{
			Name:       name + "-udp",
			Type:       "udp",
			LocalPort:  localPort,
			RemotePort: opts.RemotePort,
		})
	}
	udpTag := ""
	udpNote := "未含 UDP：QUIC 由客户端回落 TCP"
	if opts.UDP {
		udpTag = " + UDP"
		udpNote = "含同号 UDP 条目：QUIC/HTTP3 走它"
	}
	return &Plan{
		Kind:    "frp",
		Name:    name,
		Entries: entries,
		Summary: fmt.Sprintf("frp：本机 %d（TCP%s）→ 远端 %d", localPort, udpTag, opts.RemotePort),
		Notes: []string{
			fmt.Sprintf("客户端条目会是 socks5, <frp 服务端地址>, %d, <用户名>, <密码>", opts.RemotePort),
			udpNote,
		},
	}, nil
}

func (s *Service) planNginx(opts PlanOptions, aihPort int, env map[string]string) (*Plan, *EdgeError) {
	domain := strings.TrimSpace(opts.Domain)
	if domain == "" {
		return nil, &EdgeError{Code: "edge_domain_required"}
	}
	resolvedMode, edgeErr := normalizeNginxMode(opts.Mode)
	if edgeErr != nil {
		return nil, edgeErr
	}
	tlsPort := opts.TLSTerminatorPort
	if tlsPort <= 0 {
		tlsPort = DefaultTLSTerminatorPort
	}
	configDir := s.resolveNginxConfigDir(env, "")
	if configDir == "" {
		configDir = "/etc/nginx"
	}
	streamFileName, siteFileName := nginxFileNames(domain)
	streamPath := filepath.Join(configDir, streamFileName)
	sitePath := filepath.Join(configDir, "conf.d", siteFileName)

	var files []PlanFile
	var summary string
	var notes []string

	switch resolvedMode {
	case "passthrough":
		files = []PlanFile{
			{Path: streamPath, Content: nginxPassthroughStreamConfig(aihPort), TopLevel: true},
		}
		summary = fmt.Sprintf("nginx：443/TCP+UDP 纯透传 —— 客户端 socks5, %s, 443（WebUI 只能 http）", domain)
		notes = []string{"纯四层透传：WebUI 只能 http；SOCKS5 与 UDP 都能用"}
	case "split":
		files = []PlanFile{
			{Path: streamPath, Content: nginxStreamConfig(aihPort, tlsPort), TopLevel: true},
			{Path: sitePath, Content: nginxSiteConfig(domain, aihPort, tlsPort, opts.CertDir)},
		}
		summary = fmt.Sprintf("nginx：443/TCP 分流（TLS→WebUI，SOCKS5→AIH）+ 443/UDP 透传 —— 客户端 socks5, %s, 443", domain)
		certHint := opts.CertDir
		if certHint == "" {
			certHint = fmt.Sprintf("/etc/letsencrypt/live/%s", domain)
		}
		notes = []string{
			"需要 nginx ≥ 1.25（ssl_preread_protocol）",
			fmt.Sprintf("证书目录：%s", certHint),
		}
	default:
		files = []PlanFile{
			{Path: sitePath, Content: nginxHTTPOnlySiteConfig(domain, aihPort, opts.CertDir)},
		}
		summary = "nginx：仅 https 反代 WebUI（SOCKS5 不在这个端口）"
		notes = []string{"只有应用层：SOCKS5 上不来，中转走 frp 或 dedicated 模式"}
	}

	return &Plan{
		Kind:    "nginx",
		Domain:  domain,
		Mode:    resolvedMode,
		Files:   files,
		Summary: summary,
		Notes:   notes,
	}, nil
}

func (s *Service) planCaddy(opts PlanOptions, aihPort int, env map[string]string) (*Plan, *EdgeError) {
	domain := strings.TrimSpace(opts.Domain)
	if domain == "" {
		return nil, &EdgeError{Code: "edge_domain_required"}
	}
	configPath := s.resolveCaddyConfigPath(env)
	if configPath == "" {
		return nil, &EdgeError{Code: "edge_config_not_found"}
	}
	return &Plan{
		Kind:   "caddy",
		Domain: domain,
		Files: []PlanFile{
			{Path: configPath, Content: caddySiteConfig(domain, aihPort), Append: true},
		},
		Summary: fmt.Sprintf("Caddy：https://%s → AIH（证书自动申请）", domain),
		Notes:   []string{"标准 Caddy 不做四层转发；SOCKS5 中转请用 nginx 的 split 形态或 frp"},
	}, nil
}

// Apply 以单飞互斥锁执行「备份 → 写入 → 校验 → 重载（失败回滚）」。
func (s *Service) Apply(ctx context.Context, kind string, opts PlanOptions) (*ApplyResult, *EdgeError) {
	if !s.applyLock.TryLock() {
		return nil, &EdgeError{Code: "edge_apply_busy"}
	}
	defer s.applyLock.Unlock()

	plan, err := s.Plan(kind, opts)
	if err != nil {
		return nil, err
	}
	if opts.DryRun {
		return &ApplyResult{OK: true, DryRun: true, Plan: plan}, nil
	}

	env := s.resolveEnv()
	switch kind {
	case "frp":
		return s.applyFrp(ctx, plan, opts, env)
	case "nginx":
		return s.applyNginx(ctx, plan, opts, env)
	case "caddy":
		return s.applyCaddy(ctx, plan, opts, env)
	default:
		return nil, &EdgeError{Code: "edge_unknown_provider", Provider: kind}
	}
}

func (s *Service) applyFrp(ctx context.Context, plan *Plan, opts PlanOptions, env map[string]string) (*ApplyResult, *EdgeError) {
	binary := s.resolveBinary("frpcBin", frpBinCandidates, env)
	if binary == "" {
		return nil, &EdgeError{Code: "edge_provider_not_installed", Provider: "frp"}
	}
	configPath := s.resolveFrpConfigPath(env)
	if configPath == "" {
		return nil, &EdgeError{Code: "edge_config_not_found", Provider: "frp"}
	}
	if !s.fs.IsWritable(configPath) {
		return nil, &EdgeError{Code: "edge_config_not_writable", ConfigPath: configPath}
	}
	originalBytes, err := s.fs.ReadFile(configPath)
	if err != nil {
		return nil, &EdgeError{Code: "edge_request_failed", Message: err.Error()}
	}
	next := string(originalBytes)
	for _, entry := range plan.Entries {
		next = UpsertFrpProxy(next, entry)
	}

	staged := configPath + ".aih-staged"
	if _, err := s.writeAtomic(staged, []byte(next), false); err != nil {
		return nil, &EdgeError{Code: "edge_request_failed", Message: err.Error()}
	}
	verified := s.runner.Run(ctx, binary, []string{"verify", "-c", staged}, 15*time.Second)
	if verified.ExitCode != 0 {
		_ = s.fs.Remove(staged)
		detail := trimOutput(verified.Stderr, verified.Stdout, 400)
		return nil, &EdgeError{Code: "edge_config_rejected", Detail: detail}
	}

	backupPath, err := s.writeAtomic(configPath, []byte(next), true)
	_ = s.fs.Remove(staged)
	if err != nil {
		return nil, &EdgeError{Code: "edge_request_failed", Message: err.Error()}
	}

	result := &ApplyResult{
		OK:         true,
		Provider:   "frp",
		ConfigPath: configPath,
		Summary:    plan.Summary,
		BackupPath: backupPath,
		Entries:    plan.Entries,
	}
	if opts.Reload {
		reloaded, via, detail, hint := s.reloadFrp(ctx, env)
		result.Reloaded = reloaded
		result.ReloadedVia = via
		result.Detail = detail
		result.Hint = hint
	}
	return result, nil
}

func (s *Service) reloadFrp(ctx context.Context, env map[string]string) (reloaded bool, via, detail, hint string) {
	home := env["HOME"]
	plist := filepath.Join(home, "Library/LaunchAgents/homebrew.mxcl.frpc.plist")
	if home != "" && s.fs.Exists(plist) {
		res := s.runner.Run(ctx, "brew", []string{"services", "restart", "frpc"}, 15*time.Second)
		if res.ExitCode == 0 {
			return true, "brew-services", "", ""
		}
		return false, "brew-services", trimOutput(res.Stderr, "", 200), ""
	}
	userUnit := filepath.Join(home, ".config/systemd/user/frpc.service")
	if home != "" && s.fs.Exists(userUnit) {
		res := s.runner.Run(ctx, "systemctl", []string{"--user", "restart", "frpc"}, 15*time.Second)
		if res.ExitCode == 0 {
			return true, "systemd-user", "", ""
		}
		return false, "systemd-user", trimOutput(res.Stderr, "", 200), ""
	}
	return false, "", "", "frpc 不由本机服务管理器管：请手动重启它"
}

func (s *Service) applyNginx(ctx context.Context, plan *Plan, opts PlanOptions, env map[string]string) (*ApplyResult, *EdgeError) {
	binary := s.resolveBinary("nginxBin", nginxBinCandidates, env)
	if binary == "" {
		return nil, &EdgeError{Code: "edge_provider_not_installed", Provider: "nginx"}
	}
	written := make([]WrittenFile, 0, len(plan.Files)+1)
	for _, file := range plan.Files {
		if !s.fs.IsWritable(filepath.Dir(file.Path)) {
			s.rollback(written)
			return nil, &EdgeError{Code: "edge_config_not_writable", ConfigPath: file.Path}
		}
		backupPath, err := s.writeAtomic(file.Path, []byte(file.Content), true)
		if err != nil {
			s.rollback(written)
			return nil, &EdgeError{Code: "edge_request_failed", Message: err.Error()}
		}
		written = append(written, WrittenFile{
			Path:       file.Path,
			BackupPath: backupPath,
			Existed:    backupPath != "",
		})
		if file.TopLevel {
			if inc, err := s.ensureTopLevelInclude(file.Path); err != nil {
				s.rollback(written)
				return nil, &EdgeError{Code: "edge_request_failed", Message: err.Error()}
			} else if inc != nil {
				written = append(written, *inc)
			}
		}
	}

	checked := s.runner.Run(ctx, binary, []string{"-t"}, 15*time.Second)
	if checked.ExitCode != 0 {
		s.rollback(written)
		return nil, &EdgeError{
			Code:   "edge_config_rejected",
			Detail: trimOutput(checked.Stderr, checked.Stdout, 400),
		}
	}

	res := &ApplyResult{
		OK:       true,
		Provider: "nginx",
		Summary:  plan.Summary,
		Files:    written,
	}
	if opts.Reload {
		reloaded := s.runner.Run(ctx, binary, []string{"-s", "reload"}, 15*time.Second)
		res.Reloaded = reloaded.ExitCode == 0
		res.ReloadedVia = "nginx-s"
	}
	return res, nil
}

func (s *Service) ensureTopLevelInclude(filePath string) (*WrittenFile, error) {
	mainConf := filepath.Join(filepath.Dir(filePath), "nginx.conf")
	if !s.fs.Exists(mainConf) {
		return nil, nil
	}
	raw, err := s.fs.ReadFile(mainConf)
	if err != nil {
		return nil, err
	}
	text := string(raw)
	if strings.Contains(text, filePath) {
		return nil, nil
	}
	lines := strings.Split(text, "\n")
	httpIdx := -1
	for i, line := range lines {
		if reHTTPBlock.MatchString(line) {
			httpIdx = i
			break
		}
	}
	includeLine := fmt.Sprintf("include %s;  # aih-edge:%s", filePath, filepath.Base(filePath))
	if httpIdx >= 0 {
		updated := make([]string, 0, len(lines)+1)
		updated = append(updated, lines[:httpIdx]...)
		updated = append(updated, includeLine)
		updated = append(updated, lines[httpIdx:]...)
		lines = updated
	} else {
		lines = append(lines, includeLine)
	}
	backupPath, err := s.writeAtomic(mainConf, []byte(strings.Join(lines, "\n")), true)
	if err != nil {
		return nil, err
	}
	return &WrittenFile{Path: mainConf, BackupPath: backupPath, Existed: true}, nil
}

func (s *Service) applyCaddy(ctx context.Context, plan *Plan, opts PlanOptions, env map[string]string) (*ApplyResult, *EdgeError) {
	binary := s.resolveBinary("caddyBin", caddyBinCandidates, env)
	if binary == "" {
		return nil, &EdgeError{Code: "edge_provider_not_installed", Provider: "caddy"}
	}
	if len(plan.Files) == 0 {
		return nil, &EdgeError{Code: "edge_config_not_found"}
	}
	target := plan.Files[0].Path
	exists := s.fs.Exists(target)
	writable := false
	if exists {
		writable = s.fs.IsWritable(target)
	} else {
		writable = s.fs.IsWritable(filepath.Dir(target))
	}
	if !writable {
		return nil, &EdgeError{Code: "edge_config_not_writable", ConfigPath: target}
	}

	var original []byte
	if exists {
		var err error
		original, err = s.fs.ReadFile(target)
		if err != nil {
			return nil, &EdgeError{Code: "edge_request_failed", Message: err.Error()}
		}
	}
	next := ReplaceManagedBlock(string(original), plan.Domain, plan.Files[0].Content, EdgeBlockPrefix)
	backupPath, err := s.writeAtomic(target, []byte(next), true)
	if err != nil {
		return nil, &EdgeError{Code: "edge_request_failed", Message: err.Error()}
	}

	checked := s.runner.Run(ctx, binary, []string{"validate", "--config", target, "--adapter", "caddyfile"}, 15*time.Second)
	if checked.ExitCode != 0 {
		if exists {
			_, _ = s.writeAtomic(target, original, false)
		} else {
			_ = s.fs.Remove(target)
		}
		return nil, &EdgeError{
			Code:   "edge_config_rejected",
			Detail: trimOutput(checked.Stderr, checked.Stdout, 400),
		}
	}

	res := &ApplyResult{
		OK:         true,
		Provider:   "caddy",
		ConfigPath: target,
		BackupPath: backupPath,
		Summary:    plan.Summary,
	}
	if opts.Reload {
		reloaded := s.runner.Run(ctx, binary, []string{"reload", "--config", target, "--adapter", "caddyfile"}, 15*time.Second)
		res.Reloaded = reloaded.ExitCode == 0
		res.ReloadedVia = "caddy-reload"
	}
	return res, nil
}

func (s *Service) writeAtomic(target string, content []byte, backup bool) (string, error) {
	backupPath := ""
	perm := os.FileMode(0644)
	if s.fs.Exists(target) {
		if info, err := os.Stat(target); err == nil {
			perm = info.Mode().Perm()
		}
		if backup {
			existing, err := s.fs.ReadFile(target)
			if err != nil {
				return "", err
			}
			backupPath = fmt.Sprintf("%s.bak-%s", target, timestampSlug(s.now()))
			if err := s.fs.WriteFile(backupPath, existing, perm); err != nil {
				return "", err
			}
		}
	}
	temp := fmt.Sprintf("%s.aih-tmp-%d", target, os.Getpid())
	if err := s.fs.WriteFile(temp, content, perm); err != nil {
		return "", err
	}
	if err := s.fs.Rename(temp, target); err != nil {
		_ = s.fs.Remove(temp)
		return "", err
	}
	return backupPath, nil
}

func (s *Service) rollback(written []WrittenFile) {
	for _, f := range written {
		if f.Existed && f.BackupPath != "" {
			if raw, err := s.fs.ReadFile(f.BackupPath); err == nil {
				_ = s.fs.WriteFile(f.Path, raw, 0644)
			}
		} else {
			_ = s.fs.Remove(f.Path)
		}
	}
}

func trimOutput(primary, secondary string, limit int) string {
	text := strings.TrimSpace(primary)
	if text == "" {
		text = strings.TrimSpace(secondary)
	}
	runes := []rune(text)
	if len(runes) > limit {
		return string(runes[:limit])
	}
	return text
}

// IsEdgeError 将 error 断言为 *EdgeError。
func IsEdgeError(err error) (*EdgeError, bool) {
	var edgeErr *EdgeError
	if errors.As(err, &edgeErr) {
		return edgeErr, true
	}
	return nil, false
}

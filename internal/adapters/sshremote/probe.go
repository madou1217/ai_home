package sshremote

import (
	"context"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/sshhost"
)

const maxProbeOutputBytes = 256 << 10

// 探测状态；与 Node ssh-host-probe 的取值一致。
const (
	ProbeReachable    = "reachable"
	ProbeAuthRequired = "auth-required"
	ProbeUnreachable  = "unreachable"
)

// ProbeResult 是 SSH 连通性探测结果，字段与 Node probeSshTarget 的返回体对齐。
type ProbeResult struct {
	Kind     string          `json:"kind"`
	Target   string          `json:"target"`
	Host     string          `json:"host"`
	User     string          `json:"user"`
	Port     int             `json:"port"`
	Status   string          `json:"status"`
	Platform string          `json:"platform"`
	Arch     string          `json:"arch"`
	Commands map[string]bool `json:"commands"`
	// Repo 与 bootstrap* 是 Node 探测契约的保留字段；Go 第一切片不探测仓库。
	Repo             ProbeRepo `json:"repo"`
	Stderr           string    `json:"stderr"`
	TimedOut         bool      `json:"timedOut"`
	Recommendation   string    `json:"recommendation"`
	BootstrapTarget  string    `json:"bootstrapTarget"`
	BootstrapCommand string    `json:"bootstrapCommand"`
	BootstrapAction  any       `json:"bootstrapAction"`
}

// ProbeRepo 与 Node 的 repo 字段对齐；Present 用指针保留 null。
type ProbeRepo struct {
	Checked bool   `json:"checked"`
	Present *bool  `json:"present"`
	Path    string `json:"path"`
}

// Prober 是管理接口的探测端口实现；零值可用。
type Prober struct {
	// HomeDir 用于 ~ 展开与 known_hosts 默认位置；空值取当前用户家目录。
	HomeDir string
	// KnownHostsPath 覆盖 known_hosts 路径；空值用 <HomeDir>/.ssh/known_hosts。
	KnownHostsPath string
}

// Probe 对一条连接做只读探测：能不能连、平台与架构、常用命令是否在 PATH。
//
// 连接/认证失败不会返回 error，而是映射成 status=unreachable / auth-required，
// 与 Node 的探针契约一致；error 只用于探测流程本身无法继续的情况。
func (prober Prober) Probe(ctx context.Context, config Config, timeout time.Duration) (ProbeResult, error) {
	if timeout <= 0 {
		timeout = sshhost.DefaultProbeTimeout
	}
	if config.HomeDir == "" {
		config.HomeDir = prober.HomeDir
	}
	if config.KnownHostsPath == "" {
		config.KnownHostsPath = prober.KnownHostsPath
	}
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	result := baseProbeResult(config)
	client, err := Dial(runCtx, config, timeout)
	if err != nil {
		fillProbeFailure(&result, err, runCtx)
		return result, nil
	}
	defer func() { _ = client.Close() }()

	run, err := client.Run(runCtx, sshhost.BuildRemoteProbeCommand(), maxProbeOutputBytes)
	if err != nil {
		fillProbeFailure(&result, err, runCtx)
		return result, nil
	}
	facts := sshhost.ParseFacts(string(run.Stdout))
	if run.Code != 0 {
		// 远端默认 shell 是 cmd/PowerShell 时 POSIX 脚本会失败，再试一次 PowerShell。
		windowsRun, windowsErr := client.Run(runCtx, sshhost.BuildWindowsRemoteProbeCommand(), maxProbeOutputBytes)
		windowsFacts := sshhost.ParseFacts(string(windowsRun.Stdout))
		if windowsErr == nil && (windowsRun.Code == 0 || windowsFacts["platform"] != "") {
			run = windowsRun
			facts = windowsFacts
		}
	}
	fillProbeFacts(&result, run.Code, facts, string(run.Stderr))
	return result, nil
}

// baseProbeResult 预填连接身份字段。
func baseProbeResult(config Config) ProbeResult {
	port := config.port()
	label := strings.TrimSpace(config.User)
	if label == "" {
		label = strings.TrimSpace(config.Host)
	} else {
		label += "@" + strings.TrimSpace(config.Host)
	}
	return ProbeResult{
		Kind:     "ssh",
		Target:   label,
		Host:     strings.TrimSpace(config.Host),
		User:     strings.TrimSpace(config.User),
		Port:     port,
		Commands: map[string]bool{"node": false, "npm": false, "git": false, "aih": false},
	}
}

// fillProbeFailure 把拨号/执行错误映射成探针状态。
func fillProbeFailure(result *ProbeResult, err error, ctx context.Context) {
	result.Status = ProbeUnreachable
	if ErrorCode(err) == CodeAuthFailed {
		result.Status = ProbeAuthRequired
	}
	if ErrorCode(err) == CodeTimeout || ctx.Err() == context.DeadlineExceeded {
		result.TimedOut = true
	}
	result.Stderr = truncateRunes(strings.TrimSpace(err.Error()), 1000)
	result.Recommendation = sshhost.RecommendationFor(result.Status, nil)
}

// fillProbeFacts 填入远端事实并给出状态与建议。
func fillProbeFacts(result *ProbeResult, code int, facts map[string]string, stderr string) {
	status := ProbeUnreachable
	if code == 0 {
		status = ProbeReachable
	}
	result.Status = status
	result.Platform = strings.TrimSpace(facts["platform"])
	result.Arch = strings.TrimSpace(facts["arch"])
	result.Commands = map[string]bool{
		"node": facts["node"] == "present",
		"npm":  facts["npm"] == "present",
		"git":  facts["git"] == "present",
		"aih":  facts["aih"] == "present",
	}
	result.Stderr = truncateRunes(strings.TrimSpace(stderr), 1000)
	result.Recommendation = sshhost.RecommendationFor(status, facts)
}

// truncateRunes 按字符截断，避免把多字节汉字切成半个。
func truncateRunes(value string, limit int) string {
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit])
}

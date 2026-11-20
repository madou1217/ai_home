// Package claudepreflight 统一 Claude Code 首屏连通性检查（onboarding preflight）
// 的配置模型与探测口径，供 WebUI 设置与 CLI 启动共用。
//
// Claude Code 2.1.3xx 在未完成 onboarding 的配置上会先请求 api.anthropic.com 与
// platform.claude.com；被墙或代理不可达时停在 403 欢迎页，第三方 Base URL 也无法
// 进入会话。aih 的默认策略是关闭该检查，并按首次探测结果自动决定是否保留。
package claudepreflight

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// Key 是 app-state 中保存首屏检查策略的键。
const Key = "config:claude-preflight"

// Mode 是用户选择的策略；auto 表示按环境探测结果自动决定。
type Mode string

const (
	ModeAuto Mode = "auto"
	ModeOn   Mode = "on"
	ModeOff  Mode = "off"
)

const (
	helloURL      = "https://api.anthropic.com/api/hello"
	oauthHelloURL = "https://platform.claude.com/v1/oauth/hello"
	defaultProbe  = 4 * time.Second
)

// Record 是持久化的策略与最近一次探测结果。
type Record struct {
	Mode      Mode   `json:"mode"`
	Reachable *bool  `json:"reachable,omitempty"`
	CheckedAt int64  `json:"checked_at,omitempty"`
	Detail    string `json:"detail,omitempty"`
}

// Result 是一次双端点探测的结论；两个端点都返回 200 才算可达。
type Result struct {
	Reachable bool
	Detail    string
}

// Normalize 把 app-state 原始 JSON 规范化为策略记录；未知值回落 auto。
func Normalize(raw string, found bool) Record {
	record := Record{Mode: ModeAuto}
	if !found || strings.TrimSpace(raw) == "" {
		return record
	}
	var input Record
	if json.Unmarshal([]byte(raw), &input) != nil {
		return record
	}
	switch input.Mode {
	case ModeOn, ModeOff, ModeAuto:
		record.Mode = input.Mode
	}
	record.Reachable = input.Reachable
	record.CheckedAt = input.CheckedAt
	record.Detail = strings.TrimSpace(input.Detail)
	return record
}

// Effective 返回首屏检查当前是否生效（true = 保留检查，false = 启动时跳过）。
func (record Record) Effective() bool {
	switch record.Mode {
	case ModeOn:
		return true
	case ModeOff:
		return false
	default:
		return record.Reachable != nil && *record.Reachable
	}
}

// Encode 返回可写入 app-state 的规范 JSON。
func (record Record) Encode() string {
	encoded, err := json.Marshal(record)
	if err != nil {
		return `{"mode":"auto"}`
	}
	return string(encoded)
}

// NewClient 返回遵循 HTTPS_PROXY/NO_PROXY 的探测客户端，与 Claude Code 自身的
// 代理发现口径一致。
//
// Server 进程会把 http.DefaultTransport 换成自定义 egress RoundTripper；这里不能
// 直接断言 *http.Transport，能克隆就克隆，否则沿用宿主已安装的传输层。
func NewClient(timeout time.Duration) *http.Client {
	if timeout <= 0 {
		timeout = defaultProbe
	}
	transport := http.DefaultTransport
	if standard, ok := transport.(*http.Transport); ok {
		transport = standard.Clone()
	}
	return &http.Client{Transport: transport, Timeout: timeout}
}

// Probe 并行检查两个首屏端点；任一失败即视为不可达，并保留各自的简略原因。
func Probe(ctx context.Context, client *http.Client, timeout time.Duration) Result {
	if client == nil {
		client = NewClient(timeout)
	}
	if timeout <= 0 {
		timeout = defaultProbe
	}
	targets := []string{helloURL, oauthHelloURL}
	outcomes := make([]string, len(targets))
	reachable := make([]bool, len(targets))
	var wait sync.WaitGroup
	for index, target := range targets {
		wait.Add(1)
		go func(index int, target string) {
			defer wait.Done()
			parsed, err := url.Parse(target)
			host := target
			if err == nil {
				host = parsed.Host
			}
			requestCtx, cancel := context.WithTimeout(ctx, timeout)
			defer cancel()
			request, err := http.NewRequestWithContext(requestCtx, http.MethodGet, target, nil)
			if err != nil {
				outcomes[index] = host + ": 请求无效"
				return
			}
			// 不注入任何自定义 UA：这是纯连通性探测，冒充官方客户端或自报
			// 「aih-…」标识都会在官方端点留下可区分的非官方指纹。
			response, err := client.Do(request)
			if err != nil {
				outcomes[index] = host + ": " + compactError(err)
				return
			}
			defer response.Body.Close()
			_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 1024))
			outcomes[index] = fmt.Sprintf("%s: HTTP %d", host, response.StatusCode)
			reachable[index] = response.StatusCode == http.StatusOK
		}(index, target)
	}
	wait.Wait()
	success := true
	for _, ok := range reachable {
		success = success && ok
	}
	return Result{Reachable: success, Detail: strings.Join(outcomes, "; ")}
}

// compactError 只保留可读的错误摘要，避免把长 URL 或代理凭据带进配置。
func compactError(err error) string {
	if err == nil {
		return ""
	}
	message := strings.TrimSpace(strings.ReplaceAll(err.Error(), "\n", " "))
	if len(message) > 96 {
		message = message[:96]
	}
	return message
}

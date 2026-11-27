package providercli

import (
	"context"
	"errors"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	appprojection "github.com/madou1217/ai_home/application/accountprojection"
	codebuddyfamilystorage "github.com/madou1217/ai_home/internal/adapters/providerstorage/codebuddyfamily"
)

// defaultProjectionCaptureInterval 是运行中投影凭据的轮询间隔。
//
// 凭据文件只在客户端刷新 token 时变化，频率很低；2 秒足够让第二个窗口/WebUI
// 在用户感知不到延迟的情况下看到新凭据，又不会产生可观测的 CPU 开销。
const defaultProjectionCaptureInterval = 2 * time.Second

// startProjectionCaptureWatcher 在官方 CLI 仍运行时轮询投影里的凭据文件。
//
// 退出后的 Capture 只能覆盖"用户主动退出"这一种情况；长时间运行的交互式
// 会话在收到 401 后由官方 CLI 自行刷新并轮换 refresh_token，如果等退出再
// 回写，第二个窗口/WebUI 会继续读旧 token。这里在文件变化时立即 Capture，
// 失败时保留旧指纹并在下一轮重试。
//
// 监听路径来自 Policy.AuthArtifacts（Provisioner 的 CredentialPathProvider），
// 因此同时覆盖 CodeBuddy 家族、Codex、Gemini、AGY、Grok、Cline、Kimi、Kiro、
// OpenCode、ZCode、Qoder 等所有文件形态的 OAuth Provider。Codex/Claude 的
// 内存 Token Runtime 不落投影文件，由各自的 401 重放路径负责，不会在这里触发。
func (runner *Runner) startProjectionCaptureWatcher(
	ctx context.Context,
	request appprojection.Request,
	result appprojection.Result,
) func() {
	noop := func() {}
	if runner == nil || runner.projection == nil || ctx == nil ||
		!request.ProjectionRequired || strings.TrimSpace(result.Root) == "" {
		return noop
	}
	pathProvider, ok := runner.projection.(appprojection.CredentialPathProvider)
	if !ok {
		return noop
	}
	paths := pathProvider.CredentialPaths(ctx, request, result)
	if len(paths) == 0 {
		return noop
	}
	interval := runner.projectionCaptureInterval
	if interval <= 0 {
		interval = defaultProjectionCaptureInterval
	}
	stop := make(chan struct{})
	done := make(chan struct{})
	var stopOnce sync.Once
	// 基线必须在子进程启动前同步取好：CLI 可能在启动后几毫秒内刷新 token，
	// 如果 goroutine 晚于这次刷新才拍基线，就会把新 token 当成旧状态。
	last := credentialFingerprint(paths)
	go func() {
		defer close(done)
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
			next := credentialFingerprint(paths)
			if next == "" || next == last {
				continue
			}
			captureCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), projectionCaptureTimeout)
			err := runner.captureProjection(captureCtx, request, result)
			cancel()
			switch {
			case err == nil:
				last = next
			case errors.Is(err, codebuddyfamilystorage.ErrIdentityMismatch):
				// 投影里是另一个账号的凭据：绝不回写，也不再反复尝试同一份文件。
				last = next
			default:
				// 文件可能正在写入或数据库暂时忙：保留旧指纹，下一轮重试。
			}
		}
	}()
	return func() {
		stopOnce.Do(func() { close(stop) })
		<-done
	}
}

// credentialFingerprint 对策略声明的凭据文件做轻量指纹。
//
// 文件缺失也进入指纹（记为 missing），这样"首次创建"同样会触发采集。
func credentialFingerprint(paths []string) string {
	if len(paths) == 0 {
		return ""
	}
	sorted := append([]string(nil), paths...)
	sort.Strings(sorted)
	var builder strings.Builder
	for _, path := range sorted {
		builder.WriteString(path)
		builder.WriteByte(0)
		info, err := os.Stat(path)
		if err != nil || info == nil {
			builder.WriteString("missing")
			builder.WriteByte('\n')
			continue
		}
		builder.WriteString(strconv.FormatInt(info.ModTime().UnixNano(), 10))
		builder.WriteByte(0)
		builder.WriteString(strconv.FormatInt(info.Size(), 10))
		builder.WriteByte('\n')
	}
	return builder.String()
}

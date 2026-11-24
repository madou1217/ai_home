package updateproxy

import (
	"context"
	"errors"
	"fmt"
	"strings"
)

// EgressLease 是一次任务期出口：loopback HTTP 代理地址 + 可展示的出口名。
// Release 必须幂等，且任务取消后仍要能释放远端租约。
type EgressLease struct {
	URL  string
	Name string
	// AnonymousURL 是不要求 Proxy-Authorization 的 loopback 入口；为空表示
	// 当前来源没有提供。
	//
	// 为什么需要第二个入口：一部分 Windows 客户端**只接受无认证代理**。
	// 实测 winget 的 --proxy 会把 URL 里的 userinfo 丢掉，请求不带
	// Proxy-Authorization，带认证的入口一律 407；而配上匿名入口后
	// （--proxy http://127.0.0.1:<port>）源、清单与实际安装包下载都走了代理。
	// PowerShell 的 WebProxy 同理——它需要显式 Credentials，另一条分支处理。
	//
	// 安全边界：只监听 loopback，作用域与系统代理入口相同（系统代理同样无法
	// 携带凭据，仓库里早有 AllowAnonymous 先例）。
	AnonymousURL string
	// Identity 是该出口在健康账本中的键；为空表示该来源没有账本条目。
	Identity string
	Release  func()
}

// EgressCandidateSource 返回受管出口候选的稳定 ID，顺序即优先级。
//
// 顺序与可用性都归服务端：客户端不重新打分、不本地猜测哪个出口更快，
// 否则同一份策略会在两处推导出不同结论。
type EgressCandidateSource func(ctx context.Context) ([]string, error)

// EgressAcquirer 用稳定 ID 换取任务期出口。
type EgressAcquirer func(ctx context.Context, selector string) (EgressLease, error)

// EgressNotifier 接收面向用户的告知文本。展示位置（终端 stderr、作业日志）
// 由调用方决定；本包不直接写任何输出。
type EgressNotifier func(message string)

// EgressAttempt 是轮换状态机的一步结果。
type EgressAttempt struct {
	// Lease 是当前可用的出口。
	Lease EgressLease
	// Message 是需要显示的告知（首次启用 / 切换出口 / 全部耗尽）。
	Message string
	// Exhausted 表示所有候选都试过了。
	Exhausted bool
}

// EgressRotation 负责「网络失败后自动选出口 + 失败则换下一个」这一条状态机。
//
// 责任边界：它只知道候选顺序和自己试过哪些出口，不理解安装器、不理解厂商。
// 「这次失败是否属于网络不可用」由调用方判定，避免把版本不存在、权限不足
// 这类与出口无关的失败也送进代理重试。
type EgressRotation struct {
	source  EgressCandidateSource
	acquire EgressAcquirer
	notify  EgressNotifier
	tried   map[string]struct{}
	current *EgressLease
	// failed 记住刚失败的出口与原因，用于下一条切换告知。
	failed       string
	failedReason string
	started      bool
}

// NewEgressRotation 创建轮换状态机；source 决定候选顺序，acquire 换取租约。
func NewEgressRotation(source EgressCandidateSource, acquire EgressAcquirer, notify EgressNotifier) *EgressRotation {
	if notify == nil {
		notify = func(string) {}
	}
	return &EgressRotation{source: source, acquire: acquire, notify: notify, tried: map[string]struct{}{}}
}

// Active 报告当前是否持有一个已选出的出口。
func (rotation *EgressRotation) Active() bool {
	return rotation != nil && rotation.current != nil
}

// Current 返回当前出口（可能为空）。
func (rotation *EgressRotation) Current() EgressLease {
	if rotation == nil || rotation.current == nil {
		return EgressLease{}
	}
	return *rotation.current
}

// Next 取下一个尚未尝试的候选，并返回要告知用户的一句话。
// 第一次调用是「因网络失败启用代理」，之后每次都是「上一个出口失败，换下一个」。
func (rotation *EgressRotation) Next(ctx context.Context, cause string) (EgressAttempt, error) {
	if rotation == nil || rotation.source == nil || rotation.acquire == nil {
		return EgressAttempt{}, errors.New("自动代理未配置")
	}
	ids, err := rotation.source(ctx)
	if err != nil {
		return EgressAttempt{}, err
	}
	var failures []string
	for _, id := range ids {
		if _, done := rotation.tried[id]; done {
			continue
		}
		rotation.tried[id] = struct{}{}
		lease, acquireErr := rotation.acquire(ctx, id)
		if acquireErr != nil {
			failures = append(failures, shortReason(acquireErr.Error()))
			continue
		}
		if rotation.current != nil && rotation.current.Release != nil {
			rotation.current.Release()
		}
		rotation.current = &lease
		message := rotation.announce(cause, lease.Name)
		// started 只标记「这次任务已经用上过自动出口」。它必须在 announce 之后
		// 才置位：启用第一轮要说「由于…已自动启用」，已经启用过再换出口要说
		// 「已切换到…」，否则长驻代理自愈时会重复说「刚刚启用」。
		rotation.failed, rotation.failedReason = "", ""
		rotation.started = true
		rotation.notify(message)
		return EgressAttempt{Lease: lease, Message: message}, nil
	}
	// 全部候选都试过了：释放当前出口并如实说明，不假装成功。
	message := "自动代理的候选出口都已尝试（本次已排除的出口不再重试）"
	if len(failures) > 0 {
		message = fmt.Sprintf("自动代理的候选出口都已尝试（%s）", failureSummary(failures))
	}
	rotation.Release()
	rotation.notify("[aih] " + message + "；不再重试。")
	return EgressAttempt{Exhausted: true, Message: message}, nil
}

// Fail 记录当前出口失败：立即释放，下一次 Next 会跳过它并说明切换。
func (rotation *EgressRotation) Fail(reason string) {
	if rotation == nil || rotation.current == nil {
		return
	}
	rotation.failed = rotation.current.Name
	rotation.failedReason = strings.TrimSpace(reason)
	rotation.Release()
}

// Release 释放当前出口（幂等）。
func (rotation *EgressRotation) Release() {
	if rotation == nil || rotation.current == nil {
		return
	}
	if rotation.current.Release != nil {
		rotation.current.Release()
	}
	rotation.current = nil
}

// announce 生成用户可见的那句话：首次启用说明原因，后续说明从谁换到谁。
func (rotation *EgressRotation) announce(cause, name string) string {
	name = displayName(name)
	if rotation.failed != "" {
		return fmt.Sprintf("[aih] 代理 %s 不可用（%s），已自动切换到 %s。",
			displayName(rotation.failed), reasonOr(rotation.failedReason), name)
	}
	// 已经启用过（长驻代理自愈、或同一轮里换过出口）就不再声称「刚刚启用」：
	// 那句话会让用户以为代理是这次才打开的。
	if rotation.started {
		return fmt.Sprintf("[aih] 已切换到出口 %s（原因：%s）。", name, reasonOr(strings.TrimSpace(cause)))
	}
	return fmt.Sprintf("[aih] 由于%s，已自动启用代理 %s（仅本次任务，不改全局配置）。",
		reasonOr(strings.TrimSpace(cause)), name)
}

// reasonOr 把空原因补成中性描述，避免出现「由于，已...」这种残句。
func reasonOr(reason string) string {
	reason = strings.TrimSpace(reason)
	if reason == "" {
		return "网络不可用"
	}
	return reason
}

func displayName(name string) string {
	cleaned := strings.Join(strings.Fields(name), " ")
	if cleaned == "" {
		return "未命名出口"
	}
	return cleaned
}

func shortReason(message string) string {
	message = strings.TrimSpace(message)
	if message == "" {
		return "未知原因"
	}
	if len([]rune(message)) > 80 {
		return string([]rune(message)[:80]) + "…"
	}
	return message
}

func failureSummary(failures []string) string {
	if len(failures) == 0 {
		return "全部租约申请失败"
	}
	if len(failures) > 3 {
		failures = failures[:3]
	}
	return strings.Join(failures, "；")
}

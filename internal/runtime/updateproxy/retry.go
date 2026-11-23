package updateproxy

import (
	"context"
	"fmt"
)

// EgressClassifier 判断一次失败是否值得换出口重试，并给出面向用户的原因。
// 由调用方提供（例如 provider CLI 安装器的网络错误分类），本包不猜。
type EgressClassifier func(err error) (reason string, retryable bool)

// UsedEgress 描述最终跑成功（或最后失败）的那一轮用了什么出口。
// 单独返回它，是因为出口在函数返回前就会释放，调用方无法再从轮换器读回名字。
type UsedEgress struct {
	URL  string
	Name string
	// Identity 是该出口在健康账本中的键；为空表示没有可记账条目。
	Identity string
	// Auto 表示这是自动选出的出口（而非调用方显式指定）。
	Auto bool
}

// RetryWithEgress 执行「先直连，网络失败才启用受管出口，出口失败再换下一个」。
//
// 这是自动代理的唯一实现：CLI 命令入口与 Host 的缺失 CLI 自动安装都走这里，
// 避免两处各自推导「什么算网络失败」「换出口后谁负责释放租约」。
//
// rotation 为 nil 表示没有可用管理面（未配置 Server 或缺少密钥）：此时只执行
// 第一次直连，保持调用方原有的失败语义。
func RetryWithEgress[T any](
	ctx context.Context,
	rotation *EgressRotation,
	maxAttempts int,
	classify EgressClassifier,
	run func(proxyURL string) (T, error),
) (T, UsedEgress, error) {
	var zero T
	var used UsedEgress
	result, err := run("")
	if err == nil {
		return result, used, nil
	}
	reason, retryable := classify(err)
	if !retryable || rotation == nil || maxAttempts <= 0 {
		return zero, used, err
	}
	// 轮换期间由本函数持有出口；结束时无论成败都要释放。
	defer rotation.Release()
	for attempt := 0; attempt < maxAttempts; attempt++ {
		next, nextErr := rotation.Next(ctx, reason)
		if nextErr != nil {
			// 还没用上任何出口：保留原始失败，并补充自动代理为何不可用。
			if !rotation.Active() {
				return zero, used, fmt.Errorf("%w；自动代理不可用：%s", err, nextErr)
			}
			return zero, used, err
		}
		if next.Exhausted {
			return zero, used, fmt.Errorf("%w；%s", err, next.Message)
		}
		used = UsedEgress{URL: next.Lease.URL, Name: next.Lease.Name, Identity: next.Lease.Identity, Auto: true}
		result, err = run(next.Lease.URL)
		if err == nil {
			return result, used, nil
		}
		failureReason, stillNetwork := classify(err)
		if !stillNetwork {
			return zero, used, err
		}
		reason = failureReason
		rotation.Fail(reason)
	}
	return zero, used, err
}

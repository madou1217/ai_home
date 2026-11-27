package updateproxy

import (
	"context"
	"fmt"
)

// EgressEndpoint 是一轮执行可用的出口入口集合。
//
// URL 需要认证；AnonymousURL 不需要（只 loopback）。后者给那些会把代理 URL
// 里的 userinfo 丢掉、又不支持显式凭据的客户端——winget 的 --proxy 就是这样。
type EgressEndpoint struct {
	URL          string
	AnonymousURL string
	Name         string
}

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
	// run 拿到本轮出口的完整信息（含匿名入口），而不是只有代理 URL：
	// 有些客户端只能用匿名入口（winget 已实测），只传 URL 会让它们无法配置。
	run func(EgressEndpoint) (T, error),
) (T, UsedEgress, error) {
	var zero T
	var used UsedEgress
	result, err := run(EgressEndpoint{})
	if err == nil {
		return result, used, nil
	}
	reason, retryable := classify(err)
	if !retryable || rotation == nil || maxAttempts <= 0 {
		return zero, used, err
	}
	return retryWithRotation(ctx, rotation, maxAttempts, classify, run, reason, err)
}

// RetryWithRotation 只走受管出口，不先尝试直连。
//
// 用于用户显式指定地区范围（--proxy us,sg）的场景：用户已经要求走代理，
// 再把请求先打到直连等于忽略范围语义。轮换仍复用同一份 EgressRotation。
func RetryWithRotation[T any](
	ctx context.Context,
	rotation *EgressRotation,
	maxAttempts int,
	classify EgressClassifier,
	run func(EgressEndpoint) (T, error),
	cause string,
) (T, UsedEgress, error) {
	var zero T
	if rotation == nil || maxAttempts <= 0 {
		return zero, UsedEgress{}, fmt.Errorf("地区范围代理未配置")
	}
	return retryWithRotation(ctx, rotation, maxAttempts, classify, run, cause, nil)
}

func retryWithRotation[T any](
	ctx context.Context,
	rotation *EgressRotation,
	maxAttempts int,
	classify EgressClassifier,
	run func(EgressEndpoint) (T, error),
	cause string,
	original error,
) (T, UsedEgress, error) {
	var zero T
	var used UsedEgress
	// 轮换期间由本函数持有出口；结束时无论成败都要释放。
	defer rotation.Release()
	reason := cause
	lastErr := original
	for attempt := 0; attempt < maxAttempts; attempt++ {
		next, nextErr := rotation.Next(ctx, reason)
		if nextErr != nil {
			// 还没用上任何出口：保留原始失败（若有），并补充代理为何不可用。
			if !rotation.Active() {
				if lastErr != nil {
					return zero, used, fmt.Errorf("%w；自动代理不可用：%s", lastErr, nextErr)
				}
				return zero, used, nextErr
			}
			if lastErr != nil {
				return zero, used, lastErr
			}
			return zero, used, nextErr
		}
		if next.Exhausted {
			if lastErr != nil {
				return zero, used, fmt.Errorf("%w；%s", lastErr, next.Message)
			}
			return zero, used, fmt.Errorf("%s", next.Message)
		}
		used = UsedEgress{URL: next.Lease.URL, Name: next.Lease.Name, Identity: next.Lease.Identity, Auto: true}
		result, err := run(EgressEndpoint{
			URL:          next.Lease.URL,
			AnonymousURL: next.Lease.AnonymousURL,
			Name:         next.Lease.Name,
		})
		if err == nil {
			return result, used, nil
		}
		lastErr = err
		failureReason, stillNetwork := classify(err)
		if !stillNetwork {
			return zero, used, err
		}
		reason = failureReason
		rotation.Fail(reason)
	}
	if lastErr != nil {
		return zero, used, lastErr
	}
	return zero, used, fmt.Errorf("没有可用的代理出口")
}

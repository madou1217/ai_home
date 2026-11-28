package imagestudio

import (
	"context"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// 内部调度参数：WebUI 连续提交的生成需求在网关内部排队，而不是让客户端阻塞。
const (
	// imageStudioQueueLimit 是待执行运行的上限；超过后明确拒绝，避免无限堆积。
	imageStudioQueueLimit = 200
	// imageStudioQueueBytesLimit 限制排队请求体的总字节数。
	//
	// 每条排队的运行都带着已解码的 base64 图片（编辑请求常见 2~8 MiB），只按条数
	// 限流会让 200 条排队吃光内存：单机 1.8 GB 的部署上有真实的 OOM 风险。
	imageStudioQueueBytesLimit = 256 << 20
	// DefaultMaxConcurrentRuns 是同时执行的工作协程数。
	//
	// 图片上游的并发上限通常很小（常见是单账号 1~2 条），把执行数压到 1 条既保证
	// 提交永不被「并发满」拒绝，也让排队顺序可预期；需要吞吐时用
	// AIH_IMAGE_STUDIO_MAX_CONCURRENT_RUNS 放宽。
	DefaultMaxConcurrentRuns = 1
	// imageStudioRunTimeout 是单条后台运行的墙钟上限（生成 + 物化）。
	imageStudioRunTimeout = 30 * time.Minute
	// imageStudioCapacityWait 是单条运行等待内部并发名额的最长时间。
	imageStudioCapacityWait = 20 * time.Minute
	// maxCapacityRetryWait 是单次等待并发名额的上限。
	maxCapacityRetryWait = 30 * time.Second
)

// MaxConcurrentRunsFromEnv 读取 AIH_IMAGE_STUDIO_MAX_CONCURRENT_RUNS 覆盖后台执行数。
func MaxConcurrentRunsFromEnv() int {
	raw := strings.TrimSpace(os.Getenv("AIH_IMAGE_STUDIO_MAX_CONCURRENT_RUNS"))
	if raw == "" {
		return DefaultMaxConcurrentRuns
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value <= 0 {
		return DefaultMaxConcurrentRuns
	}
	return value
}

// payloadBytes 估算一条排队运行占用的请求体字节数（图片按 base64 计）。
func (plan preparedRun) payloadBytes() int64 {
	total := int64(len(plan.request.Raw))
	for _, image := range plan.request.Images {
		total += int64(len(image.Data))
	}
	if plan.request.Mask != nil {
		total += int64(len(plan.request.Mask.Data))
	}
	return total
}

// enqueueRun 把已落库的运行交给内部队列；队列满（条数或字节预算）时返回可重试的 429。
func (svc *Service) enqueueRun(plan preparedRun) error {
	if svc == nil || svc.jobs == nil {
		return NewError(503, "image_studio_queue_unavailable", "image Studio run queue is not configured")
	}
	size := plan.payloadBytes()
	if queued := svc.queuedBytes.Add(size); queued > imageStudioQueueBytesLimit {
		svc.queuedBytes.Add(-size)
		return NewError(
			429,
			"image_studio_queue_full",
			"image Studio run queue is full, retry after the current runs finish",
		)
	}
	select {
	case svc.jobs <- plan:
		return nil
	default:
		svc.queuedBytes.Add(-size)
		return NewError(
			429,
			"image_studio_queue_full",
			"image Studio run queue is full, retry after the current runs finish",
		)
	}
}

// runWorker 串行消费内部队伍：每条运行使用与请求脱钩的上下文，
// 因此浏览器断开或 HTTP 处理返回都不会中断已经提交的生成。
func (svc *Service) runWorker() {
	for plan := range svc.jobs {
		svc.runOne(plan)
	}
}

func (svc *Service) runOne(plan preparedRun) {
	// 字节预算按「排队中」计：开始执行时释放，执行中的内存由运行本身持有。
	svc.queuedBytes.Add(-plan.payloadBytes())
	ctx, cancel := context.WithTimeout(context.WithoutCancel(context.Background()), imageStudioRunTimeout)
	defer cancel()
	defer func() {
		if recovered := recover(); recovered != nil {
			// 后台协程不能把运行永远留在 running：panic 也要结算成失败。
			failCtx, failCancel := context.WithTimeout(context.WithoutCancel(context.Background()), studioRecordTimeout)
			_, _, _ = svc.store.FailRevision(
				failCtx,
				plan.sessionID,
				plan.revisionID,
				"",
				NewError(500, "image_generation_failed", fmt.Sprintf("image generation aborted unexpectedly: %v", recovered)),
			)
			failCancel()
		}
	}()
	_, _ = svc.executePrepared(ctx, plan)
}

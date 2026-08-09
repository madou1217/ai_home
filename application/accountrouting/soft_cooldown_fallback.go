package accountrouting

// softCooldownFallback 是 (账号,模型) 软冷却的逃生阀。
//
// 软冷却记录的是「上一次请求遇到了什么」，不是「这一次该不该用这个账号」。
// 一次本地代理抖动就能把仅有的几个账号连续打进冷却，此时若整轮扫描直接交回
// ErrNoRoutableAccount，调用方只能合成一条与账号无关的「没有可调度账号」——
// 把网络故障讲成账号故障，客户端还会拿到一个凭空捏造的退避时间。
//
// 所以：整轮扫描落空后重放这些仅因软冷却被跳过的候选，宁可真打一次上游拿到真实
// 答复（成功，或带着真实状态码与 retry-after 的失败）。硬阻塞——凭据失效、额度
// 耗尽、策略禁止——不进这里，它们本就不是「软」的。
//
// 只重放第一遍记下的位置，而不是把游标归零重扫，是为了守住会话不变量：
// 同一请求内同一个账号最多被调用一次。
type softCooldownFallback struct {
	deferred []int
	cursor   int
	engaged  bool
}

// deferCandidate 记下一个仅因软冷却被跳过的候选位置。
func (fallback *softCooldownFallback) deferCandidate(offset int) {
	fallback.deferred = append(fallback.deferred, offset)
}

// nextDeferred 取出下一个待重放的位置，并就此打开逃生阀。
//
// 打开后 bypassesCooldown 恒为真，剩余重放不会再被同一层冷却拦下——一次性放行
// 只能试到第一个被冷却的账号，它再失败就又退回「无账号」，等于没修。
func (fallback *softCooldownFallback) nextDeferred() (int, bool) {
	if fallback.cursor >= len(fallback.deferred) {
		return 0, false
	}
	offset := fallback.deferred[fallback.cursor]
	fallback.cursor++
	fallback.engaged = true
	return offset, true
}

// bypassesCooldown 表示逃生阀已打开，软冷却不再拦截候选。
func (fallback *softCooldownFallback) bypassesCooldown() bool {
	return fallback.engaged
}

// hasPending 表示仍有被延后的候选没重放，用于判断扫描是否真的走到了尽头。
func (fallback *softCooldownFallback) hasPending() bool {
	return fallback.cursor < len(fallback.deferred)
}

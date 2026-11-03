package inmemory

import "time"

// failureBlock 保存上游失败观察到的硬阻塞位与复核时刻。
//
// 一次失败只是一次观察，不是真相源：到复核时刻就失效（读取时惰性判断，不需要定时器），
// 下一次请求重新验证，仍失败再按新观察计时。真相源推导出的阻塞（额度快照投影）保存在
// accountBlocks / modelBlocks 里，不经过这里，也不会随时间失效。
type failureBlock struct {
	set       blockSet
	recheckAt time.Time
}

// activeAt 返回 now 时仍生效的阻塞位；到了复核时刻返回空集合。
func (block failureBlock) activeAt(now time.Time) blockSet {
	if block.set == 0 || !now.Before(block.recheckAt) {
		return 0
	}
	return block.set
}

// observe 记录一次新的失败观察。
//
// 旧观察仍生效时合并阻塞位，复核时刻只往后推（更短的新观察不能提前一个更晚的恢复提示）；
// 旧观察已到期则不再作数，从这次观察重新开始。
func (block failureBlock) observe(
	bit blockSet,
	now time.Time,
	recheckAt time.Time,
) failureBlock {
	if block.activeAt(now) == 0 {
		return failureBlock{set: bit, recheckAt: recheckAt}
	}
	next := failureBlock{set: block.set.add(bit), recheckAt: block.recheckAt}
	if recheckAt.After(next.recheckAt) {
		next.recheckAt = recheckAt
	}
	return next
}

// clear 返回移除指定阻塞位后的观察。
func (block failureBlock) clear(bit blockSet) failureBlock {
	block.set = block.set.clear(bit)
	return block
}

package upstreammapping

import (
	"context"

	mappingcore "github.com/madou1217/ai_home/core/upstreammapping"
)

// Repository 是映射组的持久化端口。
//
// 端口按「单组 CRUD」设计而不是「整表替换」：映射组之间没有顺序耦合（组内顺序
// 由 Entries 表达），逐组写入才能让并发修改只影响同一组，而不是让两个用户改
// 不同组时互相覆盖。存储实现负责事务与版本 CAS。
type Repository interface {
	// List 返回全部映射组，按 position 升序。
	List(ctx context.Context) ([]mappingcore.Group, error)
	// Get 返回单个映射组；不存在时返回 ErrGroupNotFound。
	Get(ctx context.Context, id string) (mappingcore.Group, error)
	// Create 写入一个新组并分配 position / version / 时间戳。
	//
	// 同一个 id 已存在时返回 ErrGroupExists；数量超限时返回 ErrGroupLimit。
	Create(ctx context.Context, group mappingcore.Group) (mappingcore.Group, error)
	// Update 用 expectedVersion 做 CAS 更新内容并重写组内规则。
	//
	// 版本不匹配返回 ErrGroupConflict，组不存在返回 ErrGroupNotFound。
	Update(ctx context.Context, group mappingcore.Group, expectedVersion int64) (mappingcore.Group, error)
	// Delete 删除映射组；expectedVersion 为 nil 时不做版本校验。
	Delete(ctx context.Context, id string, expectedVersion *int64) error
}

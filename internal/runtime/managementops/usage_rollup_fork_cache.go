package managementops

import (
	"context"
	"database/sql"
)

// getCachedForkDescriptorsConn 按持久触发器维护的 fork_rev 复用分叉上下文及摘要，
// 避免重复扫描并反序列化 model_usage_file_state 中 800+ 分叉 JSON；严格绑定 fork_rev，无 TTL 滞后。
func (s *UsageStore) getCachedForkDescriptorsConn(ctx context.Context, conn *sql.Conn, forkRev int64) ([]forkDescriptor, int64, error) {
	coord := getRollupCoordinator(s)
	coord.mu.Lock()
	if coord.hasCachedForkDigest && coord.cachedForkRev == forkRev {
		forks := coord.cachedForks
		digest := coord.cachedForkDigest
		coord.mu.Unlock()
		return forks, digest, nil
	}
	coord.mu.Unlock()

	forks, err := readForkDescriptorsConn(ctx, conn)
	if err != nil {
		return nil, 0, err
	}
	digest := computeForkDigest(forks)

	coord.mu.Lock()
	coord.hasCachedForkDigest = true
	coord.cachedForkRev = forkRev
	coord.cachedForkDigest = digest
	coord.cachedForks = forks
	coord.mu.Unlock()
	return forks, digest, nil
}

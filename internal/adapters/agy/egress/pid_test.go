package egress

import (
	"os"
	"testing"
)

// TestDefaultPidAlive 锁住 signal 0 的存活判断：自身进程存活，非法 pid 不存活。
func TestDefaultPidAlive(t *testing.T) {
	t.Parallel()
	if !defaultPidAlive(os.Getpid()) {
		t.Error("defaultPidAlive(自身 pid) = false，期望 true")
	}
	if defaultPidAlive(0) || defaultPidAlive(-1) {
		t.Error("非正 pid 应判为不存活")
	}
	if defaultPidAlive(1 << 30) {
		t.Error("不存在的 pid 应判为不存活")
	}
}

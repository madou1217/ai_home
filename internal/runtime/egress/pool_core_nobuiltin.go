//go:build no_builtin_engines

package egress

import "errors"

func (core *PoolCore) buildBuiltinConfig(PoolConfigInput, []ProxyNode) (*CompiledPoolConfig, error) {
	return nil, errors.New("egress_engine_not_installed")
}

func (core *PoolCore) checkBuiltinConfig(string) error { return nil }

func (core *PoolCore) builtinRunArgs(string, string) []string { return nil }

// newExplicitPoolCore 在无内置引擎的构建里拒绝显式内核路径，避免用错误参数启动未知二进制。
func newExplicitPoolCore(string) (*PoolCore, error) {
	return nil, errors.New("egress_engine_not_installed")
}

func (m *Manager) builtinPoolCore([]ProxyNode) (*PoolCore, error) {
	return nil, errors.New("egress_engine_not_installed")
}

package aihserver_test

import (
	"os"
	"testing"
)

// TestMain 为整个 Host 测试包钉住账号选号策略。
//
// 生产默认是 Node 同构的 random（见 AIH_SERVER_STRATEGY），组合层用例断言的是确定性
// 的轮转顺序（例如 OAuth 与 API Key 账号按 account_ref 依次被征召），因此在这里显式
// 固定 round-robin；策略解析本身由 application/accountrouting 的单测覆盖。
func TestMain(m *testing.M) {
	if err := os.Setenv("AIH_SERVER_STRATEGY", "round-robin"); err != nil {
		panic(err)
	}
	os.Exit(m.Run())
}

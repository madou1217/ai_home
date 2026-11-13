package aihlogin

import (
	"strings"
	"testing"

	codebuddyfamilycli "github.com/madou1217/ai_home/internal/adapters/codebuddyfamily/clilaunch"
)

// TestWithoutEnvironmentKeys 登录进程不能继承宿主的家族身份/站点变量。
func TestWithoutEnvironmentKeys(t *testing.T) {
	environment := []string{
		"HOME=/Users/host",
		"CODEBUDDY_API_KEY=host-leak",
		"CODEBUDDY_INTERNET_ENVIRONMENT=internal",
		"CODEBUDDY_CONFIG_DIR=/Users/host/.codebuddy",
		"PATH=/usr/bin",
	}
	filtered := withoutEnvironmentKeys(environment, codebuddyfamilycli.NeverInheritKeys())
	joined := strings.Join(filtered, " ")
	if strings.Contains(joined, "CODEBUDDY_") {
		t.Fatalf("家族变量没有被剥掉: %v", filtered)
	}
	if !strings.Contains(joined, "HOME=/Users/host") || !strings.Contains(joined, "PATH=/usr/bin") {
		t.Fatalf("普通变量不应被删除: %v", filtered)
	}
}

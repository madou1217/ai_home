package providercli

import (
	"slices"
	"testing"

	"github.com/madou1217/ai_home/application/providerlaunch"
)

// TestApplyEnvironmentAppliesImmutablePatch 验证覆盖、删除、去重和稳定排序。
func TestApplyEnvironmentAppliesImmutablePatch(t *testing.T) {
	patch, err := providerlaunch.NewEnvironmentPatch(
		map[string]string{"B": "new", "C": "3"},
		[]string{"A"},
	)
	if err != nil {
		t.Fatalf("NewEnvironmentPatch() error = %v", err)
	}
	got := applyEnvironment([]string{"B=old", "A=1", "B=latest", "INVALID"}, patch)
	want := []string{"B=new", "C=3"}
	if !slices.Equal(got, want) {
		t.Fatalf("applyEnvironment() = %v, want %v", got, want)
	}
}

// TestEnvironmentKeyForOSPreservesPlatformSemantics 验证 Windows 大小写去重且 Unix 保持原名。
func TestEnvironmentKeyForOSPreservesPlatformSemantics(t *testing.T) {
	if got := environmentKeyForOS("windows", "Path"); got != "PATH" {
		t.Fatalf("Windows key = %q", got)
	}
	if got := environmentKeyForOS("darwin", "Path"); got != "Path" {
		t.Fatalf("Darwin key = %q", got)
	}
}

// TestEnvironmentValueUsesPlatformKeySemantics 验证 Runtime 能读取应用补丁后的最终环境值。
func TestEnvironmentValueUsesPlatformKeySemantics(t *testing.T) {
	environment := []string{"CODEX_HOME=/shared/codex", "NODE_EXTRA_CA_CERTS=/tmp/ca.pem"}
	value, found := environmentValue(environment, "NODE_EXTRA_CA_CERTS")
	if !found || value != "/tmp/ca.pem" {
		t.Fatalf("environmentValue() = %q, %t", value, found)
	}
	if _, found := environmentValue(environment, "MISSING"); found {
		t.Fatal("environmentValue() 不应返回缺失变量")
	}
}

package providercli

import (
	"strings"
	"testing"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// TestApplyAccountRefEnvironment 宿主继承的账号标记必须被本次账号覆盖，且只留一条。
func TestApplyAccountRefEnvironment(t *testing.T) {
	ref, err := accountcore.ParseAccountRef("acct_0123456789abcdef0123")
	if err != nil {
		t.Fatalf("ref: %v", err)
	}
	environment := []string{
		"HOME=/host",
		"AIH_PROVIDER_ACCOUNT_REF=acct_deadbeefdeadbeefdead",
	}
	updated := applyAccountRefEnvironment(environment, ref)
	count := 0
	for _, entry := range updated {
		if strings.HasPrefix(entry, "AIH_PROVIDER_ACCOUNT_REF=") {
			count++
			if entry != "AIH_PROVIDER_ACCOUNT_REF="+ref.String() {
				t.Fatalf("entry = %q", entry)
			}
		}
	}
	if count != 1 {
		t.Fatalf("account ref 条数 = %d: %v", count, updated)
	}
	if !strings.Contains(strings.Join(updated, " "), "HOME=/host") {
		t.Fatalf("其它变量被删除: %v", updated)
	}
	cleared := applyAccountRefEnvironment(environment, "")
	for _, entry := range cleared {
		if strings.HasPrefix(entry, "AIH_PROVIDER_ACCOUNT_REF=") {
			t.Fatalf("空账号必须清掉标记: %v", cleared)
		}
	}
}

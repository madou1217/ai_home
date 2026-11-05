package sqliteaccount

import (
	"context"
	"testing"
)

// TestListAllAccountModelsGroupsByAccount 覆盖 WebUI 批量读的口径：一次 JOIN 读出
// 全部账号的模型关系，按账号分组、组内按 model_id 排序，且不返回没有模型的账号。
func TestListAllAccountModelsGroupsByAccount(t *testing.T) {
	store := openOAuthJobStore(t)
	ctx := context.Background()
	const first = "acct_0123456789abcdef0123"
	const second = "acct_ffffffffffffffffffff"
	for _, row := range []struct {
		ref          string
		provider     string
		cliAccountID int
	}{
		{first, "codex", 1},
		{second, "claude", 2},
	} {
		if _, err := store.db.ExecContext(
			ctx,
			"INSERT INTO accounts (account_ref, provider_id, cli_account_id, enabled, created_at_ms, updated_at_ms) VALUES (?, ?, ?, 1, 1, 1)",
			row.ref,
			row.provider,
			row.cliAccountID,
		); err != nil {
			t.Fatalf("插入账号失败: %v", err)
		}
	}
	for _, row := range []struct {
		ref      string
		model    string
		upstream bool
		policy   string
	}{
		{first, "gpt-5", true, "inherit"},
		{first, "gpt-5-mini", true, "force_disable"},
		{second, "claude-sonnet", true, "inherit"},
	} {
		if _, err := store.db.ExecContext(
			ctx,
			"INSERT INTO account_models (account_ref, model_id, upstream_available, manual_policy, updated_at_ms) VALUES (?, ?, ?, ?, 10)",
			row.ref,
			row.model,
			row.upstream,
			row.policy,
		); err != nil {
			t.Fatalf("插入模型失败: %v", err)
		}
	}
	sets, err := store.ListAllAccountModels(ctx)
	if err != nil {
		t.Fatalf("ListAllAccountModels() error = %v", err)
	}
	if len(sets) != 2 {
		t.Fatalf("账号数 = %d, want 2", len(sets))
	}
	if sets[0].AccountRef.String() != first || sets[0].ProviderID != "codex" {
		t.Fatalf("第一组 = %s/%s", sets[0].AccountRef, sets[0].ProviderID)
	}
	if len(sets[0].Models) != 2 ||
		sets[0].Models[0].ModelID().String() != "gpt-5" ||
		sets[0].Models[1].ModelID().String() != "gpt-5-mini" {
		t.Fatalf("第一组模型 = %#v", sets[0].Models)
	}
	if sets[0].Models[1].Effective() {
		t.Fatal("force_disable 的模型不应 effective")
	}
	if sets[1].AccountRef.String() != second || len(sets[1].Models) != 1 {
		t.Fatalf("第二组 = %s models=%d", sets[1].AccountRef, len(sets[1].Models))
	}
}

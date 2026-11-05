package sqliteaccount

import (
	"context"
	"testing"
)

// TestListAllAccountModelsGroupsByAccount 覆盖 WebUI 批量读的口径：一次 JOIN 读出
// 有事实可讲的账号，按账号分组、组内按 model_id 排序。
//
// 三种账号要分开：
//   - 有模型：返回模型列表；
//   - 有探测事实但目录为空：仍要返回，否则 WebUI 无法把它和「从未探测」区分开；
//   - 既没模型也没探测过：不返回。响应里出现一个「无模型且无错误」的账号会被
//     WebUI 合并缓存当成已确认为空，从而清掉旧目录。
func TestListAllAccountModelsGroupsByAccount(t *testing.T) {
	store := openOAuthJobStore(t)
	ctx := context.Background()
	const first = "acct_0123456789abcdef0123"
	const empty = "acct_99999999999999999999"
	const second = "acct_ffffffffffffffffffff"
	const unknown = "acct_00000000000000000000"
	for _, row := range []struct {
		ref          string
		provider     string
		cliAccountID int
	}{
		{first, "codex", 1},
		{empty, "gemini", 2},
		{second, "claude", 3},
		{unknown, "codex", 4},
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
	// 成功探测但目录为空：只有探测表有行，account_models 没有行。
	if _, err := store.db.ExecContext(
		ctx,
		`INSERT INTO account_model_probes (
			account_ref, provider_id, last_attempt_at_ms, last_error_code,
			last_error_message, last_source, last_model_count, updated_at_ms
		) VALUES (?, 'gemini', 500, '', '', 'remote', 0, 500)`,
		empty,
	); err != nil {
		t.Fatalf("插入探测事实失败: %v", err)
	}
	sets, err := store.ListAllAccountModels(ctx)
	if err != nil {
		t.Fatalf("ListAllAccountModels() error = %v", err)
	}
	if len(sets) != 3 {
		t.Fatalf("账号数 = %d, want 3（没有模型也没有探测事实的账号不返回）", len(sets))
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
	if sets[1].AccountRef.String() != empty ||
		sets[1].ProviderID != "gemini" ||
		len(sets[1].Models) != 0 {
		t.Fatalf("空目录组 = %s/%s models=%d", sets[1].AccountRef, sets[1].ProviderID, len(sets[1].Models))
	}
	if sets[1].LastAttemptAt.UnixMilli() != 500 ||
		sets[1].LastSource != "remote" ||
		sets[1].LastModelCount != 0 {
		t.Fatalf("空目录组的探测事实 = %#v", sets[1])
	}
	if sets[2].AccountRef.String() != second || len(sets[2].Models) != 1 {
		t.Fatalf("第三组 = %s models=%d", sets[2].AccountRef, len(sets[2].Models))
	}
}

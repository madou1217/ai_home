package aihserver_test

import (
	"encoding/json"
	"testing"
)

// decodeRealTransferAccountRef 只把目标 Server 新生成的账号身份用于后续本地请求。
//
// 原文件（live_codex_sub2api_transfer_test.go）还包含 sub2api 端到端迁移测试，
// 该格式已于 2026-10-23 移除；这里保留仍然被真实 Claude 夹具使用的辅助函数。
func decodeRealTransferAccountRef(t *testing.T, body string) string {
	t.Helper()
	var document struct {
		Data struct {
			AccountRef string `json:"account_ref"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(body), &document); err != nil || document.Data.AccountRef == "" {
		t.Fatalf("迁移导入响应缺少 AccountRef: %v", err)
	}
	return document.Data.AccountRef
}

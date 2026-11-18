package webuiaccountsapi

import "testing"

// 凭据是接口地址的真值：UI 镜像为空时，账号行仍必须回显凭据里的地址，
// 否则编辑弹窗显示空值，用户直接保存就会把地址清掉。
func TestListAccountRowsEchoesCredentialBaseURL(t *testing.T) {
	directory := newSeededDatabase(t)
	database := openWritableDatabase(t, directory)
	mustExec(t, database,
		"UPDATE account_credentials SET credential_json = ? WHERE account_ref = ?",
		`{"api_key":"sk-test","base_url":"https://relay.example.com/v1"}`,
		apiKeyAccountRef)
	mustExec(t, database,
		"UPDATE account_ui_state SET base_url = '' WHERE account_ref = ?",
		apiKeyAccountRef)

	source := newTestSource(t, directory)
	handler := newTestHandler(t, source)
	_, decoded := requestJSON(t, handler, "ref="+apiKeyAccountRef)
	rows := accountRows(t, decoded)
	if len(rows) != 1 {
		t.Fatalf("行数 = %d, 期望 1", len(rows))
	}
	if got := rows[0]["baseUrl"]; got != "https://relay.example.com/v1" {
		t.Fatalf("baseUrl = %#v, 期望凭据里的地址", got)
	}
}

// 未自定义地址时凭据会存成 Provider 官方地址，账号页要按约定还原为空串，
// 否则编辑弹窗会回显官方地址，和“留空 = 官方地址”的提示不一致。
func TestListAccountRowsHidesOfficialCredentialBaseURL(t *testing.T) {
	directory := newSeededDatabase(t)
	database := openWritableDatabase(t, directory)
	mustExec(t, database,
		"UPDATE account_credentials SET credential_json = ? WHERE account_ref = ?",
		`{"api_key":"sk-test","base_url":"https://api.anthropic.com"}`,
		apiKeyAccountRef)
	mustExec(t, database,
		"UPDATE account_ui_state SET base_url = '' WHERE account_ref = ?",
		apiKeyAccountRef)

	source := newTestSource(t, directory)
	handler := newTestHandler(t, source)
	_, decoded := requestJSON(t, handler, "ref="+apiKeyAccountRef)
	rows := accountRows(t, decoded)
	if len(rows) != 1 {
		t.Fatalf("行数 = %d, 期望 1", len(rows))
	}
	if got := rows[0]["baseUrl"]; got != "" {
		t.Fatalf("baseUrl = %#v, 期望空串（官方地址）", got)
	}
}

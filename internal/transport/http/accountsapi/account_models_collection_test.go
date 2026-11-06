package accountsapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// fakeAccountModelReader 返回固定的批量模型关系。
type fakeAccountModelReader struct {
	sets        []accountapp.AccountModelSet
	generation  int64
	updatedAtMS int64
	stamp       accountapp.AccountModelCatalogStamp
	err         error
}

func (reader fakeAccountModelReader) ListAllAccountModels(context.Context) (accountapp.AccountModelCatalog, error) {
	return accountapp.AccountModelCatalog{
		Sets:        reader.sets,
		Generation:  reader.generation,
		UpdatedAtMS: reader.updatedAtMS,
	}, reader.err
}

func (reader fakeAccountModelReader) AccountModelCatalogStamp(context.Context) (accountapp.AccountModelCatalogStamp, error) {
	return reader.stamp, reader.err
}

func buildModelSet(t *testing.T, ref, provider, model string, policy accountapp.ModelManualPolicy) accountapp.AccountModelSet {
	t.Helper()
	accountRef, err := accountcore.ParseAccountRef(ref)
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	entry, err := accountapp.NewAccountModel(accountapp.AccountModelInput{
		AccountRef:        accountRef,
		ModelID:           model,
		UpstreamAvailable: true,
		ManualPolicy:      policy,
		UpdatedAt:         time.UnixMilli(1_790_000_000_000).UTC(),
	})
	if err != nil {
		t.Fatalf("NewAccountModel() error = %v", err)
	}
	return accountapp.AccountModelSet{AccountRef: accountRef, ProviderID: provider, Models: []accountapp.AccountModel{entry}}
}

func TestAccountModelsCollectionFiltersByProvider(t *testing.T) {
	first := buildModelSet(t, "acct_0123456789abcdef0123", "codex", "gpt-5", accountapp.ModelPolicyInherit)
	second := buildModelSet(t, "acct_ffffffffffffffffffff", "claude", "claude-sonnet", accountapp.ModelPolicyInherit)
	handler := &Handler{accountModels: fakeAccountModelReader{sets: []accountapp.AccountModelSet{first, second}}}
	request := httptest.NewRequest(http.MethodGet, AccountModelsCollectionPath+"?provider=codex", nil)
	recorder := httptest.NewRecorder()
	handler.handleAccountModelsCollection(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	var payload struct {
		Data []struct {
			AccountRef string `json:"account_ref"`
			ProviderID string `json:"provider_id"`
			Models     []struct {
				ModelID   string `json:"model_id"`
				Effective bool   `json:"effective"`
			} `json:"models"`
		} `json:"data"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("解析响应失败: %v", err)
	}
	if len(payload.Data) != 1 || payload.Data[0].ProviderID != "codex" {
		t.Fatalf("过滤结果 = %#v", payload.Data)
	}
	if len(payload.Data[0].Models) != 1 || !payload.Data[0].Models[0].Effective {
		t.Fatalf("模型投影 = %#v", payload.Data[0].Models)
	}
}

// TestAccountModelsCollectionProjectsProbeFacts 覆盖探测字段的 JSON 投影：
// 探测时刻用毫秒数下发，错误、来源和计数与模型列表同层；从未探测的账号保留零值，
// WebUI 才能把「没有探测过」和「探测失败」分开。
func TestAccountModelsCollectionProjectsProbeFacts(t *testing.T) {
	probed := buildModelSet(t, "acct_0123456789abcdef0123", "codex", "gpt-5", accountapp.ModelPolicyInherit)
	probed.LastAttemptAt = time.UnixMilli(1_790_000_000_500).UTC()
	probed.LastErrorCode = "discovery_failed"
	probed.LastErrorMessage = "上游 403"
	probed.LastSource = "error"
	probed.LastModelCount = 3
	never := buildModelSet(t, "acct_ffffffffffffffffffff", "claude", "claude-sonnet", accountapp.ModelPolicyInherit)
	handler := &Handler{accountModels: fakeAccountModelReader{sets: []accountapp.AccountModelSet{probed, never}}}
	request := httptest.NewRequest(http.MethodGet, AccountModelsCollectionPath, nil)
	recorder := httptest.NewRecorder()
	handler.handleAccountModelsCollection(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	var payload struct {
		Data []struct {
			AccountRef       string `json:"account_ref"`
			LastAttemptAtMS  int64  `json:"last_attempt_at_ms"`
			LastErrorCode    string `json:"last_error_code"`
			LastErrorMessage string `json:"last_error_message"`
			LastSource       string `json:"last_source"`
			LastModelCount   int    `json:"last_model_count"`
		} `json:"data"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("解析响应失败: %v", err)
	}
	if len(payload.Data) != 2 {
		t.Fatalf("账号数 = %d, want 2", len(payload.Data))
	}
	first := payload.Data[0]
	if first.LastAttemptAtMS != 1_790_000_000_500 ||
		first.LastErrorCode != "discovery_failed" ||
		first.LastErrorMessage != "上游 403" ||
		first.LastSource != "error" ||
		first.LastModelCount != 3 {
		t.Fatalf("探测投影 = %#v", first)
	}
	second := payload.Data[1]
	if second.LastAttemptAtMS != 0 ||
		second.LastErrorCode != "" ||
		second.LastErrorMessage != "" ||
		second.LastSource != "" ||
		second.LastModelCount != 0 {
		t.Fatalf("从未探测账号应为零值: %#v", second)
	}
}

func TestAccountModelsCollectionWithoutReaderReturns503(t *testing.T) {
	handler := &Handler{}
	request := httptest.NewRequest(http.MethodGet, AccountModelsCollectionPath, nil)
	recorder := httptest.NewRecorder()
	handler.handleAccountModelsCollection(recorder, request)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", recorder.Code)
	}
}

// TestAccountModelsCollectionExposesCatalogFingerprint 覆盖空表、单行、多行三种
// 批量投影：generation 与 updated_at_ms 必须来自同一次读取，并且空表是 0 而不是
// 当前时间。Node 的条件刷新依赖这两个字段判断「是否还要整份拉取」。
func TestAccountModelsCollectionExposesCatalogFingerprint(t *testing.T) {
	single := buildModelSet(t, "acct_0123456789abcdef0123", "codex", "gpt-5", accountapp.ModelPolicyInherit)
	multiFirst := buildModelSet(t, "acct_0123456789abcdef0123", "codex", "gpt-5", accountapp.ModelPolicyInherit)
	multiSecond := buildModelSet(t, "acct_ffffffffffffffffffff", "claude", "claude-sonnet", accountapp.ModelPolicyInherit)
	cases := []struct {
		name        string
		sets        []accountapp.AccountModelSet
		generation  int64
		updatedAtMS int64
		wantRows    int
	}{
		{name: "empty", sets: nil, generation: 0, updatedAtMS: 0, wantRows: 0},
		{name: "single", sets: []accountapp.AccountModelSet{single}, generation: 1_790_000_000_001, updatedAtMS: 1_790_000_000_000, wantRows: 1},
		{name: "multiple", sets: []accountapp.AccountModelSet{multiFirst, multiSecond}, generation: 1_790_000_000_502, updatedAtMS: 1_790_000_000_500, wantRows: 2},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			handler := &Handler{accountModels: fakeAccountModelReader{
				sets:        item.sets,
				generation:  item.generation,
				updatedAtMS: item.updatedAtMS,
			}}
			request := httptest.NewRequest(http.MethodGet, AccountModelsCollectionPath, nil)
			recorder := httptest.NewRecorder()
			handler.handleAccountModelsCollection(recorder, request)
			if recorder.Code != http.StatusOK {
				t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
			}
			var payload struct {
				Data        []json.RawMessage `json:"data"`
				Generation  int64             `json:"generation"`
				UpdatedAtMS int64             `json:"updated_at_ms"`
			}
			if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
				t.Fatalf("解析响应失败: %v", err)
			}
			if len(payload.Data) != item.wantRows {
				t.Fatalf("data 行数 = %d, want %d", len(payload.Data), item.wantRows)
			}
			if payload.Generation != item.generation || payload.UpdatedAtMS != item.updatedAtMS {
				t.Fatalf("指纹 = generation %d / updated_at_ms %d, want %d / %d",
					payload.Generation, payload.UpdatedAtMS, item.generation, item.updatedAtMS)
			}
		})
	}
}

// TestAccountModelsCollectionMetaOnlyReturnsStamp 覆盖条件刷新的轻量探测：
// meta_only=1 只回指纹与空 data，不返回账号行，也不能被过滤参数解析拒绝。
func TestAccountModelsCollectionMetaOnlyReturnsStamp(t *testing.T) {
	handler := &Handler{accountModels: fakeAccountModelReader{
		sets: []accountapp.AccountModelSet{
			buildModelSet(t, "acct_0123456789abcdef0123", "codex", "gpt-5", accountapp.ModelPolicyInherit),
		},
		stamp: accountapp.AccountModelCatalogStamp{Generation: 42, UpdatedAtMS: 1_790_000_000_000},
	}}
	request := httptest.NewRequest(http.MethodGet, AccountModelsCollectionPath+"?meta_only=1", nil)
	recorder := httptest.NewRecorder()
	handler.handleAccountModelsCollection(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	var payload struct {
		Data        []json.RawMessage `json:"data"`
		Generation  int64             `json:"generation"`
		UpdatedAtMS int64             `json:"updated_at_ms"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("解析响应失败: %v", err)
	}
	if len(payload.Data) != 0 {
		t.Fatalf("meta_only 不应返回账号行, got %d", len(payload.Data))
	}
	if payload.Generation != 42 || payload.UpdatedAtMS != 1_790_000_000_000 {
		t.Fatalf("指纹 = %d / %d", payload.Generation, payload.UpdatedAtMS)
	}
}

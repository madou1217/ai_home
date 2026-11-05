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
	sets []accountapp.AccountModelSet
	err  error
}

func (reader fakeAccountModelReader) ListAllAccountModels(context.Context) ([]accountapp.AccountModelSet, error) {
	return reader.sets, reader.err
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

func TestAccountModelsCollectionWithoutReaderReturns503(t *testing.T) {
	handler := &Handler{}
	request := httptest.NewRequest(http.MethodGet, AccountModelsCollectionPath, nil)
	recorder := httptest.NewRecorder()
	handler.handleAccountModelsCollection(recorder, request)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", recorder.Code)
	}
}

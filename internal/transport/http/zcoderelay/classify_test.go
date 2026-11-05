package zcoderelay

import (
	"net/http"
	"testing"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
)

func TestClassifyBusinessFailureMapsQuota(t *testing.T) {
	provider := &Provider{}
	classification, ok := provider.ClassifyBusinessFailure(200, http.Header{}, []byte(`{"code":1005,"msg":"exceed quota limit"}`))
	if !ok {
		t.Fatal("应识别为业务失败")
	}
	if classification.Kind() != runtimecore.FailureQuotaExhausted {
		t.Fatalf("kind = %v", classification.Kind())
	}
}

func TestClassifyBusinessFailureIgnoresChatBody(t *testing.T) {
	provider := &Provider{}
	if _, ok := provider.ClassifyBusinessFailure(200, http.Header{}, []byte(`{"choices":[{"message":{"content":"ok"}}]}`)); ok {
		t.Fatal("正常 chat 体不是业务失败")
	}
	if _, ok := provider.ClassifyBusinessFailure(500, http.Header{}, []byte(`{"code":1005,"msg":"x"}`)); ok {
		t.Fatal("非 2xx 交给 ClassifyFailure，不在这里处理")
	}
	if _, ok := provider.ClassifyBusinessFailure(200, http.Header{}, []byte(`data: {"choices":[]}`)); ok {
		t.Fatal("SSE 不是业务失败体")
	}
}

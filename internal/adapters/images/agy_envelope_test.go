package images_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/internal/adapters/imagegeneration"
	"github.com/madou1217/ai_home/internal/adapters/images"
)

// codeAssistDoer 模拟 Code Assist：先回答 loadCodeAssist，再回答被信封包裹的 generateContent。
type codeAssistDoer struct {
	generateBody map[string]any
}

func (doer *codeAssistDoer) Do(request *http.Request) (*http.Response, error) {
	respond := func(body string) *http.Response {
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"application/json"}}, Body: io.NopCloser(strings.NewReader(body))}
	}
	if strings.HasSuffix(request.URL.Path, ":loadCodeAssist") {
		return respond(`{"cloudaicompanionProject":"projects/synthetic-project"}`), nil
	}
	raw, _ := io.ReadAll(request.Body)
	_ = json.Unmarshal(raw, &doer.generateBody)
	return respond(`{"response":{"candidates":[{"content":{"parts":[{"inlineData":{"mimeType":"image/png","data":"` + pngBase64 + `"}}]}}]},"traceId":"t"}`), nil
}

// TestAgyImageGenerationUsesCodeAssistEnvelope 防回归：生产影子比对中 Go 裸发 Gemini 请求体，
// Code Assist 以「Unknown name contents / generationConfig」400 拒绝；响应还带 {response} 信封。
func TestAgyImageGenerationUsesCodeAssistEnvelope(t *testing.T) {
	t.Parallel()

	doer := &codeAssistDoer{}
	strategy := images.NewRegistry(images.ChatGPTCodexBaseURL, "https://example.invalid/v1internal:generateContent").
		Resolve("agy", images.Account{Provider: "agy", AccountRef: "acct_0123456789abcdef0123", AccessToken: "ya29.synthetic"})
	result, err := strategy.Generate(context.Background(), images.Input{
		Mode:    imagegeneration.ModeGeneration,
		Model:   "gemini-3.1-flash-image",
		Prompt:  "a red dot",
		N:       1,
		Account: images.Account{Provider: "agy", AccountRef: "acct_0123456789abcdef0123", AccessToken: "ya29.synthetic"},
		HTTP:    doer,
	})
	if err != nil {
		t.Fatalf("Generate() error = %v", err)
	}
	if doer.generateBody["project"] != "projects/synthetic-project" || doer.generateBody["model"] != "gemini-3.1-flash-image" {
		t.Fatalf("envelope = %v", doer.generateBody)
	}
	inner, _ := doer.generateBody["request"].(map[string]any)
	if inner == nil || inner["contents"] == nil || inner["generationConfig"] == nil {
		t.Fatalf("inner request = %v", doer.generateBody["request"])
	}
	if _, bare := doer.generateBody["contents"]; bare {
		t.Fatal("contents must be inside request, not at the envelope top level")
	}
	encoded, _ := json.Marshal(result)
	if !bytes.Contains(encoded, []byte(pngBase64)) {
		t.Fatalf("result did not carry the image: %s", encoded)
	}
}

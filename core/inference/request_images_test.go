package inference_test

import (
	"strings"
	"testing"

	"github.com/madou1217/ai_home/core/inference"
)

// imageRequest 构造一个带图片内容的请求。
func imageRequest(t *testing.T) inference.Request {
	t.Helper()

	source, err := inference.NewBase64MediaSource("image/png", "iVBORw0KGgo=")
	if err != nil {
		t.Fatalf("NewBase64MediaSource() error = %v", err)
	}
	image, err := inference.NewImageContent(source, inference.ImageDetailAuto)
	if err != nil {
		t.Fatalf("NewImageContent() error = %v", err)
	}
	text, err := inference.NewTextContent("what is this")
	if err != nil {
		t.Fatalf("NewTextContent() error = %v", err)
	}
	message, err := inference.NewMessage(inference.RoleUser, text, image)
	if err != nil {
		t.Fatalf("NewMessage() error = %v", err)
	}
	maxTokens := uint64(64)
	temperature := 0.5
	store := true
	userID := "user-1"
	request, err := inference.NewRequest(inference.RequestInput{
		ClientProtocol:  inference.ClientProtocolOpenAIChatCompletions,
		Model:           "glm-5.2",
		Messages:        []inference.Message{message},
		Stream:          true,
		MaxOutputTokens: maxTokens,
		Temperature:     &temperature,
		UserID:          &userID,
		StopSequences:   []string{"END"},
		Store:           &store,
	})
	if err != nil {
		t.Fatalf("NewRequest() error = %v", err)
	}
	return request
}

// TestHasImageContents 验证图片探测。
func TestHasImageContents(t *testing.T) {
	t.Parallel()

	if !imageRequest(t).HasImageContents() {
		t.Fatal("request with an image should report image contents")
	}
	text, err := inference.NewTextContent("plain")
	if err != nil {
		t.Fatalf("NewTextContent() error = %v", err)
	}
	message, err := inference.NewMessage(inference.RoleUser, text)
	if err != nil {
		t.Fatalf("NewMessage() error = %v", err)
	}
	plain, err := inference.NewRequest(inference.RequestInput{
		ClientProtocol: inference.ClientProtocolOpenAIChatCompletions,
		Model:          "glm-5.2",
		Messages:       []inference.Message{message},
	})
	if err != nil {
		t.Fatalf("NewRequest() error = %v", err)
	}
	if plain.HasImageContents() {
		t.Fatal("plain text request should not report image contents")
	}
}

// TestReplaceImageContentsClearsImageCapability 验证替换会重算派生能力位。
//
// 这是整个守卫能生效的前提：若 image_input 位仍在，路由依旧只挑能看图的账号，
// 替换就白做了。
func TestReplaceImageContentsClearsImageCapability(t *testing.T) {
	t.Parallel()

	request := imageRequest(t)
	if !request.RequiredCapabilities().Has(inference.CapabilityImageInput) {
		t.Fatal("fixture should require image input")
	}
	replaced, changed := request.ReplaceImageContents(func(inference.ImageContent) string {
		return "[aih: placeholder]"
	})
	if !changed {
		t.Fatal("expected the request to change")
	}
	if replaced.RequiredCapabilities().Has(inference.CapabilityImageInput) {
		t.Fatal("replaced request must no longer require image input")
	}
	if replaced.HasImageContents() {
		t.Fatal("replaced request must not report image contents")
	}
	contents := replaced.Messages()[0].Contents()
	if len(contents) != 2 {
		t.Fatalf("contents = %d, want 2 (text kept, image replaced 1:1)", len(contents))
	}
	placeholder, ok := contents[1].(inference.TextContent)
	if !ok || placeholder.Text() != "[aih: placeholder]" {
		t.Fatalf("placeholder = %#v", contents[1])
	}
}

// TestReplaceImageContentsPreservesOtherFields 验证替换不丢任何其它字段。
//
// 这条用例是「直接复制 Request 而不是经 NewRequest 重建」这个决定的守卫：
// RequestInput 里有 ExternalToolCallIDs 这类只输入不落库的字段，重建会静默丢失。
func TestReplaceImageContentsPreservesOtherFields(t *testing.T) {
	t.Parallel()

	request := imageRequest(t)
	replaced, changed := request.ReplaceImageContents(func(inference.ImageContent) string {
		return "[aih: placeholder]"
	})
	if !changed {
		t.Fatal("expected the request to change")
	}

	if replaced.ClientProtocol() != request.ClientProtocol() ||
		replaced.Model() != request.Model() ||
		replaced.Stream() != request.Stream() ||
		replaced.MaxOutputTokens() != request.MaxOutputTokens() ||
		replaced.IncludeUsageInStream() != request.IncludeUsageInStream() ||
		replaced.IncludeEncryptedReasoning() != request.IncludeEncryptedReasoning() {
		t.Fatal("scalar fields must be preserved")
	}
	if got, want := replaced.StopSequences(), request.StopSequences(); len(got) != len(want) {
		t.Fatalf("stop sequences = %#v, want %#v", got, want)
	}
	temperature, found := replaced.Temperature()
	if !found || temperature != 0.5 {
		t.Fatalf("temperature = %v found=%v", temperature, found)
	}
	if store, found := replaced.Store(); !found || !store {
		t.Fatalf("store = %v found=%v", store, found)
	}
	if userID, found := replaced.UserID(); !found || userID != "user-1" {
		t.Fatalf("user id = %q found=%v", userID, found)
	}
	if len(replaced.Messages()) != len(request.Messages()) {
		t.Fatal("message count must be preserved")
	}
	if replaced.Messages()[0].Role() != request.Messages()[0].Role() {
		t.Fatal("message role must be preserved")
	}
}

// TestReplaceImageContentsKeepsImageWhenPlaceholderIsBlank 验证失败开放。
//
// 占位文本写不出来时必须保留原图片：宁可让上游按原样拒绝，也不能静默丢掉用户内容。
func TestReplaceImageContentsKeepsImageWhenPlaceholderIsBlank(t *testing.T) {
	t.Parallel()

	request := imageRequest(t)
	for _, blank := range []string{"", "   ", "\n\t"} {
		replaced, changed := request.ReplaceImageContents(func(inference.ImageContent) string {
			return blank
		})
		if changed {
			t.Fatalf("blank placeholder %q must not change the request", blank)
		}
		if !replaced.HasImageContents() {
			t.Fatalf("blank placeholder %q must keep the image", blank)
		}
	}
}

// TestReplaceImageContentsIgnoresTextOnlyRequests 验证纯文本请求不被改动。
func TestReplaceImageContentsIgnoresTextOnlyRequests(t *testing.T) {
	t.Parallel()

	text, err := inference.NewTextContent("plain")
	if err != nil {
		t.Fatalf("NewTextContent() error = %v", err)
	}
	message, err := inference.NewMessage(inference.RoleUser, text)
	if err != nil {
		t.Fatalf("NewMessage() error = %v", err)
	}
	request, err := inference.NewRequest(inference.RequestInput{
		ClientProtocol: inference.ClientProtocolOpenAIChatCompletions,
		Model:          "glm-5.2",
		Messages:       []inference.Message{message},
	})
	if err != nil {
		t.Fatalf("NewRequest() error = %v", err)
	}
	called := false
	replaced, changed := request.ReplaceImageContents(func(inference.ImageContent) string {
		called = true
		return "x"
	})
	if called || changed {
		t.Fatal("text-only request must not invoke the replacer")
	}
	if len(replaced.Messages()) != 1 || replaced.Messages()[0].Contents()[0].Kind() != inference.ContentText {
		t.Fatal("text-only request must be returned unchanged")
	}
}

// TestReplaceImageContentsReplacesEveryImage 验证多图全部被替换。
func TestReplaceImageContentsReplacesEveryImage(t *testing.T) {
	t.Parallel()

	source, err := inference.NewBase64MediaSource("image/png", "iVBORw0KGgo=")
	if err != nil {
		t.Fatalf("NewBase64MediaSource() error = %v", err)
	}
	image, err := inference.NewImageContent(source, inference.ImageDetailAuto)
	if err != nil {
		t.Fatalf("NewImageContent() error = %v", err)
	}
	message, err := inference.NewMessage(inference.RoleUser, image, image)
	if err != nil {
		t.Fatalf("NewMessage() error = %v", err)
	}
	request, err := inference.NewRequest(inference.RequestInput{
		ClientProtocol: inference.ClientProtocolOpenAIChatCompletions,
		Model:          "glm-5.2",
		Messages:       []inference.Message{message},
	})
	if err != nil {
		t.Fatalf("NewRequest() error = %v", err)
	}
	calls := 0
	replaced, changed := request.ReplaceImageContents(func(inference.ImageContent) string {
		calls++
		return "[aih: image " + strings.Repeat("x", calls) + "]"
	})
	if !changed || calls != 2 {
		t.Fatalf("calls = %d changed=%v, want 2/true", calls, changed)
	}
	for _, content := range replaced.Messages()[0].Contents() {
		if _, isText := content.(inference.TextContent); !isText {
			t.Fatalf("content %#v should have been replaced", content)
		}
	}
}

// TestReplaceImageContentsWithoutImagesIsNoOp 验证没有图片时返回原请求。
func TestReplaceImageContentsWithoutImagesIsNoOp(t *testing.T) {
	t.Parallel()

	request := imageRequest(t)
	replaced, changed := request.ReplaceImageContents(nil)
	if changed {
		t.Fatal("nil replacer must not change the request")
	}
	if !replaced.HasImageContents() {
		t.Fatal("nil replacer must keep the image")
	}
}

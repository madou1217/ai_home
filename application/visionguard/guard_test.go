package visionguard_test

import (
	"encoding/base64"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/application/modelmetadata"
	"github.com/madou1217/ai_home/application/visionguard"
	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/internal/adapters/imageblob"
	"github.com/madou1217/ai_home/internal/adapters/images"
)

// fakeReader 按 (provider, model) 返回预设模态；未登记即「查不到」。
type fakeReader struct {
	entries map[string][]string
}

// LookupModalities 实现 visionguard.VisionReader。
func (reader fakeReader) LookupModalities(
	providerID string,
	modelID string,
) (modelmetadata.Modalities, bool) {
	values, found := reader.entries[providerID+"/"+modelID]
	if !found {
		return modelmetadata.Modalities{}, false
	}
	modalities, err := modelmetadata.NewModalities(values, []string{"text"})
	if err != nil {
		return modelmetadata.Modalities{}, false
	}
	return modalities, true
}

// imageRequest 构造带一张内联图片的请求。
func imageRequest(t *testing.T, model string, source inference.MediaSource) inference.Request {
	t.Helper()

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
	request, err := inference.NewRequest(inference.RequestInput{
		ClientProtocol: inference.ClientProtocolOpenAIChatCompletions,
		Model:          model,
		Messages:       []inference.Message{message},
	})
	if err != nil {
		t.Fatalf("NewRequest() error = %v", err)
	}
	return request
}

// base64Source 构造内联图片来源。
func base64Source(t *testing.T, payload string) inference.MediaSource {
	t.Helper()
	source, err := inference.NewBase64MediaSource(
		"image/png",
		base64.StdEncoding.EncodeToString([]byte(payload)),
	)
	if err != nil {
		t.Fatalf("NewBase64MediaSource() error = %v", err)
	}
	return source
}

// newGuard 创建使用内存 blob 仓的守卫。
func newGuard(t *testing.T, entries map[string][]string) (*visionguard.Guard, *imageblob.Store) {
	t.Helper()
	store := imageblob.NewStore(0)
	guard, err := visionguard.New(visionguard.Dependencies{
		Modalities: fakeReader{entries: entries},
		Blobs:      images.BlobStoreAdapter{Store: store},
	})
	if err != nil {
		t.Fatalf("visionguard.New() error = %v", err)
	}
	return guard, store
}

// TestGuardReplacesImagesForTextOnlyModel 验证纯文本模型的图片被换成可借视文本。
func TestGuardReplacesImagesForTextOnlyModel(t *testing.T) {
	t.Parallel()

	guard, store := newGuard(t, map[string][]string{
		"codex/gpt-5-codex": {"text"},
	})
	request := imageRequest(t, "gpt-5-codex", base64Source(t, "png-bytes"))
	rewritten, result := guard.Apply(request, "codex")

	if !result.Changed || result.Count != 1 || result.Model != "gpt-5-codex" {
		t.Fatalf("result = %#v", result)
	}
	if rewritten.HasImageContents() {
		t.Fatal("image should have been stripped")
	}
	if rewritten.RequiredCapabilities().Has(inference.CapabilityImageInput) {
		t.Fatal("image_input capability should have been cleared")
	}
	if store.Len() != 1 {
		t.Fatalf("blob store len = %d, want 1", store.Len())
	}
	placeholder, ok := rewritten.Messages()[0].Contents()[1].(inference.TextContent)
	if !ok {
		t.Fatalf("content = %#v", rewritten.Messages()[0].Contents()[1])
	}
	if !strings.Contains(placeholder.Text(), "$AIH_GATEWAY_BASE_URL/v1/blobs/") {
		t.Fatalf("placeholder = %q", placeholder.Text())
	}
	if !strings.Contains(placeholder.Text(), "(image/png)") {
		t.Fatalf("placeholder should name the mime type: %q", placeholder.Text())
	}
}

// TestGuardLeavesVisionModelsAlone 验证能看图的模型完全不被改动。
func TestGuardLeavesVisionModelsAlone(t *testing.T) {
	t.Parallel()

	guard, store := newGuard(t, map[string][]string{
		"codex/gpt-5-codex": {"text", "image"},
	})
	request := imageRequest(t, "gpt-5-codex", base64Source(t, "png-bytes"))
	rewritten, result := guard.Apply(request, "codex")

	if result.Changed || result.Count != 0 {
		t.Fatalf("result = %#v", result)
	}
	if !rewritten.HasImageContents() {
		t.Fatal("vision model must keep its images")
	}
	if store.Len() != 0 {
		t.Fatalf("blob store len = %d, want 0", store.Len())
	}
}

// TestGuardStripsUnlistedNonVisionModels 验证未收录且不属视觉家族的模型按纯文本处理。
//
// 这与 Node 的 buildFallbackModalities 同构：两种误判代价不对等——错剥一张图，
// 模型仍能按文本借视；错放一张图，上游整条 400 拒绝，模型连回合都拿不到。
func TestGuardStripsUnlistedNonVisionModels(t *testing.T) {
	t.Parallel()

	guard, store := newGuard(t, map[string][]string{
		"codex/gpt-5-codex": {"text"},
	})
	request := imageRequest(t, "glm-5.2", base64Source(t, "png-bytes"))
	rewritten, result := guard.Apply(request, "opencode")

	if !result.Changed || result.Count != 1 {
		t.Fatalf("unlisted non-vision model should be rewritten: %#v", result)
	}
	if rewritten.HasImageContents() {
		t.Fatal("image should have been stripped")
	}
	if store.Len() != 1 {
		t.Fatalf("blob store len = %d, want 1", store.Len())
	}
}

// TestGuardKeepsUnlistedVisionFamilies 验证未收录但属视觉家族的模型不被剥离。
//
// 这是折中的另一半：索引只覆盖部分 Provider，家族兜底保证 claude/gemini/gpt-4o 等
// 常见视觉模型即使没被收录也不会被无谓剥掉图片。
func TestGuardKeepsUnlistedVisionFamilies(t *testing.T) {
	t.Parallel()

	guard, store := newGuard(t, map[string][]string{})
	for _, model := range []string{
		"claude-opus-5",
		"gemini-3.5-flash",
		"gpt-4o-mini",
		"gpt-4.1-nano",
		// 版本分隔符归一化：点号版本与横线版本命中同一条家族规则。
		"gpt-4-1-mini",
		"gpt-5.2-codex",
		"o3-mini",
	} {
		request := imageRequest(t, model, base64Source(t, "png-bytes"))
		rewritten, result := guard.Apply(request, "opencode")
		if result.Changed {
			t.Fatalf("vision family %q must not be rewritten: %#v", model, result)
		}
		if !rewritten.HasImageContents() {
			t.Fatalf("vision family %q must keep its images", model)
		}
	}
	if store.Len() != 0 {
		t.Fatalf("blob store len = %d, want 0", store.Len())
	}
}

// TestGuardIndexWinsOverFamilyFallback 验证索引命中时以索引为准。
//
// 家族兜底只是「查不到时」的保守默认；索引明确说某模型是纯文本（哪怕名字像视觉家族），
// 就必须按纯文本处理。
func TestGuardIndexWinsOverFamilyFallback(t *testing.T) {
	t.Parallel()

	guard, _ := newGuard(t, map[string][]string{
		"codex/gpt-5-codex": {"text"},
	})
	request := imageRequest(t, "gpt-5-codex", base64Source(t, "png-bytes"))
	rewritten, result := guard.Apply(request, "codex")
	if !result.Changed || rewritten.HasImageContents() {
		t.Fatalf("index must win over the family fallback: %#v", result)
	}
}

// TestGuardIgnoresRequestsWithoutImages 验证纯文本请求不触发任何查询与写入。
func TestGuardIgnoresRequestsWithoutImages(t *testing.T) {
	t.Parallel()

	guard, store := newGuard(t, map[string][]string{
		"codex/gpt-5-codex": {"text"},
	})
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
		Model:          "gpt-5-codex",
		Messages:       []inference.Message{message},
	})
	if err != nil {
		t.Fatalf("NewRequest() error = %v", err)
	}
	_, result := guard.Apply(request, "codex")
	if result.Changed || store.Len() != 0 {
		t.Fatalf("result = %#v store=%d", result, store.Len())
	}
}

// TestGuardPassesThroughRemoteImageURL 验证远程图片地址原样交给 agent。
func TestGuardPassesThroughRemoteImageURL(t *testing.T) {
	t.Parallel()

	guard, store := newGuard(t, map[string][]string{
		"codex/gpt-5-codex": {"text"},
	})
	source, err := inference.NewURLMediaSource("https://example.test/cat.png", "image/png")
	if err != nil {
		t.Fatalf("NewURLMediaSource() error = %v", err)
	}
	request := imageRequest(t, "gpt-5-codex", source)
	rewritten, result := guard.Apply(request, "codex")
	if !result.Changed {
		t.Fatalf("result = %#v", result)
	}
	placeholder, ok := rewritten.Messages()[0].Contents()[1].(inference.TextContent)
	if !ok {
		t.Fatalf("content = %#v", rewritten.Messages()[0].Contents()[1])
	}
	if !strings.Contains(placeholder.Text(), "https://example.test/cat.png") {
		t.Fatalf("placeholder = %q", placeholder.Text())
	}
	if strings.Contains(placeholder.Text(), "$AIH_GATEWAY_BASE_URL") {
		t.Fatal("absolute URLs must not be prefixed with the gateway base")
	}
	if store.Len() != 0 {
		t.Fatalf("remote URL must not be stored locally: len=%d", store.Len())
	}
}

// TestGuardReportsUnrecoverableSource 验证取不回字节时如实说明而不是伪造句柄。
func TestGuardReportsUnrecoverableSource(t *testing.T) {
	t.Parallel()

	guard, _ := newGuard(t, map[string][]string{
		"codex/gpt-5-codex": {"text"},
	})
	source, err := inference.NewFileIDMediaSource("file-abc123")
	if err != nil {
		t.Fatalf("NewFileIDMediaSource() error = %v", err)
	}
	request := imageRequest(t, "gpt-5-codex", source)
	rewritten, result := guard.Apply(request, "codex")
	if !result.Changed {
		t.Fatalf("result = %#v", result)
	}
	placeholder, ok := rewritten.Messages()[0].Contents()[1].(inference.TextContent)
	if !ok {
		t.Fatalf("content = %#v", rewritten.Messages()[0].Contents()[1])
	}
	if !strings.Contains(placeholder.Text(), "(the image bytes could not be recovered)") {
		t.Fatalf("placeholder = %q", placeholder.Text())
	}
}

// TestGuardScopesLookupByProvider 验证判定带上 Provider。
//
// 同一个模型名在不同 Provider 下的模态可能不同，漏掉 Provider 会让判定用错条目。
func TestGuardScopesLookupByProvider(t *testing.T) {
	t.Parallel()

	// 用视觉家族名，才能把「索引命中」与「家族兜底」两条路径区分开：
	// claude 下索引明确说是纯文本 → 剥离；codex 下未登记 → 家族兜底保留。
	guard, _ := newGuard(t, map[string][]string{
		"claude/claude-shared": {"text"},
	})
	request := imageRequest(t, "claude-shared", base64Source(t, "png-bytes"))

	_, claudeResult := guard.Apply(request, "claude")
	if !claudeResult.Changed {
		t.Fatalf("claude result = %#v, want changed (index says text-only)", claudeResult)
	}
	_, codexResult := guard.Apply(request, "codex")
	if codexResult.Changed {
		t.Fatalf("codex result = %#v, want unchanged (unregistered, vision family)", codexResult)
	}
}

// TestRewriteMatchesApply 验证满足 inferencegateway 端口的 Rewrite 与 Apply 一致。
func TestRewriteMatchesApply(t *testing.T) {
	t.Parallel()

	guard, _ := newGuard(t, map[string][]string{
		"codex/gpt-5-codex": {"text"},
	})
	request := imageRequest(t, "gpt-5-codex", base64Source(t, "png-bytes"))
	viaApply, _ := guard.Apply(request, "codex")
	viaRewrite := guard.Rewrite(request, "codex")

	if viaApply.HasImageContents() || viaRewrite.HasImageContents() {
		t.Fatal("both entry points must strip the image")
	}
	if len(viaApply.Messages()) != len(viaRewrite.Messages()) {
		t.Fatal("both entry points must agree on the rewritten request")
	}
}

// TestNewRejectsIncompleteDependencies 验证缺少端口时不创建守卫。
func TestNewRejectsIncompleteDependencies(t *testing.T) {
	t.Parallel()

	if _, err := visionguard.New(visionguard.Dependencies{}); err == nil {
		t.Fatal("expected error for missing dependencies")
	}
	if _, err := visionguard.New(visionguard.Dependencies{
		Modalities: fakeReader{},
	}); err == nil {
		t.Fatal("expected error for missing blob writer")
	}
}

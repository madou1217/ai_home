package images_test

import (
	"encoding/base64"
	"encoding/json"
	"testing"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/imageblob"
	"github.com/madou1217/ai_home/internal/adapters/images"
)

// fixedNow 为响应渲染提供稳定时间。
func fixedNow() time.Time {
	return time.Unix(1_700_000_000, 0).UTC()
}

// decodeEnvelope 解析渲染结果。
func decodeEnvelope(t *testing.T, encoded []byte) struct {
	Created int64 `json:"created"`
	Data    []struct {
		B64JSON       string `json:"b64_json"`
		URL           string `json:"url"`
		RevisedPrompt string `json:"revised_prompt"`
	} `json:"data"`
} {
	t.Helper()
	var document struct {
		Created int64 `json:"created"`
		Data    []struct {
			B64JSON       string `json:"b64_json"`
			URL           string `json:"url"`
			RevisedPrompt string `json:"revised_prompt"`
		} `json:"data"`
	}
	if err := json.Unmarshal(encoded, &document); err != nil {
		t.Fatalf("json.Unmarshal() error = %v body=%s", err, encoded)
	}
	return document
}

// TestRenderDefaultsToInlineBase64 验证默认内联 base64 并保留改写提示词。
func TestRenderDefaultsToInlineBase64(t *testing.T) {
	t.Parallel()

	encoded, err := images.Render(
		[]images.GeneratedImage{{B64JSON: "AAAA", RevisedPrompt: "revised"}},
		images.RenderOptions{Now: fixedNow},
	)
	if err != nil {
		t.Fatalf("Render() error = %v", err)
	}
	document := decodeEnvelope(t, encoded)
	if document.Created != 1_700_000_000 {
		t.Fatalf("created = %d", document.Created)
	}
	if len(document.Data) != 1 ||
		document.Data[0].B64JSON != "AAAA" ||
		document.Data[0].URL != "" ||
		document.Data[0].RevisedPrompt != "revised" {
		t.Fatalf("data = %#v", document.Data)
	}
}

// TestRenderStoresBlobForURLFormat 验证 url 模式落 blob 并返回本机地址。
func TestRenderStoresBlobForURLFormat(t *testing.T) {
	t.Parallel()

	store := imageblob.NewStore(0)
	payload := base64.StdEncoding.EncodeToString([]byte("png-bytes"))
	encoded, err := images.Render(
		[]images.GeneratedImage{{B64JSON: payload, MIME: "image/png"}},
		images.RenderOptions{
			ResponseFormat: images.ResponseFormatURL,
			BlobBaseURL:    "http://127.0.0.1:9527",
			Blobs:          images.BlobStoreAdapter{Store: store},
			Now:            fixedNow,
		},
	)
	if err != nil {
		t.Fatalf("Render() error = %v", err)
	}
	document := decodeEnvelope(t, encoded)
	if len(document.Data) != 1 || document.Data[0].B64JSON != "" {
		t.Fatalf("data = %#v", document.Data)
	}
	url := document.Data[0].URL
	const prefix = "http://127.0.0.1:9527/v1/blobs/"
	if len(url) <= len(prefix) || url[:len(prefix)] != prefix {
		t.Fatalf("url = %q", url)
	}
	// 返回的 ID 必须真的能在仓里取回原字节。
	entry, found := store.Get(url[len(prefix):])
	if !found || string(entry.Bytes()) != "png-bytes" || entry.MIME() != "image/png" {
		t.Fatalf("stored blob = %q/%q found=%v", entry.Bytes(), entry.MIME(), found)
	}
}

// TestRenderPassesThroughRemoteURL 验证上游本来就给 URL 时原样透传。
func TestRenderPassesThroughRemoteURL(t *testing.T) {
	t.Parallel()

	encoded, err := images.Render(
		[]images.GeneratedImage{{URL: "https://upstream.example/image.png"}},
		images.RenderOptions{
			ResponseFormat: images.ResponseFormatURL,
			BlobBaseURL:    "http://127.0.0.1:9527",
			Now:            fixedNow,
		},
	)
	if err != nil {
		t.Fatalf("Render() error = %v", err)
	}
	document := decodeEnvelope(t, encoded)
	if len(document.Data) != 1 ||
		document.Data[0].URL != "https://upstream.example/image.png" {
		t.Fatalf("data = %#v", document.Data)
	}
}

// TestRenderFallsBackToInlineWhenBlobUnavailable 验证缺少 blob 端口时不静默丢图。
func TestRenderFallsBackToInlineWhenBlobUnavailable(t *testing.T) {
	t.Parallel()

	encoded, err := images.Render(
		[]images.GeneratedImage{{B64JSON: "AAAA", MIME: "image/png"}},
		images.RenderOptions{
			ResponseFormat: images.ResponseFormatURL,
			BlobBaseURL:    "http://127.0.0.1:9527",
			Now:            fixedNow,
		},
	)
	if err != nil {
		t.Fatalf("Render() error = %v", err)
	}
	document := decodeEnvelope(t, encoded)
	if len(document.Data) != 1 || document.Data[0].B64JSON != "AAAA" {
		t.Fatalf("data = %#v", document.Data)
	}
}

// TestRenderKeepsInvalidBase64Inline 验证非规范 base64 退回内联而不是丢弃。
func TestRenderKeepsInvalidBase64Inline(t *testing.T) {
	t.Parallel()

	store := imageblob.NewStore(0)
	encoded, err := images.Render(
		[]images.GeneratedImage{{B64JSON: "not base64!!"}},
		images.RenderOptions{
			ResponseFormat: images.ResponseFormatURL,
			BlobBaseURL:    "http://127.0.0.1:9527",
			Blobs:          images.BlobStoreAdapter{Store: store},
			Now:            fixedNow,
		},
	)
	if err != nil {
		t.Fatalf("Render() error = %v", err)
	}
	document := decodeEnvelope(t, encoded)
	if len(document.Data) != 1 || document.Data[0].B64JSON != "not base64!!" {
		t.Fatalf("data = %#v", document.Data)
	}
	if store.Len() != 0 {
		t.Fatalf("store len = %d, want 0", store.Len())
	}
}

// TestRenderEmitsEmptyItemForEmptyImage 验证无内容的图片渲染为空对象。
func TestRenderEmitsEmptyItemForEmptyImage(t *testing.T) {
	t.Parallel()

	encoded, err := images.Render(
		[]images.GeneratedImage{{}},
		images.RenderOptions{Now: fixedNow},
	)
	if err != nil {
		t.Fatalf("Render() error = %v", err)
	}
	if got := string(encoded); got != `{"created":1700000000,"data":[{}]}` {
		t.Fatalf("encoded = %s", got)
	}
}

// TestRenderEmptyListKeepsDataArray 验证空结果仍是数组而不是 null。
func TestRenderEmptyListKeepsDataArray(t *testing.T) {
	t.Parallel()

	encoded, err := images.Render(nil, images.RenderOptions{Now: fixedNow})
	if err != nil {
		t.Fatalf("Render() error = %v", err)
	}
	if got := string(encoded); got != `{"created":1700000000,"data":[]}` {
		t.Fatalf("encoded = %s", got)
	}
}

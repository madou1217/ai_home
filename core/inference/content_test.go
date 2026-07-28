package inference

import (
	"errors"
	"testing"
)

// TestMessageOwnsIndependentContentSnapshot 验证消息构造后不受调用方切片修改影响，
// 返回内容也不能反向修改消息内部快照。
func TestMessageOwnsIndependentContentSnapshot(t *testing.T) {
	t.Parallel()

	text, err := NewTextContent("分析账号状态")
	if err != nil {
		t.Fatalf("NewTextContent() error = %v", err)
	}
	contents := []Content{text}
	message, err := NewMessage(RoleUser, contents...)
	if err != nil {
		t.Fatalf("NewMessage() error = %v", err)
	}

	replacement, err := NewTextContent("已被调用方替换")
	if err != nil {
		t.Fatalf("NewTextContent() replacement error = %v", err)
	}
	contents[0] = replacement

	firstRead := message.Contents()
	firstText, ok := firstRead[0].(TextContent)
	if !ok || firstText.Text() != "分析账号状态" {
		t.Fatalf("Message.Contents() = %#v, want original text", firstRead)
	}
	firstRead[0] = replacement

	secondText, ok := message.Contents()[0].(TextContent)
	if !ok || secondText.Text() != "分析账号状态" {
		t.Fatalf("second Message.Contents() = %#v, want independent snapshot", message.Contents())
	}
}

// TestMediaContentPreservesTypedSources 验证图片与文档保留来源种类、媒体类型和显示选项，
// 不会退化成普通文本占位符。
func TestMediaContentPreservesTypedSources(t *testing.T) {
	t.Parallel()

	imageSource, err := NewURLMediaSource("https://example.test/image.png", "image/png")
	if err != nil {
		t.Fatalf("NewURLMediaSource() error = %v", err)
	}
	image, err := NewImageContent(imageSource, ImageDetailHigh)
	if err != nil {
		t.Fatalf("NewImageContent() error = %v", err)
	}
	if image.Kind() != ContentImage || image.Source().Kind() != MediaSourceURL {
		t.Fatalf("image = %#v, want URL image", image)
	}

	documentSource, err := NewTextMediaSource("text/plain", "完整协议说明")
	if err != nil {
		t.Fatalf("NewTextMediaSource() error = %v", err)
	}
	document, err := NewDocumentContent(documentSource, "协议说明")
	if err != nil {
		t.Fatalf("NewDocumentContent() error = %v", err)
	}
	if document.Kind() != ContentDocument || document.Title() != "协议说明" {
		t.Fatalf("document = %#v, want titled document", document)
	}
}

// TestContentRejectsInvalidRoleAndMediaCombinations 验证角色与内容组合失败关闭，
// 图片也不能接受文本文档来源。
func TestContentRejectsInvalidRoleAndMediaCombinations(t *testing.T) {
	t.Parallel()

	textSource, err := NewTextMediaSource("text/plain", "不是图片")
	if err != nil {
		t.Fatalf("NewTextMediaSource() error = %v", err)
	}
	if _, err := NewImageContent(textSource, ImageDetailAuto); !errors.Is(err, ErrInvalidContent) {
		t.Fatalf("NewImageContent() error = %v, want ErrInvalidContent", err)
	}

	imageSource, err := NewURLMediaSource("https://example.test/image.png", "image/png")
	if err != nil {
		t.Fatalf("NewURLMediaSource() error = %v", err)
	}
	image, err := NewImageContent(imageSource, ImageDetailAuto)
	if err != nil {
		t.Fatalf("NewImageContent() error = %v", err)
	}
	if _, err := NewMessage(RoleAssistant, image); !errors.Is(err, ErrInvalidMessage) {
		t.Fatalf("NewMessage() error = %v, want ErrInvalidMessage", err)
	}
}

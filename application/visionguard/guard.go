// Package visionguard 在派发前把「目标模型看不见图片」的请求里的图片换成可借视文本。
//
// 它对应 Node 的 lib/server/vision-image-guard.js。动机：请求打给看不见图片的模型
// （例如纯文本的 codex 模型）时，上游会整条拒绝（HTTP 400 "does not support image inputs"），
// 模型根本没有回合可以借视。守卫把每张图片剥离出来存进 blob 仓，并在原位留下一段指向
// blob 句柄的文本，请求因此能成功，模型可以按文本指示去借一个具备视觉能力的子代理。
//
// 本包只做协议中立的 Canonical 变换：不读账号、不发上游请求、不解析客户端线协议。
package visionguard

import (
	"encoding/base64"
	"errors"
	"strings"

	"github.com/madou1217/ai_home/application/modelmetadata"
	"github.com/madou1217/ai_home/core/inference"
)

// ErrInvalidDependencies 表示守卫缺少模态读取或 blob 写入端口。
var ErrInvalidDependencies = errors.New("vision guard 依赖无效")

// VisionReader 返回指定 Provider 与模型是否具备视觉能力。
type VisionReader interface {
	LookupModalities(providerID string, modelID string) (modelmetadata.Modalities, bool)
}

// BlobWriter 暂存被剥离出来的图片字节并返回内容寻址 ID。
type BlobWriter interface {
	Put(bytes []byte, mime string) string
}

// Dependencies 声明守卫所需的两个窄端口。
type Dependencies struct {
	// Modalities 提供离线模态索引。
	Modalities VisionReader
	// Blobs 接收被剥离的图片字节。
	Blobs BlobWriter
}

// Guard 把非视觉目标的图片内容替换为借视文本。
type Guard struct {
	modalities VisionReader
	blobs      BlobWriter
}

// New 创建守卫。
func New(dependencies Dependencies) (*Guard, error) {
	if dependencies.Modalities == nil || dependencies.Blobs == nil {
		return nil, ErrInvalidDependencies
	}
	return &Guard{modalities: dependencies.Modalities, blobs: dependencies.Blobs}, nil
}

// Result 是一次守卫判定的结果，用于日志与测试断言。
type Result struct {
	// Changed 表示请求确实被改写。
	Changed bool
	// Count 是被替换的图片数量。
	Count int
	// Model 是判定所用的模型名。
	Model string
}

// Apply 返回替换后的请求。
//
// 判定顺序刻意先做廉价短路，再做模态查询：
//  1. 请求里没有图片 → 原样返回，连模态查询都不做；
//  2. 模态索引里查不到该 (Provider, 模型) → **失败开放**，不替换。
//     这一步是关键的安全边界：Go 的离线索引只覆盖 codex/claude，若把「查不到」
//     当成「看不见图片」，所有未收录模型（grok、opencode、kimi 等）的图片都会被
//     无差别剥离——那比不做守卫更糟。Node 侧同样对未知模型失败开放。
//  3. 索引明确说该模型能看见图片 → 原样返回。
//  4. 索引明确说是纯文本模型 → 逐张替换。
func (guard *Guard) Apply(
	request inference.Request,
	providerID inference.ProviderID,
) (inference.Request, Result) {
	result := Result{Model: request.Model()}
	if guard == nil || guard.modalities == nil || guard.blobs == nil {
		return request, result
	}
	if !request.HasImageContents() {
		return request, result
	}
	modalities, found := guard.modalities.LookupModalities(string(providerID), request.Model())
	if !found {
		// 失败开放：没有权威证据说明模型看不见图片时，绝不动用户内容。
		return request, result
	}
	if supportsVision(modalities) {
		return request, result
	}
	replaced, changed := request.ReplaceImageContents(func(image inference.ImageContent) string {
		handle, mimeType := guard.stash(image)
		result.Count++
		return placeholderText(handle, mimeType)
	})
	result.Changed = changed
	if !changed {
		result.Count = 0
	}
	return replaced, result
}

// Rewrite 满足 inferencegateway.RequestRewriter：只返回改写后的请求。
//
// 判定细节（是否改写、替换了几张图）由 Apply 返回，供日志与测试使用。
func (guard *Guard) Rewrite(
	request inference.Request,
	providerID inference.ProviderID,
) inference.Request {
	rewritten, _ := guard.Apply(request, providerID)
	return rewritten
}

// supportsVision 判断模态集合是否包含图片输入。
func supportsVision(modalities modelmetadata.Modalities) bool {
	for _, value := range modalities.Input() {
		if strings.EqualFold(strings.TrimSpace(value), "image") {
			return true
		}
	}
	return false
}

// stash 把图片存进 blob 仓并返回句柄。
//
// 返回的句柄要么是网关相对路径（让本地与远程 agent 各自用自己的 base URL 解析），
// 要么是原样的绝对 http 地址；无法取回字节时返回空句柄，由占位文本如实说明。
func (guard *Guard) stash(image inference.ImageContent) (string, string) {
	source := image.Source()
	mimeType := strings.TrimSpace(source.MediaType())
	switch source.Kind() {
	case inference.MediaSourceBase64:
		bytes, err := base64.StdEncoding.DecodeString(strings.TrimSpace(source.Value()))
		if err != nil || len(bytes) == 0 {
			return "", fallbackMIME(mimeType)
		}
		if mimeType == "" {
			mimeType = "image/png"
		}
		id := guard.blobs.Put(bytes, mimeType)
		if id == "" {
			return "", mimeType
		}
		return "/v1/blobs/" + id, mimeType
	case inference.MediaSourceURL:
		url := strings.TrimSpace(source.Value())
		if isAbsoluteHTTPURL(url) {
			return url, fallbackMIME(mimeType)
		}
		return "", fallbackMIME(mimeType)
	default:
		// file_id 与 text 来源没有可剥离的字节：如实报告不可取回，不伪造句柄。
		return "", fallbackMIME(mimeType)
	}
}

// fallbackMIME 在来源没有媒体类型时给出占位说明。
func fallbackMIME(mimeType string) string {
	if mimeType == "" {
		return "image"
	}
	return mimeType
}

// isAbsoluteHTTPURL 判断是否为可直接交给 agent 的绝对 http(s) 地址。
func isAbsoluteHTTPURL(value string) bool {
	lowered := strings.ToLower(value)
	return strings.HasPrefix(lowered, "http://") || strings.HasPrefix(lowered, "https://")
}

// placeholderText 生成与 Node 一致的借视指示。
//
// 文案必须与 Node 保持同构：它是对模型的指令，两端不一致会让同一提示在两条入口下
// 给出不同的行为期望。
func placeholderText(handle string, mimeType string) string {
	location := "(the image bytes could not be recovered)"
	if handle != "" {
		if isAbsoluteHTTPURL(handle) {
			location = handle
		} else {
			location = "$AIH_GATEWAY_BASE_URL" + handle
		}
	}
	return "[aih: an image (" + mimeType + ") was attached here, but the current model cannot see images. " +
		"It is available at " + location + ". To use it, spawn a vision-capable subagent — pin it to a " +
		"vision model (e.g. the Task tool's model override, or CLAUDE_CODE_SUBAGENT_MODEL) — and have " +
		"it fetch that URL and describe the image; treat the description as ground truth. Reuse an " +
		"existing description for the same URL instead of fetching again. See the aih-collab skill.]"
}

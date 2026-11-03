package inference

import "strings"

// ReplaceImageContents 返回把图片内容替换为文本占位的新请求。
//
// 它用于「目标模型看不见图片」的场景：把每张图片换成一段指向可借视图的文本，
// 让请求能通过上游校验，而不是被整条拒绝。
//
// 实现刻意复制整个 Request 并只重算派生字段，而不是经 NewRequest 重建：
// RequestInput 里存在 ExternalToolCallIDs 这类「只有输入、不落 Request」的字段，
// 重建会让它们静默丢失，连带让工具配对校验与原始请求不一致。直接复制则天然不会
// 漏掉任何已存字段，包括以后新增的字段。
//
// replace 对每个图片内容返回占位文本：
//   - 返回非空白文本 → 该图片被替换；
//   - 返回空白文本 → 保留原图片（失败开放，绝不因为占位文本写不出来就丢掉用户内容）。
//
// 第二个返回值表示是否真的发生了替换。
func (request Request) ReplaceImageContents(
	replace func(ImageContent) string,
) (Request, bool) {
	if replace == nil || len(request.messages) == 0 {
		return request, false
	}
	next := request
	next.messages = make([]Message, len(request.messages))
	changed := false
	for messageIndex, message := range request.messages {
		contents := message.Contents()
		replaced := make([]Content, 0, len(contents))
		messageChanged := false
		for _, content := range contents {
			image, isImage := content.(ImageContent)
			if !isImage {
				replaced = append(replaced, content)
				continue
			}
			text := replace(image)
			if strings.TrimSpace(text) == "" {
				// 占位文本不可用时保留原图片，避免静默丢内容。
				replaced = append(replaced, content)
				continue
			}
			placeholder, err := NewTextContent(text)
			if err != nil {
				replaced = append(replaced, content)
				continue
			}
			replaced = append(replaced, placeholder)
			messageChanged = true
		}
		if !messageChanged {
			next.messages[messageIndex] = message
			continue
		}
		// 长度不变，因此角色、阶段与既有不变量都保持成立。
		rebuilt, err := newMessage(message.Role(), message.Phase(), replaced)
		if err != nil {
			// 重建失败时不改动这条消息，宁可保留图片也不破坏请求。
			next.messages[messageIndex] = message
			continue
		}
		next.messages[messageIndex] = rebuilt
		changed = true
	}
	if !changed {
		return request, false
	}
	// 图片被移除后所需能力会变化（例如不再需要 vision），必须重算，
	// 否则路由仍会按「需要视觉」去筛选账号，替换就白做了。
	next.capabilities = deriveRequiredCapabilities(next)
	return next, true
}

// HasImageContents 判断请求里是否带有图片内容。
//
// 它让调用方先做一次廉价的短路判断，避免为纯文本请求白跑一遍模态查询。
func (request Request) HasImageContents() bool {
	for _, message := range request.messages {
		for _, content := range message.Contents() {
			if _, isImage := content.(ImageContent); isImage {
				return true
			}
		}
	}
	return false
}

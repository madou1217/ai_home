package webuichatapi

import "testing"

// 最小合法指令：只有 commandId / type / content / model。
func TestDecodeTurnSubmitAcceptsMinimalCommand(t *testing.T) {
	document := []byte(`{"commandId":"c-1","type":"turn.submit","payload":{"content":"  你好  ","model":"gpt-test"}}`)
	command, routeErr := decodeTurnSubmit(document)
	if routeErr != nil {
		t.Fatalf("decodeTurnSubmit() error = %+v", routeErr)
	}
	if command.CommandID != "c-1" || command.Content != "你好" || command.Model != "gpt-test" {
		t.Fatalf("command = %+v", command)
	}
}

// 校验口径逐条对齐 Node normalizeCommand / normalizeTurnSubmit。
func TestDecodeTurnSubmitRejectsInvalidCommands(t *testing.T) {
	cases := []struct {
		name   string
		body   string
		status int
		code   string
	}{
		{
			name:   "缺 commandId",
			body:   `{"type":"turn.submit","payload":{"content":"hi"}}`,
			status: 400,
			code:   "chat_command_id_required",
		},
		{
			name:   "缺 type",
			body:   `{"commandId":"c-1"}`,
			status: 400,
			code:   "chat_command_type_required",
		},
		{
			name:   "不支持的指令类型",
			body:   `{"commandId":"c-1","type":"turn.retry"}`,
			status: 422,
			code:   "unsupported_chat_command",
		},
		{
			name:   "载荷不是对象",
			body:   `{"commandId":"c-1","type":"turn.submit","payload":[]}`,
			status: 400,
			code:   "invalid_chat_payload",
		},
		{
			name:   "正文为空且无附件",
			body:   `{"commandId":"c-1","type":"turn.submit","payload":{"content":"   "}}`,
			status: 422,
			code:   "chat_turn_content_required",
		},
		{
			name:   "客户端伪造轮次身份",
			body:   `{"commandId":"c-1","type":"turn.submit","payload":{"content":"hi","turnId":"forged"}}`,
			status: 422,
			code:   "chat_turn_identity_client_controlled",
		},
		{
			name:   "附件不是数组",
			body:   `{"commandId":"c-1","type":"turn.submit","payload":{"content":"hi","attachmentIds":"a1"}}`,
			status: 422,
			code:   "chat_attachment_ids_invalid",
		},
		{
			name:   "附件超过上限",
			body:   `{"commandId":"c-1","type":"turn.submit","payload":{"content":"hi","attachmentIds":["a1","a2","a3","a4","a5","a6","a7","a8","a9"]}}`,
			status: 422,
			code:   "chat_attachment_ids_invalid",
		},
		{
			name:   "附件重复",
			body:   `{"commandId":"c-1","type":"turn.submit","payload":{"content":"hi","attachmentIds":["a1","a1"]}}`,
			status: 422,
			code:   "chat_attachment_ids_duplicate",
		},
		{
			name:   "附件标识为空",
			body:   `{"commandId":"c-1","type":"turn.submit","payload":{"content":"hi","attachmentIds":["  "]}}`,
			status: 422,
			code:   "chat_attachment_id_invalid",
		},
		{
			name:   "模型为空串",
			body:   `{"commandId":"c-1","type":"turn.submit","payload":{"content":"hi","model":"  "}}`,
			status: 422,
			code:   "chat_turn_model_control_invalid",
		},
		{
			name:   "推理强度为空串",
			body:   `{"commandId":"c-1","type":"turn.submit","payload":{"content":"hi","reasoningEffort":""}}`,
			status: 422,
			code:   "chat_turn_model_control_invalid",
		},
		{
			name:   "顶层不是对象",
			body:   `[]`,
			status: 400,
			code:   "invalid_chat_runtime_payload",
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			_, routeErr := decodeTurnSubmit([]byte(testCase.body))
			if routeErr == nil {
				t.Fatalf("期望失败，实际通过")
			}
			if routeErr.Status != testCase.status || routeErr.Code != testCase.code {
				t.Fatalf("错误 = %d/%s, want %d/%s", routeErr.Status, routeErr.Code, testCase.status, testCase.code)
			}
		})
	}
}

// 空正文按 {} 处理：与 Node readJsonBody 的「空体即空对象」一致，
// 让调用方看到的是缺 commandId 而不是笼统的载荷无效。
func TestDecodeTurnSubmitTreatsEmptyBodyAsEmptyObject(t *testing.T) {
	_, routeErr := decodeTurnSubmit(nil)
	if routeErr == nil || routeErr.Code != "chat_command_id_required" {
		t.Fatalf("错误 = %+v, want chat_command_id_required", routeErr)
	}
}

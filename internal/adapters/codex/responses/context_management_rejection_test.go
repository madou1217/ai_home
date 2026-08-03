package responses

import (
	"errors"
	"strings"
	"testing"

	codexauth "github.com/madou1217/ai_home/core/accounts/codex"
	"github.com/madou1217/ai_home/core/inference"
)

// TestEncodeRequestRejectsClaudeContextManagement 验证直调 Encoder 时也不会
// 把 Claude 上下文编辑静默丢弃后发送给 Codex。
func TestEncodeRequestRejectsClaudeContextManagement(t *testing.T) {
	t.Parallel()

	edit, err := inference.NewClearThinkingEdit(nil)
	if err != nil {
		t.Fatalf("NewClearThinkingEdit() error = %v", err)
	}
	management, err := inference.NewContextManagement(edit)
	if err != nil {
		t.Fatalf("NewContextManagement() error = %v", err)
	}
	input := minimalRequestInput(t, func(input *inference.RequestInput) {
		input.ContextManagement = &management
	})
	request, err := inference.NewRequest(input)
	if err != nil {
		t.Fatalf("NewRequest() error = %v", err)
	}
	_, err = encodeRequest(
		request,
		"gpt-5.6-sol",
		codexauth.AuthKindAPIKey,
		requestProfileForModel("gpt-5.6-sol"),
	)
	if !errors.Is(err, ErrUnsupportedRequest) ||
		!strings.Contains(err.Error(), "context_management") {
		t.Fatalf("encodeRequest() error = %v", err)
	}
}

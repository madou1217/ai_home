package aihlogin

import (
	"errors"
	"strings"
	"testing"
)

// TestCredentialFailure 非零退出码只在缺少凭据时并入错误。
func TestCredentialFailure(t *testing.T) {
	missing := errors.New("未找到凭据")
	wrapped := credentialFailure(130, missing)
	if !errors.Is(wrapped, missing) || !strings.Contains(wrapped.Error(), "退出码 130") {
		t.Fatalf("wrapped = %v", wrapped)
	}
	plain := credentialFailure(0, missing)
	if plain != missing {
		t.Fatalf("zero exit should return original error: %v", plain)
	}
}

package oauthutil

import (
	"bytes"
	"errors"
	"testing"
)

// TestDecodeJSONResponseRejectsDuplicateAndOversizedDocuments 验证 OAuth 上游 JSON 失败关闭。
func TestDecodeJSONResponseRejectsDuplicateAndOversizedDocuments(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		document []byte
		maxBytes int64
	}{
		{
			name:     "重复顶层键",
			document: []byte(`{"token":"first","token":"second"}`),
			maxBytes: 1024,
		},
		{
			name:     "重复嵌套键",
			document: []byte(`{"data":{"token":"first","token":"second"}}`),
			maxBytes: 1024,
		},
		{
			name:     "超过大小",
			document: []byte(`{"token":"large"}`),
			maxBytes: 4,
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			var target map[string]any
			err := DecodeJSONResponse(
				bytes.NewReader(test.document),
				test.maxBytes,
				&target,
			)
			if !errors.Is(err, ErrInvalidJSONResponse) {
				t.Fatalf("DecodeJSONResponse() error = %v", err)
			}
		})
	}
}

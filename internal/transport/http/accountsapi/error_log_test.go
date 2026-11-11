package accountsapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/application/accountcredentials"
	accountapp "github.com/madou1217/ai_home/application/accounts"
)

// withCapturedLog 把标准库日志临时重定向到 buffer，测试结束恢复。
func withCapturedLog(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buffer bytes.Buffer
	previous := log.Writer()
	log.SetOutput(&buffer)
	t.Cleanup(func() { log.SetOutput(previous) })
	return &buffer
}

func TestWriteApplicationErrorLogsUnmappedError(t *testing.T) {
	buffer := withCapturedLog(t)
	recorder := httptest.NewRecorder()

	writeApplicationError(recorder, errors.New("cline codec: unsupported artifact slot acct_content"))

	if recorder.Code != 500 {
		t.Fatalf("status = %d, want 500", recorder.Code)
	}
	var payload struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("响应不是 JSON: %v", err)
	}
	if payload.Error.Code != "internal_error" {
		t.Fatalf("error.code = %q, want internal_error", payload.Error.Code)
	}
	logged := buffer.String()
	if !strings.Contains(logged, "accountsapi: internal_error") {
		t.Fatalf("日志缺少操作名: %q", logged)
	}
	if !strings.Contains(logged, "unsupported artifact slot") {
		t.Fatalf("日志缺少原始错误: %q", logged)
	}
	if strings.Contains(recorder.Body.String(), "unsupported artifact slot") {
		t.Fatal("原始错误不能出现在客户端响应里")
	}
}

func TestWriteApplicationErrorDoesNotLogMappedError(t *testing.T) {
	buffer := withCapturedLog(t)
	recorder := httptest.NewRecorder()

	writeApplicationError(recorder, accountapp.ErrAccountNotFound)

	if recorder.Code != 404 {
		t.Fatalf("status = %d, want 404", recorder.Code)
	}
	if buffer.Len() != 0 {
		t.Fatalf("已映射的 4xx 不应写服务端错误日志: %q", buffer.String())
	}
}

func TestWriteApplicationErrorMapsReauthenticationUnsupported(t *testing.T) {
	buffer := withCapturedLog(t)
	recorder := httptest.NewRecorder()

	writeApplicationError(recorder, accountapp.ErrReauthenticationUnsupported)

	if recorder.Code != 409 {
		t.Fatalf("status = %d, want 409（能力边界不是服务端异常）", recorder.Code)
	}
	var payload struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("响应不是 JSON: %v", err)
	}
	if payload.Error.Code != "account_reauth_unsupported" {
		t.Fatalf("error.code = %q", payload.Error.Code)
	}
	if buffer.Len() != 0 {
		t.Fatalf("已映射的 4xx 不应写服务端错误日志: %q", buffer.String())
	}
}

func TestLogServerErrorTruncatesLongErrors(t *testing.T) {
	buffer := withCapturedLog(t)
	long := strings.Repeat("错", maxLoggedErrorRunes+50)

	logServerError("native_import provider=cline artifacts=1", errors.New(long))

	logged := buffer.String()
	if !strings.Contains(logged, "native_import provider=cline artifacts=1") {
		t.Fatalf("日志缺少上下文: %q", logged[:80])
	}
	if !strings.HasSuffix(strings.TrimSpace(logged), "…") {
		t.Fatal("超长错误必须被截断并以省略号结尾")
	}
	if strings.Count(logged, "错") > maxLoggedErrorRunes {
		t.Fatalf("截断后仍有 %d 个字符", strings.Count(logged, "错"))
	}
}

// 凭据刷新失败必须有稳定语义：失效 grant → 401 重登；其它刷新失败 → 502。
// 之前统一掉进 internal_error 500，前端只能看到「账号服务内部错误」。
func TestWriteApplicationErrorMapsCredentialRefreshFailures(t *testing.T) {
	cases := []struct {
		name       string
		err        error
		wantStatus int
		wantCode   string
	}{
		{
			name:       "重新认证",
			err:        fmt.Errorf("%w: oauth status=400 code=\"invalid_grant\"", accountcredentials.ErrReauthenticationRequired),
			wantStatus: 401,
			wantCode:   "account_reauth_required",
		},
		{
			name:       "刷新暂时不可用",
			err:        fmt.Errorf("%w: 账号出口模式 pool 需要宿主代理", accountcredentials.ErrRefreshUnavailable),
			wantStatus: 502,
			wantCode:   "credential_refresh_failed",
		},
		{
			name:       "刷新被拒绝",
			err:        accountcredentials.ErrRefreshRejected,
			wantStatus: 502,
			wantCode:   "credential_refresh_failed",
		},
		{
			name:       "刷新结果无效",
			err:        accountcredentials.ErrInvalidRefreshResult,
			wantStatus: 502,
			wantCode:   "credential_refresh_invalid",
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			writeApplicationError(recorder, testCase.err)
			if recorder.Code != testCase.wantStatus {
				t.Fatalf("status = %d, want %d", recorder.Code, testCase.wantStatus)
			}
			var payload map[string]any
			if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
				t.Fatalf("响应不是 JSON: %v", err)
			}
			errorDocument, _ := payload["error"].(map[string]any)
			code, _ := errorDocument["code"].(string)
			if code != testCase.wantCode {
				t.Fatalf("error.code = %q, want %q", code, testCase.wantCode)
			}
		})
	}
}

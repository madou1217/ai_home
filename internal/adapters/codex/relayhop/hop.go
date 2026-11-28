// Package relayhop 识别“上游是另一台 aih（或它的 Cloudflare 入口）”的账号，
// 并为这类跨机 hop 的 edge 5xx 提供统一的可重试语义。
package relayhop

import (
	"context"
	"log"
	"net/http"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	codexauth "github.com/madou1217/ai_home/core/accounts/codex"
	"github.com/madou1217/ai_home/core/requestid"
)

// IsCredential 报告账号是否是跨机 aih 中继的 API-key 端点。
func IsCredential(credential accountapp.Credential) bool {
	_, ok := credential.(*codexauth.APIKeyAuth)
	return ok
}

// EdgeStatus 是中继 hop 上可重试、但不该冷却账号的上游状态。
func EdgeStatus(response *http.Response) bool {
	if response == nil {
		return false
	}
	switch response.StatusCode {
	case http.StatusBadGateway, http.StatusServiceUnavailable, 530:
		return true
	default:
		return false
	}
}

// LogUnavailable 记录中继 hop 的 edge 5xx，附 request id 与 Cloudflare 线索。
func LogUnavailable(ctx context.Context, response *http.Response, surface string) {
	status := 0
	host := ""
	cfRay := ""
	if response != nil {
		status = response.StatusCode
		cfRay = response.Header.Get("cf-ray")
		if response.Request != nil && response.Request.URL != nil {
			host = response.Request.URL.Host
		}
	}
	log.Printf("codex responses %s relay hop unavailable status=%d host=%s cf_ray=%s request_id=%s",
		surface, status, host, cfRay, requestid.FromContext(ctx))
}

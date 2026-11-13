package subaggregatorpublicapi

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/internal/runtime/subaggregator"
)

type stubService struct {
	lastSubToken string
	lastSubReq   subaggregator.ServeRequest
	subResp      subaggregator.ServeResponse
	subErr       error

	lastRuleToken  string
	lastRuleTag    string
	lastRuleTarget string
	ruleResp       subaggregator.ServeResponse
	ruleErr        error
}

func (s *stubService) ServeSubscription(_ context.Context, token string, req subaggregator.ServeRequest) (subaggregator.ServeResponse, error) {
	s.lastSubToken = token
	s.lastSubReq = req
	return s.subResp, s.subErr
}

func (s *stubService) ServeRuleSet(_ context.Context, token, tag, target string) (subaggregator.ServeResponse, error) {
	s.lastRuleToken = token
	s.lastRuleTag = tag
	s.lastRuleTarget = target
	return s.ruleResp, s.ruleErr
}

func TestNewHandlerValidation(t *testing.T) {
	if _, err := NewHandler(Dependencies{}); !errors.Is(err, ErrInvalidDependencies) {
		t.Fatalf("期望返回 ErrInvalidDependencies，实际: %v", err)
	}
	var nilHandler *Handler
	rec := httptest.NewRecorder()
	nilHandler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/sub/abcdefghijklmnop", nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("nil handler 应返回 503，实际 %d", rec.Code)
	}
}

func TestMethodAndPathValidation(t *testing.T) {
	svc := &stubService{}
	h, err := NewHandler(Dependencies{Service: svc})
	if err != nil {
		t.Fatal(err)
	}

	// 非 GET/HEAD 一律 405
	for _, method := range []string{http.MethodPost, http.MethodPut, http.MethodDelete} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(method, "/sub/abcdefghijklmnop", nil)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusMethodNotAllowed {
			t.Fatalf("%s 预期 405，实际 %d", method, rec.Code)
		}
		if rec.Body.String() != "method not allowed" {
			t.Fatalf("%s 预期响应体 method not allowed，实际 %q", method, rec.Body.String())
		}
		if rec.Header().Get("Allow") != "GET, HEAD" {
			t.Fatalf("缺少 Allow 头: %q", rec.Header().Get("Allow"))
		}
	}

	// 非法路径 / 过短 token / 非法规则集命名均返回 404 not found
	invalidPaths := []string{
		"/other/abcdefghijklmnop",
		"/sub/",
		"/sub/too-short",
		"/sub/has$illegalchar1234",
		"/sub/abcdefghijklmnop/extra",
		"/sub/abcdefghijklmnop/rules/other-custom",
		"/sub/abcdefghijklmnop/rules/geosite-../etc",
	}
	for _, p := range invalidPaths {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, p, nil)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusNotFound || rec.Body.String() != "not found" {
			t.Fatalf("GET %s 预期 404 not found，实际 %d %q", p, rec.Code, rec.Body.String())
		}
	}
}

func TestServeSubscriptionParametersHeadersAndHEAD(t *testing.T) {
	svc := &stubService{
		subResp: subaggregator.ServeResponse{
			Status: http.StatusOK,
			Headers: map[string]string{
				"Content-Type":            "text/yaml; charset=utf-8",
				"Content-Disposition":     "attachment; filename*=UTF-8''Main.yaml",
				"Cache-Control":           "no-store",
				"profile-title":           "base64:TWFpbg==",
				"profile-update-interval": "12",
				"subscription-userinfo":   "upload=0; download=0; total=1024; expire=0",
			},
			Body: "proxies:\n  - name: HK\n",
		},
	}
	h, err := NewHandler(Dependencies{Service: svc})
	if err != nil {
		t.Fatal(err)
	}

	token := "AbCdEfGh12345678_-token"
	req := httptest.NewRequest(http.MethodGet, "/sub/"+token+"?format=clash&view=compact&relay=1", nil)
	req.RemoteAddr = "127.0.0.1:45678"
	req.Header.Set("User-Agent", "ClashMeta/1.18")
	req.Header.Set("X-Forwarded-Host", "sub.example.com:9527")
	req.Header.Set("X-Forwarded-Proto", "https")
	req.Header.Set("X-AIH-Remote-Addr", "198.51.100.22")

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("预期 200，实际 %d body=%q", rec.Code, rec.Body.String())
	}
	if rec.Body.String() != svc.subResp.Body {
		t.Fatalf("响应体不一致: %q", rec.Body.String())
	}
	if rec.Header().Get("Profile-Title") != "base64:TWFpbg==" || rec.Header().Get("Profile-Update-Interval") != "12" {
		t.Fatalf("订阅元信息响应头缺失: %+v", rec.Header())
	}
	if rec.Header().Get("Subscription-Userinfo") != "upload=0; download=0; total=1024; expire=0" {
		t.Fatalf("缺少 subscription-userinfo 头: %+v", rec.Header())
	}
	if svc.lastSubToken != token {
		t.Fatalf("token=%q", svc.lastSubToken)
	}
	if svc.lastSubReq.Target != "clash" || svc.lastSubReq.View != "compact" {
		t.Fatalf("解析查询参数错误: %+v", svc.lastSubReq)
	}
	if svc.lastSubReq.UserAgent != "ClashMeta/1.18" {
		t.Fatalf("UserAgent=%q", svc.lastSubReq.UserAgent)
	}
	if svc.lastSubReq.Origin != "https://sub.example.com:9527" {
		t.Fatalf("Origin=%q", svc.lastSubReq.Origin)
	}
	if svc.lastSubReq.RemoteAddress != "198.51.100.22" {
		t.Fatalf("RemoteAddress=%q", svc.lastSubReq.RemoteAddress)
	}
	if svc.lastSubReq.Relay == nil || !*svc.lastSubReq.Relay {
		t.Fatalf("期望 relay=true，实际 %v", svc.lastSubReq.Relay)
	}

	// HEAD 返回全部响应头和 Content-Length，但响应体必须为空。
	headReq := httptest.NewRequest(http.MethodHead, "/sub/"+token+"?target=mihomo&relay=false", nil)
	headReq.RemoteAddr = "203.0.113.5:12345"
	headReq.Header.Set("X-AIH-Remote-Addr", "127.0.0.1") // 非回环直连不可伪造转发头
	headRec := httptest.NewRecorder()
	h.ServeHTTP(headRec, headReq)

	if headRec.Code != http.StatusOK {
		t.Fatalf("HEAD 预期 200，实际 %d", headRec.Code)
	}
	if headRec.Body.Len() != 0 {
		t.Fatalf("HEAD 不得返回响应体，实际 %q", headRec.Body.String())
	}
	if headRec.Header().Get("Content-Type") != "text/yaml; charset=utf-8" {
		t.Fatalf("HEAD 缺少 Content-Type: %+v", headRec.Header())
	}
	wantLen := strconv.Itoa(len(svc.subResp.Body))
	if headRec.Header().Get("Content-Length") != wantLen {
		t.Fatalf("HEAD Content-Length 预期 %q，实际 %q", wantLen, headRec.Header().Get("Content-Length"))
	}
	if svc.lastSubReq.Relay == nil || *svc.lastSubReq.Relay {
		t.Fatalf("relay=false 解析失败: %v", svc.lastSubReq.Relay)
	}
	if svc.lastSubReq.RemoteAddress != "203.0.113.5:12345" {
		t.Fatalf("非回环直连不得信任 X-AIH-Remote-Addr，实际 %q", svc.lastSubReq.RemoteAddress)
	}
}

func TestServeRuleSetAndErrorMappings(t *testing.T) {
	svc := &stubService{
		ruleResp: subaggregator.ServeResponse{
			Status: http.StatusOK,
			Headers: map[string]string{
				"Content-Type":  "text/plain; charset=utf-8",
				"Cache-Control": "public, max-age=3600",
			},
			Body: "DOMAIN-SUFFIX,openai.com\n",
		},
	}
	h, err := NewHandler(Dependencies{Service: svc})
	if err != nil {
		t.Fatal(err)
	}

	token := "token_1234567890_ab"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/sub/"+token+"/rules/geosite-openai?target=surge", nil))
	if rec.Code != http.StatusOK || rec.Body.String() != "DOMAIN-SUFFIX,openai.com\n" {
		t.Fatalf("rule-set 响应异常: %d %q", rec.Code, rec.Body.String())
	}
	if svc.lastRuleToken != token || svc.lastRuleTag != "geosite-openai" || svc.lastRuleTarget != "surge" {
		t.Fatalf("rule-set 参数不符: token=%q tag=%q target=%q", svc.lastRuleToken, svc.lastRuleTag, svc.lastRuleTarget)
	}

	cases := []struct {
		name       string
		err        error
		wantStatus int
		wantPrefix string
	}{
		{name: "not_found", err: &subaggregator.DomainError{Code: "aggregator_rule_set_not_found"}, wantStatus: http.StatusNotFound, wantPrefix: "not found"},
		{name: "bad_target", err: &subaggregator.DomainError{Code: "unsupported_aggregator_format"}, wantStatus: http.StatusBadRequest, wantPrefix: "unsupported target"},
		{name: "fetch_fail", err: &subaggregator.DomainError{Code: "aggregator_rule_set_fetch_failed"}, wantStatus: http.StatusBadGateway, wantPrefix: "not found"},
		{name: "domain_internal", err: &subaggregator.DomainError{Code: "aggregator_store_corrupt"}, wantStatus: http.StatusInternalServerError, wantPrefix: "subscription render failed: aggregator_store_corrupt"},
		{name: "unexpected", err: errors.New("boom"), wantStatus: http.StatusInternalServerError, wantPrefix: "subscription render failed: internal_error"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			svc.ruleErr = tc.err
			r := httptest.NewRecorder()
			h.ServeHTTP(r, httptest.NewRequest(http.MethodGet, "/sub/"+token+"/rules/geoip-cn?target=surge", nil))
			if r.Code != tc.wantStatus || r.Body.String() != tc.wantPrefix {
				t.Fatalf("status=%d want=%d body=%q want=%q", r.Code, tc.wantStatus, r.Body.String(), tc.wantPrefix)
			}
		})
	}
}

func TestWithRealSubaggregatorServiceEndToEnd(t *testing.T) {
	aiHome := t.TempDir()
	hostHome := t.TempDir()
	svc := subaggregator.NewService(aiHome, subaggregator.ServiceOptions{
		HostHomeDir: hostHome,
	})

	if _, err := svc.SaveSource(context.Background(), map[string]any{
		"name":    "RealLocal",
		"kind":    "local",
		"content": "trojan://pw1@hk.example.com:443#HK%2001",
	}); err != nil {
		t.Fatalf("SaveSource: %v", err)
	}
	prof, err := svc.SaveProfile(map[string]any{
		"name": "RealProfile",
		"sources": map[string]any{
			"all": true,
		},
	})
	if err != nil {
		t.Fatalf("SaveProfile: %v", err)
	}

	h, err := NewHandler(Dependencies{Service: svc})
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(h)
	defer srv.Close()

	// 1. 未知 token -> 404
	resp404, err := http.Get(srv.URL + "/sub/unknown_token_123456")
	if err != nil {
		t.Fatal(err)
	}
	raw404, _ := io.ReadAll(resp404.Body)
	_ = resp404.Body.Close()
	if resp404.StatusCode != http.StatusNotFound || string(raw404) != "not found" {
		t.Fatalf("未知 token 预期 404 not found，实际 %d %q", resp404.StatusCode, string(raw404))
	}

	// 2. 不支持的目标格式 -> 400 unsupported target
	resp400, err := http.Get(srv.URL + "/sub/" + prof.Token + "?target=invalid_fmt")
	if err != nil {
		t.Fatal(err)
	}
	raw400, _ := io.ReadAll(resp400.Body)
	_ = resp400.Body.Close()
	if resp400.StatusCode != http.StatusBadRequest || string(raw400) != "unsupported target" {
		t.Fatalf("不支持格式预期 400 unsupported target，实际 %d %q", resp400.StatusCode, string(raw400))
	}

	// 3. 真实聚合订阅渲染 -> 200 clash YAML
	reqOK, _ := http.NewRequest(http.MethodGet, srv.URL+"/sub/"+prof.Token+"?target=clash&relay=0", nil)
	reqOK.Header.Set("X-Forwarded-Host", "my.proxy.local:9527")
	reqOK.Header.Set("X-Forwarded-Proto", "http")
	respOK, err := http.DefaultClient.Do(reqOK)
	if err != nil {
		t.Fatal(err)
	}
	rawOK, _ := io.ReadAll(respOK.Body)
	_ = respOK.Body.Close()
	if respOK.StatusCode != http.StatusOK {
		t.Fatalf("订阅拉取预期 200，实际 %d", respOK.StatusCode)
	}
	if !strings.Contains(string(rawOK), "HK 01") {
		t.Fatalf("渲染结果缺少节点 HK 01: %s", string(rawOK))
	}
	if respOK.Header.Get("Profile-Title") == "" {
		t.Fatalf("缺少 Profile-Title 头: %+v", respOK.Header)
	}

	// 4. 真实规则集不存在 -> 404 not found
	respRule404, err := http.Get(srv.URL + "/sub/" + prof.Token + "/rules/geosite-missing-tag?target=surge")
	if err != nil {
		t.Fatal(err)
	}
	rawRule404, _ := io.ReadAll(respRule404.Body)
	_ = respRule404.Body.Close()
	if respRule404.StatusCode != http.StatusNotFound || string(rawRule404) != "not found" {
		t.Fatalf("未知规则集预期 404 not found，实际 %d %q", respRule404.StatusCode, string(rawRule404))
	}
}

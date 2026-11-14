package aihserver

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/madou1217/ai_home/internal/transport/http/webuiegresspoolapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiegressupstreamsapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuigeoresourcesapi"
)

type testEgressAuthorizer struct{}

func (testEgressAuthorizer) Authorized(r *http.Request) bool {
	return r.Header.Get("Authorization") == "Bearer test-mgmt"
}

func TestBuildWebUIEgressGeoRoutesMuxAndDispatch(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	hostDir := t.TempDir()

	routes, err := buildWebUIEgressGeoRoutes(webuiRouteDependencies{
		Authorizer:  testEgressAuthorizer{},
		AIHomeDir:   dir,
		HostHomeDir: hostDir,
	})
	if err != nil {
		t.Fatalf("buildWebUIEgressGeoRoutes error = %v", err)
	}
	if len(routes) != 27 {
		t.Fatalf("路由数 = %d，期望 27", len(routes))
	}

	mux := http.NewServeMux()
	for _, r := range routes {
		mux.Handle(r.Pattern, r.Handler)
	}

	// 1. GeoIP 资源列表
	reqGeo := httptest.NewRequest(http.MethodGet, webuigeoresourcesapi.Path, nil)
	reqGeo.Header.Set("Authorization", "Bearer test-mgmt")
	recGeo := httptest.NewRecorder()
	mux.ServeHTTP(recGeo, reqGeo)
	if recGeo.Code != http.StatusOK {
		t.Fatalf("GET geo-resources = %d body=%s", recGeo.Code, recGeo.Body.String())
	}

	// 2. 出口池无节点时也返回正常结构（available=false）
	reqPool := httptest.NewRequest(http.MethodGet, webuiegresspoolapi.Path, nil)
	reqPool.Header.Set("Authorization", "Bearer test-mgmt")
	recPool := httptest.NewRecorder()
	mux.ServeHTTP(recPool, reqPool)
	if recPool.Code != http.StatusOK {
		t.Fatalf("GET egress-pool = %d body=%s", recPool.Code, recPool.Body.String())
	}
	var poolDoc map[string]any
	if err := json.Unmarshal(recPool.Body.Bytes(), &poolDoc); err != nil || poolDoc["ok"] != true {
		t.Fatalf("egress-pool 响应无效: %v %s", err, recPool.Body.String())
	}

	// 3. 修改 node-policy 与清理禁用节点
	reqPol := httptest.NewRequest(http.MethodPost, webuiegresspoolapi.PolicyPath, bytes.NewBufferString(`{"unreachable":{"enabled":true}}`))
	reqPol.Header.Set("Authorization", "Bearer test-mgmt")
	recPol := httptest.NewRecorder()
	mux.ServeHTTP(recPol, reqPol)
	if recPol.Code != http.StatusOK {
		t.Fatalf("POST node-policy = %d body=%s", recPol.Code, recPol.Body.String())
	}

	// 4. 上游列表与不存在账号校验
	reqAcc := httptest.NewRequest(http.MethodGet, webuiegressupstreamsapi.AccountEgressPrefix+"claude/acct_1234567890abcdef1234/egress-runtime", nil)
	reqAcc.Header.Set("Authorization", "Bearer test-mgmt")
	recAcc := httptest.NewRecorder()
	mux.ServeHTTP(recAcc, reqAcc)
	if recAcc.Code != http.StatusNotFound {
		t.Fatalf("不存在账号应返回 404，实际 %d body=%s", recAcc.Code, recAcc.Body.String())
	}
}

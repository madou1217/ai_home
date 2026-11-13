package accountactivity

// Qoder / Qoder CN 每日签到执行器（对齐 lib/account/activity-claim/qoder-daily.js）。

import (
	"context"
	"net/http"
	"net/url"
	"os"
	"runtime"
	"strings"
	"time"
)

const (
	qoderDefaultTimeout    = 15 * time.Second
	qoderCampaignsPath     = "/sash/api/v1/me/campaigns"
	qoderCampaignClaimTmpl = "/sash/api/v1/me/campaigns/{campaignId}/claim"
)

var (
	qoderAPIBases = map[string]string{
		"qoder":   "https://openapi.qoder.sh",
		"qodercn": "https://openapi.qoder.com.cn",
	}
	qoderCLIVersions = map[string]string{
		"qoder":   "1.1.73",
		"qodercn": "1.1.72",
	}
)

func buildQoderCampaignHeaders(provider string, record AccountRecord, identity *QoderDeviceIdentity, hostname string) map[string]string {
	version := qoderCLIVersions[provider]
	if version == "" {
		version = "1.1.73"
	}
	arch := runtime.GOARCH
	if arch == "amd64" {
		arch = "x64"
	}
	plat := runtime.GOOS
	if plat == "windows" {
		plat = "win32"
	}
	machineID := textOf(record.NativeAuth["machineId"])
	return map[string]string{
		"Accept":               "application/json",
		"User-Agent":           "Qoder/" + version,
		"Cosy-ClientType":      "10",
		"Cosy-Version":         version,
		"Cosy-MachineOS":       arch + "_" + plat,
		"Cosy-MachineHostname": strings.TrimSpace(hostname),
		"Cosy-MachineId":       machineID,
		"Cosy-MachineToken":    identity.MachineToken,
		"Cosy-MachineCode":     identity.MachineCode,
		"Cosy-MachineType":     identity.MachineType,
	}
}

func summarizeQoderCampaign(raw map[string]any) map[string]any {
	benefit, _ := raw["benefit"].(map[string]any)
	var credits any
	if benefit != nil {
		if _, has := benefit["amount"]; has && benefit["amount"] != nil {
			credits = toFloat64(benefit["amount"])
		}
	}
	var validDays any
	if benefit != nil {
		if validity, ok := benefit["validity"].(map[string]any); ok && validity != nil {
			if _, has := validity["days"]; has && validity["days"] != nil {
				validDays = toFloat64(validity["days"])
			}
		}
	}
	return map[string]any{
		"campaignId":  textOf(raw["campaignId"]),
		"campaignKey": textOf(raw["campaignKey"]),
		"actionType":  textOf(raw["actionType"]),
		"claimStatus": textOf(raw["claimStatus"]),
		"benefitKind": textOf(benefit["kind"]),
		"credits":     credits,
		"validDays":   validDays,
	}
}

func buildQoderClaimPath(campaignID string) string {
	return strings.ReplaceAll(qoderCampaignClaimTmpl, "{campaignId}", url.PathEscape(campaignID))
}

func (e *NativeExecutor) runQoderDailyClaim(
	ctx context.Context,
	request ExecutionRequest,
	record AccountRecord,
) map[string]any {
	provider := strings.ToLower(strings.TrimSpace(request.Provider))
	accountRef := strings.TrimSpace(request.AccountRef)
	timeout := e.timeoutOr(qoderDefaultTimeout)

	result := map[string]any{
		"provider":   provider,
		"accountRef": accountRef,
		"action":     "qoder_daily_checkin",
		"status":     StatusError,
		"claimed":    []any{},
		"campaigns":  []any{},
	}

	base := strings.TrimRight(strings.TrimSpace(e.resolveProviderBaseURL(provider, qoderAPIBases[provider])), "/")
	if base == "" {
		result["error"] = "qoder_api_base_unknown"
		return result
	}

	token, tokenSource := ResolveQoderAccessToken(provider, record, e.options.QoderOptions, e.options.QoderDecrypt)
	if token == "" {
		result["error"] = "qoder_token_missing"
		return result
	}
	result["tokenSource"] = tokenSource

	var identity *QoderDeviceIdentity
	if e.options.QoderIdentityReader != nil {
		identity = e.options.QoderIdentityReader(provider, accountRef)
	} else {
		identity = ReadQoderDeviceIdentity(e.options.AIHomeDir, e.options.HostHomeDir, provider, accountRef)
	}
	machineID := textOf(record.NativeAuth["machineId"])
	if identity == nil || machineID == "" {
		result["error"] = "qoder_device_identity_missing"
		result["message"] = "Run `qoder` once on this host (or login this account) so umid-cache.json exists."
		return result
	}

	client, egressErr := ResolveClaimHTTPClient(
		ctx,
		e.options.AIHomeDir,
		e.options.EgressResolver,
		e.options.HTTPClientForAccount,
		provider,
		accountRef,
		timeout,
	)
	if egressErr != "" {
		result["error"] = egressErr
		return result
	}

	hostname, _ := os.Hostname()
	headers := buildQoderCampaignHeaders(provider, record, identity, hostname)
	headers["Authorization"] = "Bearer " + token

	listURL := base + qoderCampaignsPath + "?forceRefresh=true"
	listResp := FetchClaimJSON(ctx, client, http.MethodGet, listURL, headers, nil, timeout)
	if listResp.Error != "" {
		result["error"] = listResp.Error
		return result
	}
	if listResp.Status == 401 || listResp.Status == 403 {
		result["error"] = "qoder_auth_invalid:" + itoa(listResp.Status)
		result["auth"] = true
		return result
	}
	if !listResp.OK || listResp.JSON == nil {
		result["error"] = "qoder_campaigns_http_" + itoa(listResp.Status)
		result["message"] = ReadEnvelopeMessage(listResp.JSON)
		return result
	}

	rawCampaigns, _ := listResp.JSON["campaigns"].([]any)
	summaries := make([]any, 0, len(rawCampaigns))
	claimable := make([]map[string]any, 0, len(rawCampaigns))
	for _, item := range rawCampaigns {
		rawMap, ok := item.(map[string]any)
		if !ok || rawMap == nil {
			continue
		}
		if textOf(rawMap["actionType"]) != "CLAIM_BENEFIT" {
			continue
		}
		summary := summarizeQoderCampaign(rawMap)
		summaries = append(summaries, summary)
		if textOf(summary["claimStatus"]) == "CLAIMABLE" {
			claimable = append(claimable, summary)
		}
	}
	result["campaigns"] = summaries

	if len(claimable) == 0 {
		if len(summaries) > 0 {
			result["status"] = StatusAlreadyClaimed
		} else {
			result["status"] = StatusNothingClaimable
		}
		return result
	}
	if request.DryRun {
		result["status"] = StatusDryRun
		dryList := make([]any, 0, len(claimable))
		for _, entry := range claimable {
			dryList = append(dryList, entry)
		}
		result["claimable"] = dryList
		return result
	}

	claimedList := make([]any, 0, len(claimable))
	succeededCredits := 0.0
	successCount := 0
	firstFailureMsg := ""

	postHeaders := make(map[string]string, len(headers)+2)
	for k, v := range headers {
		postHeaders[k] = v
	}
	postHeaders["Content-Type"] = "application/json"
	postHeaders["origin"] = base

	for _, entry := range claimable {
		campaignID := textOf(entry["campaignId"])
		claimURL := base + buildQoderClaimPath(campaignID)
		resp := FetchClaimJSON(ctx, client, http.MethodPost, claimURL, postHeaders, []byte("{}"), timeout)
		if resp.Error != "" {
			claimedList = append(claimedList, map[string]any{
				"campaignId": campaignID,
				"ok":         false,
				"error":      resp.Error,
			})
			continue
		}
		explicitFailure := false
		if resp.JSON != nil {
			if succ, has := resp.JSON["success"].(bool); has && !succ {
				explicitFailure = true
			}
			if code, has := readIntEnvelopeCode(resp.JSON); has && code != 0 {
				explicitFailure = true
			}
		}
		if !resp.OK || explicitFailure {
			msg := ReadEnvelopeMessage(resp.JSON)
			if firstFailureMsg == "" && msg != "" {
				firstFailureMsg = msg
			}
			claimedList = append(claimedList, map[string]any{
				"campaignId": campaignID,
				"ok":         false,
				"error":      "qoder_claim_http_" + itoa(resp.Status),
				"message":    msg,
			})
			continue
		}
		successCount++
		succeededCredits += toFloat64(entry["credits"])
		claimedList = append(claimedList, map[string]any{
			"campaignId": campaignID,
			"ok":         true,
			"credits":    entry["credits"],
			"validDays":  entry["validDays"],
		})
	}

	result["claimed"] = claimedList
	if successCount > 0 {
		result["status"] = StatusClaimed
		result["credits"] = succeededCredits
	} else {
		result["status"] = StatusError
		result["error"] = "qoder_claim_failed"
		result["message"] = firstFailureMsg
	}
	return result
}

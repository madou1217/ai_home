package accountactivity

// ZCode「周末活动 / 试用套餐」（Start Plan）领取执行器（对齐 lib/account/activity-claim/zcode-plan.js）。

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"time"
)

const (
	zcodeDefaultBaseURL       = "https://zcode.z.ai"
	zcodePlanPreviewPath      = "/api/v1/zcode-plan/billing/preview"
	zcodeMarketingTouchPath   = "/api/v1/marketing/touch"
	zcodePlanBalancePath      = "/api/v1/zcode-plan/billing/balance"
	zcodePlanClaimPath        = "/api/v1/zcode-plan/billing/claim"
	zcodeClientConfigsPath    = "/api/v1/client/configs"
	zcodeDefaultTimeout       = 20 * time.Second
	zcodeCaptchaFailedCode    = 3007
	zcodeTargetNotFoundCode   = 1001
)

var zcodeAlreadyClaimedRegex = regexp.MustCompile(`(?i)已领取|already\s*claimed`)

func summarizeZcodePlan(raw map[string]any) map[string]any {
	planID := textOf(raw["plan_id"])
	if planID == "" {
		planID = textOf(raw["planId"])
	}
	var startsAt any
	if v, ok := raw["starts_at"]; ok && v != nil {
		startsAt = v
	} else if v, ok := raw["startsAt"]; ok && v != nil {
		startsAt = v
	}
	var endsAt any
	if v, ok := raw["ends_at"]; ok && v != nil {
		endsAt = v
	} else if v, ok := raw["endsAt"]; ok && v != nil {
		endsAt = v
	}
	entitlements := 0
	if list, ok := raw["entitlements"].([]any); ok {
		entitlements = len(list)
	} else if n := int(toFloat64(raw["entitlements"])); n > 0 {
		entitlements = n
	}
	return map[string]any{
		"planId":       planID,
		"name":         textOf(raw["name"]),
		"description":  textOf(raw["description"]),
		"priority":     toFloat64(raw["priority"]),
		"status":       textOf(raw["status"]),
		"startsAt":     startsAt,
		"endsAt":       endsAt,
		"entitlements": entitlements,
	}
}

// CollectMarketingClaimPlans 从营销投放 deliveries 提取 resource_position=banner/popup 的 claim_zcode_plan。
func CollectMarketingClaimPlans(deliveries []any) []map[string]any {
	plans := make([]map[string]any, 0, len(deliveries))
	seenPlanIDs := map[string]struct{}{}
	seenPositions := map[string]struct{}{}
	for _, rawDel := range deliveries {
		entry, ok := rawDel.(map[string]any)
		if !ok || entry == nil {
			continue
		}
		pos := textOf(entry["resource_position"])
		var container map[string]any
		switch pos {
		case "popup":
			container, _ = entry["popup"].(map[string]any)
		case "banner":
			container, _ = entry["banner"].(map[string]any)
		}
		if container == nil {
			continue
		}
		if _, dupPos := seenPositions[pos]; dupPos {
			continue
		}
		seenPositions[pos] = struct{}{}
		buttons, _ := container["buttons"].([]any)
		for _, rawBtn := range buttons {
			btn, ok := rawBtn.(map[string]any)
			if !ok || btn == nil {
				continue
			}
			act, _ := btn["action"].(map[string]any)
			if act == nil || textOf(act["type"]) != "claim_zcode_plan" {
				continue
			}
			args, _ := act["args"].(map[string]any)
			planID := textOf(args["plan_id"])
			if planID == "" {
				continue
			}
			if _, dup := seenPlanIDs[planID]; dup {
				continue
			}
			seenPlanIDs[planID] = struct{}{}
			plans = append(plans, map[string]any{
				"planId":       planID,
				"name":         planID,
				"description":  "",
				"priority":     toFloat64(entry["priority"]),
				"status":       "",
				"startsAt":     nil,
				"endsAt":       nil,
				"entitlements": 0,
				"campaignId":   textOf(entry["campaign_id"]),
				"position":     pos,
				"source":       "marketing_touch",
			})
		}
	}
	return plans
}

func isZcodeBusinessSuccess(payload map[string]any) bool {
	code, ok := readIntEnvelopeCode(payload)
	if !ok {
		return false
	}
	return code == 0 || code == 200
}

type zcodeCaptchaConfig struct {
	Enabled bool
	Prefix  string
	Region  string
	SceneID string
}

func readZcodeCaptchaConfig(payload map[string]any) *zcodeCaptchaConfig {
	if payload == nil {
		return nil
	}
	data, _ := payload["data"].(map[string]any)
	if data == nil {
		return nil
	}
	configs, _ := data["configs"].(map[string]any)
	if configs == nil {
		return nil
	}
	capMap, _ := configs["captcha"].(map[string]any)
	if capMap == nil {
		return nil
	}
	enabled := true
	if b, ok := capMap["enabled"].(bool); ok && !b {
		enabled = false
	}
	return &zcodeCaptchaConfig{
		Enabled: enabled,
		Prefix:  textOf(capMap["prefix"]),
		Region:  firstNonEmptyString(textOf(capMap["region"]), "cn"),
		SceneID: firstMapText(capMap, "sceneId", "scene_id"),
	}
}

func buildZcodeClaimHeaders(
	baseMeta map[string]string,
	jwtToken string,
	appVersion string,
	captchaParam string,
	captchaRegion string,
) map[string]string {
	headers := make(map[string]string, len(baseMeta)+6)
	for k, v := range baseMeta {
		headers[k] = v
	}
	headers["Accept"] = "application/json"
	headers["Authorization"] = "Bearer " + strings.TrimSpace(jwtToken)
	headers["X-ZCode-App-Version"] = strings.TrimSpace(appVersion)
	if p := strings.TrimSpace(captchaParam); p != "" {
		headers["X-Aliyun-Captcha-Verify-Param"] = p
	}
	if r := strings.TrimSpace(captchaRegion); r != "" {
		headers["X-Aliyun-Captcha-Verify-Region"] = r
	}
	return headers
}

func appendQueryParams(endpoint string, kv ...string) string {
	parsed, err := url.Parse(endpoint)
	if err != nil {
		return endpoint
	}
	q := parsed.Query()
	for i := 0; i+1 < len(kv); i += 2 {
		if kv[i+1] != "" {
			q.Set(kv[i], kv[i+1])
		}
	}
	parsed.RawQuery = q.Encode()
	return parsed.String()
}

func (e *NativeExecutor) runZcodePlanClaim(
	ctx context.Context,
	request ExecutionRequest,
	record AccountRecord,
	action Action,
) map[string]any {
	accountRef := strings.TrimSpace(request.AccountRef)
	timeout := e.timeoutOr(zcodeDefaultTimeout)

	result := map[string]any{
		"provider":   "zcode",
		"accountRef": accountRef,
		"action":     "zcode_plan_claim",
		"status":     StatusError,
		"plans":      []any{},
		"claimed":    []any{},
	}

	oauth := ReadZcodeLiveOAuthCredential(e.options.AIHomeDir, accountRef, record)
	if oauth.JWTToken == "" {
		if strings.TrimSpace(record.Env["ZCODE_API_KEY"]) != "" {
			result["status"] = StatusNotApplicable
			return result
		}
		result["error"] = "zcode_jwt_missing"
		return result
	}
	result["credentialSource"] = oauth.Source

	client, egressErr := ResolveClaimHTTPClient(
		ctx,
		e.options.AIHomeDir,
		e.options.EgressResolver,
		e.options.HTTPClientForAccount,
		"zcode",
		accountRef,
		timeout,
	)
	if egressErr != "" {
		result["error"] = egressErr
		return result
	}

	baseURL := strings.TrimRight(firstNonEmptyString(
		e.resolveProviderBaseURL("zcode", ""),
		e.options.ZcodeBaseURL,
		zcodeDefaultBaseURL,
	), "/")

	appVersion, metaHeaders := ResolveZcodeClientMetadata(
		ctx,
		e.options.AIHomeDir,
		e.options.HostHomeDir,
		accountRef,
		e.options.ZcodeAppVersion,
		client,
		e.nowMS(),
		e.options.DisableVersionRefresh || e.options.ZcodeBaseURL != "" || len(e.options.BaseURLs) > 0,
	)
	headers := buildZcodeClaimHeaders(metaHeaders, oauth.JWTToken, appVersion, "", "")
	plat, arch := nodePlatformArch(runtime.GOOS, runtime.GOARCH)

	previewURL := appendQueryParams(baseURL+zcodePlanPreviewPath, "app_version", appVersion, "platform", plat+"-"+arch)
	previewResp := FetchClaimJSON(ctx, client, http.MethodGet, previewURL, headers, nil, timeout)
	if previewResp.Status == 401 || previewResp.Status == 403 {
		result["error"] = "zcode_auth_invalid:" + itoa(previewResp.Status)
		result["auth"] = true
		return result
	}

	type zcodeFailure struct {
		err     string
		code    any
		message string
	}
	var previewPlans []map[string]any
	var previewFail *zcodeFailure
	if previewResp.Error != "" {
		previewFail = &zcodeFailure{err: previewResp.Error}
	} else if !previewResp.OK || previewResp.JSON == nil || !isZcodeBusinessSuccess(previewResp.JSON) {
		var codeVal any
		if previewResp.JSON != nil {
			codeVal = previewResp.JSON["code"]
		}
		previewFail = &zcodeFailure{
			err:     "zcode_preview_failed:" + itoa(previewResp.Status),
			code:    codeVal,
			message: ReadEnvelopeMessage(previewResp.JSON),
		}
	} else if previewData, ok := previewResp.JSON["data"].(map[string]any); ok && previewData != nil {
		if rawPlans, ok := previewData["plans"].([]any); ok {
			for _, item := range rawPlans {
				if m, ok := item.(map[string]any); ok && m != nil {
					previewPlans = append(previewPlans, m)
				}
			}
		}
	} else {
		previewFail = &zcodeFailure{
			err:     "zcode_preview_missing_data",
			code:    previewResp.JSON["code"],
			message: ReadEnvelopeMessage(previewResp.JSON),
		}
	}

	plans := previewPlans
	result["discovery"] = "preview"
	if len(plans) == 0 {
		touchURL := appendQueryParams(baseURL+zcodeMarketingTouchPath, "seq", "0")
		touchResp := FetchClaimJSON(ctx, client, http.MethodGet, touchURL, headers, nil, timeout)
		touchMeta := map[string]any{"deliveries": 0, "claimable": 0}
		if touchResp.Error != "" {
			touchMeta["error"] = touchResp.Error
		} else if !touchResp.OK || touchResp.JSON == nil {
			touchMeta["error"] = "zcode_marketing_touch_failed:" + itoa(touchResp.Status)
		} else {
			dataMap, _ := touchResp.JSON["data"].(map[string]any)
			deliveries, _ := dataMap["deliveries"].([]any)
			touchPlans := CollectMarketingClaimPlans(deliveries)
			touchMeta["deliveries"] = len(deliveries)
			touchMeta["claimable"] = len(touchPlans)
			if len(touchPlans) > 0 {
				plans = touchPlans
				result["discovery"] = "marketing_touch"
			}
		}
		result["marketingTouch"] = touchMeta
	}

	kinds := action.Kinds
	wantedKind := ""
	if request.Params != nil {
		wantedKind = textOf(request.Params["planKind"])
	}

	type classifiedPlan struct {
		summary map[string]any
		kind    string
	}
	classifyList := func(raw []map[string]any) ([]classifiedPlan, []any, []map[string]any) {
		classified := make([]classifiedPlan, 0, len(raw))
		listAny := make([]any, 0, len(raw))
		listMaps := make([]map[string]any, 0, len(raw))
		for _, item := range raw {
			summary := summarizeZcodePlan(item)
			kind := ClassifyPlan(summary, kinds)
			if kind != "" {
				summary["planKind"] = kind
			}
			classified = append(classified, classifiedPlan{summary: summary, kind: kind})
			listAny = append(listAny, summary)
			listMaps = append(listMaps, summary)
		}
		return classified, listAny, listMaps
	}

	classified, plansAny, plansMaps := classifyList(plans)
	result["plans"] = plansAny
	if len(kinds) > 0 {
		available := DescribeKinds(kinds, plansMaps, true)
		availableAny := make([]any, 0, len(available))
		for _, entry := range available {
			availableAny = append(availableAny, entry)
		}
		result["availableKinds"] = availableAny
	}

	if len(plans) == 0 {
		balURL := appendQueryParams(baseURL+zcodePlanBalancePath, "app_version", appVersion)
		balResp := FetchClaimJSON(ctx, client, http.MethodGet, balURL, headers, nil, timeout)
		balOK := false
		balErr := ""
		var balRaw []map[string]any
		if balResp.Error != "" {
			balErr = balResp.Error
		} else if !balResp.OK || balResp.JSON == nil || !isZcodeBusinessSuccess(balResp.JSON) {
			balErr = "zcode_balance_failed:" + itoa(balResp.Status)
		} else {
			balOK = true
			if dataMap, ok := balResp.JSON["data"].(map[string]any); ok && dataMap != nil {
				if rawHeld, ok := dataMap["plans"].([]any); ok {
					for _, item := range rawHeld {
						if m, ok := item.(map[string]any); ok && m != nil {
							balRaw = append(balRaw, m)
						}
					}
				}
			}
		}
		held, heldAny, _ := classifyList(balRaw)
		balMeta := map[string]any{"ok": balOK, "plans": len(held)}
		if balErr != "" {
			balMeta["error"] = balErr
		}
		result["balance"] = balMeta

		if len(held) > 0 {
			result["heldPlans"] = heldAny
			heldForKind := make([]classifiedPlan, 0, len(held))
			for _, item := range held {
				if wantedKind == "" || item.kind == wantedKind {
					heldForKind = append(heldForKind, item)
				}
			}
			if len(heldForKind) > 0 {
				result["status"] = StatusAlreadyClaimed
				result["planKind"] = firstNonEmptyString(heldForKind[0].kind, wantedKind)
				result["plan"] = heldForKind[0].summary
				return result
			}
			result["status"] = StatusNothingClaimable
			result["planKind"] = wantedKind
			if wantedKind != "" {
				result["reason"] = "plan_kind_unavailable:" + wantedKind
			}
			return result
		}
		if balOK {
			result["status"] = StatusNothingClaimable
			return result
		}
		if previewFail != nil && previewFail.err != "zcode_preview_missing_data" {
			result["error"] = previewFail.err
			if previewFail.code != nil {
				result["code"] = previewFail.code
			}
			result["message"] = previewFail.message
			return result
		}
		result["error"] = firstNonEmptyString(balErr, "zcode_balance_unavailable")
		return result
	}

	if request.DryRun {
		result["status"] = StatusDryRun
		return result
	}

	candidates := make([]classifiedPlan, 0, len(classified))
	for _, item := range classified {
		if wantedKind == "" || item.kind == wantedKind {
			candidates = append(candidates, item)
		}
	}
	if len(candidates) == 0 {
		result["status"] = StatusNothingClaimable
		result["planKind"] = wantedKind
		result["reason"] = "plan_kind_unavailable:" + wantedKind
		return result
	}
	sort.SliceStable(candidates, func(i, j int) bool {
		return toFloat64(candidates[i].summary["priority"]) > toFloat64(candidates[j].summary["priority"])
	})
	chosen := candidates[0].summary
	if pk := textOf(chosen["planKind"]); pk != "" {
		result["planKind"] = pk
	}
	planID := textOf(chosen["planId"])
	if planID == "" {
		result["error"] = "zcode_plan_id_missing"
		return result
	}

	postClaim := func(captchaParam, captchaRegion string) ClaimHTTPResponse {
		claimHeaders := buildZcodeClaimHeaders(metaHeaders, oauth.JWTToken, appVersion, captchaParam, captchaRegion)
		claimHeaders["Content-Type"] = "application/json"
		claimBody, _ := json.Marshal(map[string]string{"plan_id": planID})
		return FetchClaimJSON(ctx, client, http.MethodPost, baseURL+zcodePlanClaimPath, claimHeaders, claimBody, timeout)
	}

	claimResp := postClaim("", "")
	if claimResp.Error == "" {
		if code, ok := readIntEnvelopeCode(claimResp.JSON); ok && code == zcodeCaptchaFailedCode {
			param, region, solveErr := e.solveZcodeCaptchaForClaim(ctx, client, baseURL, headers, timeout)
			if param != "" {
				result["captcha"] = "solved"
				claimResp = postClaim(param, region)
			} else {
				result["captcha"] = "unavailable"
				result["captchaError"] = solveErr
			}
		}
	}
	if claimResp.Error != "" {
		result["error"] = claimResp.Error
		return result
	}

	bizCode, hasBizCode := readIntEnvelopeCode(claimResp.JSON)
	if !claimResp.OK || !isZcodeBusinessSuccess(claimResp.JSON) {
		if hasBizCode {
			result["code"] = bizCode
		} else {
			result["code"] = nil
		}
		msg := ReadEnvelopeMessage(claimResp.JSON)
		result["message"] = msg
		switch bizCode {
		case zcodeCaptchaFailedCode:
			result["error"] = "zcode_captcha_rejected"
		case zcodeTargetNotFoundCode:
			result["error"] = "zcode_plan_not_found"
		default:
			result["error"] = "zcode_claim_failed:" + itoa(claimResp.Status)
		}
		if msg != "" && zcodeAlreadyClaimedRegex.MatchString(msg) {
			result["status"] = StatusAlreadyClaimed
			delete(result, "error")
		}
		return result
	}

	result["status"] = StatusClaimed
	result["claimed"] = []any{chosen}
	result["plan"] = chosen
	return result
}

func (e *NativeExecutor) solveZcodeCaptchaForClaim(
	ctx context.Context,
	client HTTPDoer,
	baseURL string,
	headers map[string]string,
	timeout time.Duration,
) (param, region, errCode string) {
	cfgResp := FetchClaimJSON(ctx, client, http.MethodGet, baseURL+zcodeClientConfigsPath, headers, nil, timeout)
	if cfgResp.Error != "" {
		return "", "", "zcode_captcha_config_unavailable:" + cfgResp.Error
	}
	if !cfgResp.OK || cfgResp.JSON == nil {
		return "", "", "zcode_captcha_config_unavailable:" + itoa(cfgResp.Status)
	}
	captcha := readZcodeCaptchaConfig(cfgResp.JSON)
	if captcha == nil {
		return "", "", "zcode_captcha_config_unavailable:missing_captcha"
	}
	if !captcha.Enabled {
		return "", "", "zcode_captcha_disabled_by_upstream"
	}
	if captcha.SceneID == "" || captcha.Prefix == "" {
		return "", "", "zcode_captcha_config_unavailable:incomplete_captcha"
	}

	solveTimeout := timeout
	if solveTimeout < captchaDefaultTimeout {
		solveTimeout = captchaDefaultTimeout
	}
	req := CaptchaSolveRequest{
		SceneID:        captcha.SceneID,
		Prefix:         captcha.Prefix,
		Region:         captcha.Region,
		ExecutablePath: e.options.CaptchaBrowserPath,
		HostHomeDir:    e.options.HostHomeDir,
		Timeout:        solveTimeout,
	}
	var solved string
	var solveErr error
	if e.options.CaptchaSolver != nil {
		solved, solveErr = e.options.CaptchaSolver(ctx, req)
	} else {
		solved, solveErr = SolveAliyunCaptchaWithRetry(ctx, req, e.options.CaptchaSolveGate)
	}
	if solveErr != nil {
		return "", "", "zcode_captcha_solve_failed:" + errorMessageOrUnknown(solveErr)
	}
	solved = strings.TrimSpace(solved)
	if solved == "" {
		return "", "", "zcode_captcha_solve_failed:empty_param"
	}
	return solved, captcha.Region, ""
}

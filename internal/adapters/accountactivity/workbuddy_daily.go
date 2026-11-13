package accountactivity

// WorkBuddy / CodeBuddy 每日签到执行器（对齐 lib/account/activity-claim/workbuddy-daily.js）。

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const (
	workbuddyDefaultTimeout      = 15 * time.Second
	workbuddyCheckinStatusPath   = "/v2/billing/meter/checkin-activity-status"
	workbuddyDailyCheckinPath    = "/v2/billing/meter/daily-checkin"
	codebuddyProbeUserAgent      = "CodeBuddy/1.0 (ai-home)"
)

type checkinBizStatus struct {
	status  string
	message string
}

var workbuddyBizStatuses = map[int]checkinBizStatus{
	1001: {status: StatusAlreadyClaimed, message: "今天已经签到过了"},
	1002: {status: StatusNothingClaimable, message: "账号不符合签到条件"},
	1003: {status: StatusNothingClaimable, message: "签到活动已结束"},
}

type workbuddyCheckinState struct {
	active          bool
	todayCheckedIn  bool
	streakDays      float64
	dailyCredit     float64
	todayCredit     float64
	isStreakDay     bool
	totalCredits    float64
	activityName    string
	themeName       string
	startTime       string
	endTime         string
	claimButtonText string
	checkinDates    []any
}

func readWorkbuddyCheckinState(payload map[string]any) workbuddyCheckinState {
	data, _ := payload["data"].(map[string]any)
	if data == nil {
		data = map[string]any{}
	}
	datesRaw, _ := data["checkin_dates"].([]any)
	dates := make([]any, 0, len(datesRaw))
	for _, item := range datesRaw {
		if s, ok := item.(string); ok {
			dates = append(dates, s)
		}
	}
	active, _ := data["active"].(bool)
	todayCheckedIn, _ := data["today_checked_in"].(bool)
	isStreakDay, _ := data["is_streak_day"].(bool)
	return workbuddyCheckinState{
		active:          active,
		todayCheckedIn:  todayCheckedIn,
		streakDays:      toFloat64(data["streak_days"]),
		dailyCredit:     toFloat64(data["daily_credit"]),
		todayCredit:     toFloat64(data["today_credit"]),
		isStreakDay:     isStreakDay,
		totalCredits:    toFloat64(data["total_credits"]),
		activityName:    textOf(data["activity_name"]),
		themeName:       textOf(data["theme_name"]),
		startTime:       textOf(data["start_time"]),
		endTime:         textOf(data["end_time"]),
		claimButtonText: textOf(data["claim_button_text"]),
		checkinDates:    dates,
	}
}

func buildWorkbuddyCheckinHeaders(credential *CodebuddySharedCredential, record AccountRecord) map[string]string {
	headers := map[string]string{
		"Accept":        "application/json",
		"Authorization": "Bearer " + strings.TrimSpace(credential.AccessToken),
		"Content-Type":  "application/json",
		"X-User-Id":     strings.TrimSpace(credential.UID),
		"User-Agent":    codebuddyProbeUserAgent,
	}
	if dom := strings.TrimSpace(credential.Domain); dom != "" {
		headers["X-Domain"] = dom
	}
	entID := strings.TrimSpace(credential.EnterpriseID)
	if entID == "" {
		if credMap := unwrapCodebuddyCredMap(record.NativeAuth); credMap != nil {
			if acct, ok := credMap["account"].(map[string]any); ok && acct != nil {
				entID = firstMapText(acct, "enterpriseId", "enterprise_id")
			}
		}
	}
	if entID != "" {
		headers["X-Enterprise-Id"] = entID
		headers["X-Tenant-Id"] = entID
	}
	return headers
}

func (e *NativeExecutor) runWorkbuddyDailyClaim(
	ctx context.Context,
	request ExecutionRequest,
	record AccountRecord,
) map[string]any {
	provider := strings.ToLower(strings.TrimSpace(request.Provider))
	accountRef := strings.TrimSpace(request.AccountRef)
	timeout := e.timeoutOr(workbuddyDefaultTimeout)

	result := map[string]any{
		"provider":   provider,
		"accountRef": accountRef,
		"action":     "workbuddy_daily_checkin",
		"status":     StatusError,
	}

	defaultEndpoint, valid := codebuddyBillingEndpoints[provider]
	if !valid {
		result["error"] = "workbuddy_provider_unsupported:" + firstNonEmptyString(provider, "unknown")
		return result
	}
	endpoint := strings.TrimRight(strings.TrimSpace(e.resolveProviderBaseURL(provider, defaultEndpoint)), "/")
	if endpoint == "" {
		result["error"] = "workbuddy_endpoint_unresolved"
		return result
	}

	cred := ReadCodebuddySharedCredential(
		e.options.AIHomeDir,
		e.options.HostHomeDir,
		provider,
		accountRef,
		record,
		e.nowMS(),
		e.options.WorkbuddyCodecDecode,
	)
	if cred == nil {
		result["error"] = "workbuddy_credential_missing"
		result["auth"] = true
		return result
	}
	if cred.AccessToken == "" {
		result["error"] = "workbuddy_token_missing"
		result["auth"] = true
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

	headers := buildWorkbuddyCheckinHeaders(cred, record)
	statusResp := FetchClaimJSON(ctx, client, http.MethodPost, endpoint+workbuddyCheckinStatusPath, headers, []byte("{}"), timeout)
	if statusResp.Error != "" {
		result["error"] = statusResp.Error
		return result
	}
	if statusResp.Status == 401 || statusResp.Status == 403 {
		result["error"] = "workbuddy_auth_invalid:" + itoa(statusResp.Status)
		result["auth"] = true
		return result
	}
	statusCode, hasStatusCode := readIntEnvelopeCode(statusResp.JSON)
	if !statusResp.OK || !hasStatusCode || statusCode != 0 {
		result["error"] = "workbuddy_checkin_status_failed:" + itoa(statusResp.Status)
		result["message"] = ReadEnvelopeMessage(statusResp.JSON)
		return result
	}

	state := readWorkbuddyCheckinState(statusResp.JSON)
	result["activity"] = map[string]any{
		"name":         state.activityName,
		"theme":        state.themeName,
		"dailyCredit":  state.dailyCredit,
		"streakDays":   state.streakDays,
		"totalCredits": state.totalCredits,
		"startTime":    state.startTime,
		"endTime":      state.endTime,
		"checkinDates": state.checkinDates,
	}

	if !state.active {
		result["status"] = StatusNothingClaimable
		result["message"] = "签到活动未开启"
		return result
	}
	if state.todayCheckedIn {
		result["status"] = StatusAlreadyClaimed
		result["message"] = "今天已经签到过了"
		result["streakDays"] = state.streakDays
		return result
	}
	if request.DryRun {
		result["status"] = StatusDryRun
		name := state.activityName
		if name == "" {
			name = "每日签到"
		}
		result["claimable"] = []any{
			map[string]any{
				"name":       name,
				"credits":    state.dailyCredit,
				"streakDays": state.streakDays,
			},
		}
		return result
	}

	claimResp := FetchClaimJSON(ctx, client, http.MethodPost, endpoint+workbuddyDailyCheckinPath, headers, []byte("{}"), timeout)
	if claimResp.Error != "" {
		result["error"] = claimResp.Error
		return result
	}
	if claimResp.Status == 401 || claimResp.Status == 403 {
		result["error"] = "workbuddy_auth_invalid:" + itoa(claimResp.Status)
		result["auth"] = true
		return result
	}

	claimCode, hasClaimCode := readIntEnvelopeCode(claimResp.JSON)
	if !claimResp.OK || !hasClaimCode {
		result["error"] = "workbuddy_checkin_http_" + itoa(claimResp.Status)
		result["message"] = ReadEnvelopeMessage(claimResp.JSON)
		return result
	}
	if claimCode != 0 {
		if mapped, ok := workbuddyBizStatuses[claimCode]; ok {
			result["status"] = mapped.status
			msg := ReadEnvelopeMessage(claimResp.JSON)
			if msg == "" {
				msg = mapped.message
			}
			result["message"] = msg
			return result
		}
		result["error"] = "workbuddy_checkin_biz_" + itoa(claimCode)
		result["message"] = ReadEnvelopeMessage(claimResp.JSON)
		return result
	}

	claimedData, _ := claimResp.JSON["data"].(map[string]any)
	if claimedData == nil {
		claimedData = claimResp.JSON
	}
	credits := toFloat64(claimedData["credit"])
	if credits == 0 {
		credits = state.dailyCredit
	}
	streakDays := toFloat64(claimedData["streak_days"])
	if streakDays == 0 {
		streakDays = state.streakDays
	}
	isStreakDay, _ := claimedData["is_streak_day"].(bool)

	result["status"] = StatusClaimed
	result["credits"] = credits
	result["streakDays"] = streakDays
	result["isStreakDay"] = isStreakDay
	return result
}

func readIntEnvelopeCode(payload map[string]any) (int, bool) {
	if payload == nil {
		return 0, false
	}
	raw, has := payload["code"]
	if !has || raw == nil {
		return 0, false
	}
	switch v := raw.(type) {
	case float64:
		return int(v), true
	case float32:
		return int(v), true
	case int:
		return v, true
	case int64:
		return int(v), true
	case json.Number:
		if i, err := v.Int64(); err == nil {
			return int(i), true
		}
		if f, err := v.Float64(); err == nil {
			return int(f), true
		}
		return 0, false
	case string:
		s := strings.TrimSpace(v)
		if s == "" {
			return 0, false
		}
		if f, err := strconv.ParseFloat(s, 64); err == nil {
			return int(f), true
		}
		return 0, false
	default:
		return 0, false
	}
}

package accounts

import (
	"errors"
	"reflect"
	"testing"
	"time"
)

// 这些用例逐条对照 Node 的行为：
//   - lib/account/state-service.js（recordRuntimeState / recordRuntimeFailure /
//     recordRuntimeSuccess / clearRuntimeBlock 的分支顺序与证据白名单）；
//   - lib/server/account-runtime-state.js（归一化、清除与派生优先级）；
//   - lib/account/quota-runtime-recovery.js（codex 额度快照恢复）；
//   - lib/account/agy-auth-recovery.js（agy 不可恢复认证失效）。
//
// Node 的时间一律是毫秒整数，这里用同样的毫秒值构造 time.Time，期望值可以直接与
// Node 测试里的数字对照。不要「改良」断言：Node 有些行为看起来不直观（例如
// verified_usage_success 带一份不可信快照时什么都不清），但那是并行比对的基准。

func statusMS(value int64) time.Time {
	return time.UnixMilli(value).UTC()
}

func statusPercent(value float64) *float64 {
	return &value
}

func statusTestPolicy(provider string) StatusPolicy {
	return StatusPolicy{Provider: provider, BlockRecheckInterval: 30 * time.Second}
}

func statusTestBlock(kind, reason string, observedAt, until int64) *StatusRoutingBlock {
	block := &StatusRoutingBlock{Kind: kind, Reason: reason, ObservedAt: statusMS(observedAt)}
	if until > 0 {
		block.Until = statusMS(until)
	}
	return block
}

func statusTestStreak(kind string, count int, expiresAt, observedAt int64) StatusModelFailureStreak {
	streak := StatusModelFailureStreak{
		Kind:      kind,
		Count:     count,
		ExpiresAt: statusMS(expiresAt),
		Reason:    kind,
	}
	if observedAt > 0 {
		streak.ObservedAt = statusMS(observedAt)
	}
	return streak
}

func codexAvailableSnapshot(capturedAt int64) *StatusUsageSnapshot {
	return &StatusUsageSnapshot{
		SchemaVersion: 2,
		Kind:          "codex_oauth_status",
		Source:        "codex_app_server",
		CapturedAt:    statusMS(capturedAt),
		Entries:       []StatusUsageEntry{{RemainingPct: statusPercent(42)}},
	}
}

func requireStatusState(t *testing.T, got, want StatusState) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("state mismatch\n got: %#v\nwant: %#v", got, want)
	}
}

func TestApplyStatusEventRejectsInvalidInput(t *testing.T) {
	t.Parallel()
	at := statusMS(10_000)
	cases := []struct {
		name    string
		event   StatusEvent
		policy  StatusPolicy
		wantErr error
	}{
		{
			name:    "empty provider",
			event:   StatusEvent{Kind: StatusEventLoginSuccess, At: at},
			policy:  StatusPolicy{Provider: "  "},
			wantErr: ErrInvalidStatusEvent,
		},
		{
			name:    "zero event time",
			event:   StatusEvent{Kind: StatusEventLoginSuccess},
			policy:  statusTestPolicy("codex"),
			wantErr: ErrInvalidStatusEvent,
		},
		{
			name:    "unknown event kind",
			event:   StatusEvent{Kind: StatusEventKind("made_up"), At: at},
			policy:  statusTestPolicy("codex"),
			wantErr: ErrUnknownStatusEventKind,
		},
		{
			name:    "failure event without payload",
			event:   StatusEvent{Kind: StatusEventRuntimeFailure, At: at},
			policy:  statusTestPolicy("codex"),
			wantErr: ErrInvalidStatusEvent,
		},
		{
			name: "failure event with negative cooldown",
			event: StatusEvent{Kind: StatusEventRuntimeFailure, At: at, Failure: &StatusFailure{
				Kind: "rate_limited", Cooldown: -time.Second,
			}},
			policy:  statusTestPolicy("codex"),
			wantErr: ErrInvalidStatusEvent,
		},
	}
	for _, testCase := range cases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			_, err := ApplyStatusEvent(StatusState{}, testCase.event, testCase.policy)
			if !errors.Is(err, testCase.wantErr) {
				t.Fatalf("error = %v, want %v", err, testCase.wantErr)
			}
		})
	}
}

func TestApplyStatusEventWithoutRuntimeStateIsNoop(t *testing.T) {
	t.Parallel()
	// state-service-runtime-funnel.test.js: 本地没有运行态时，清除证据只要求服务端清残留，
	// 不会凭空造出一份运行态文档。
	for _, kind := range []StatusEventKind{
		StatusEventLoginSuccess,
		StatusEventUpstreamSuccess,
		StatusEventManualAdminClear,
		StatusEventAgyUsageProbeVerified,
	} {
		kind := kind
		t.Run(string(kind), func(t *testing.T) {
			t.Parallel()
			got, err := ApplyStatusEvent(
				StatusState{},
				StatusEvent{Kind: kind, At: statusMS(10_000)},
				statusTestPolicy("codex"),
			)
			if err != nil {
				t.Fatalf("ApplyStatusEvent() error = %v", err)
			}
			requireStatusState(t, got, StatusState{})
		})
	}
}

func TestApplyStatusEventDefaultClear(t *testing.T) {
	t.Parallel()
	// 通用证据（非 codex/agy 特例）清掉账号级阻塞，但保留按模型的冷却与连败；
	// 没有按模型状态时 Node 返回 null，对应零值。
	base := StatusState{
		CooldownUntil:           statusMS(50_000),
		ConsecutiveFailures:     3,
		SuccessCount:            2,
		FailCount:               4,
		LastError:               "boom",
		LastFailureKind:         "rate_limited",
		LastFailureReason:       "429",
		LastFailureAt:           statusMS(20_000),
		LastSuccessAt:           statusMS(10_000),
		RateLimitUntil:          statusMS(50_000),
		AuthInvalidUntil:        statusMS(60_000),
		OverloadUntil:           statusMS(70_000),
		NetworkUntil:            statusMS(80_000),
		ServiceUnavailableUntil: statusMS(90_000),
		UpstreamErrorUntil:      statusMS(100_000),
	}
	cases := []struct {
		name  string
		state StatusState
		kind  StatusEventKind
		want  StatusState
	}{
		{
			name:  "login success wipes the whole document when nothing model-scoped remains",
			state: base,
			kind:  StatusEventLoginSuccess,
			want:  StatusState{},
		},
		{
			name: "model cooldowns keep the document and the counters",
			state: func() StatusState {
				state := base
				state.ModelCooldowns = map[string]time.Time{"gpt-5": statusMS(90_000)}
				return state
			}(),
			kind: StatusEventLoginSuccess,
			want: StatusState{
				SuccessCount:   2,
				FailCount:      4,
				LastSuccessAt:  statusMS(10_000),
				ModelCooldowns: map[string]time.Time{"gpt-5": statusMS(90_000)},
			},
		},
		{
			name: "expired model cooldown and its ordinary streak are pruned",
			state: func() StatusState {
				return StatusState{
					SuccessCount:        2,
					ModelCooldowns:      map[string]time.Time{"gpt-5": statusMS(30_000)},
					ModelFailureStreaks: map[string]StatusModelFailureStreak{"gpt-5": statusTestStreak("rate_limited", 2, 40_000, 20_000)},
				}
			}(),
			kind: StatusEventLoginSuccess,
			want: StatusState{},
		},
		{
			name: "capacity backoff streak survives its own cooldown expiry",
			state: StatusState{
				ModelCooldowns: map[string]time.Time{"gpt-5": statusMS(30_000)},
				ModelFailureStreaks: map[string]StatusModelFailureStreak{
					"gpt-5": statusTestStreak(statusModelCapacityUnavailableKind, 3, 90_000, 20_000),
				},
			},
			kind: StatusEventLoginSuccess,
			want: StatusState{
				ModelFailureStreaks: map[string]StatusModelFailureStreak{
					"gpt-5": statusTestStreak(statusModelCapacityUnavailableKind, 3, 90_000, 20_000),
				},
			},
		},
	}
	for _, testCase := range cases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			got, err := ApplyStatusEvent(
				testCase.state,
				StatusEvent{Kind: testCase.kind, At: statusMS(60_000)},
				statusTestPolicy("claude"),
			)
			if err != nil {
				t.Fatalf("ApplyStatusEvent() error = %v", err)
			}
			requireStatusState(t, got, testCase.want)
		})
	}
}

func TestApplyStatusEventRoutingBlockGate(t *testing.T) {
	t.Parallel()
	policy := statusTestPolicy("codex")
	active := StatusState{
		LastFailureKind:   statusBlockQuotaExhausted,
		LastFailureReason: "quota",
		LastFailureAt:     statusMS(20_000),
		RoutingBlock:      statusTestBlock(statusBlockQuotaExhausted, "quota", 20_000, 90_000),
	}
	t.Run("active block ignores ordinary success evidence", func(t *testing.T) {
		t.Parallel()
		got, err := ApplyStatusEvent(active, StatusEvent{Kind: StatusEventUpstreamSuccess, At: statusMS(60_000)}, policy)
		if err != nil {
			t.Fatalf("ApplyStatusEvent() error = %v", err)
		}
		requireStatusState(t, got, active)
	})
	t.Run("only real traffic success clears an expired block", func(t *testing.T) {
		t.Parallel()
		state := active
		state.RoutingBlock = statusTestBlock(statusBlockQuotaExhausted, "quota", 20_000, 50_000)
		got, err := ApplyStatusEvent(state, StatusEvent{Kind: StatusEventUpstreamSuccess, At: statusMS(60_000)}, policy)
		if err != nil {
			t.Fatalf("ApplyStatusEvent() error = %v", err)
		}
		requireStatusState(t, got, StatusState{})
	})
	t.Run("native session success also clears an expired block", func(t *testing.T) {
		t.Parallel()
		state := active
		state.RoutingBlock = statusTestBlock(statusBlockQuotaExhausted, "quota", 20_000, 50_000)
		got, err := ApplyStatusEvent(state, StatusEvent{Kind: StatusEventNativeSessionSuccess, At: statusMS(60_000)}, policy)
		if err != nil {
			t.Fatalf("ApplyStatusEvent() error = %v", err)
		}
		requireStatusState(t, got, StatusState{})
	})
	t.Run("credential evidence clears buckets but keeps the expired block", func(t *testing.T) {
		t.Parallel()
		state := active
		state.CooldownUntil = statusMS(50_000)
		state.RateLimitUntil = statusMS(50_000)
		state.RoutingBlock = statusTestBlock(statusBlockQuotaExhausted, "quota", 20_000, 50_000)
		got, err := ApplyStatusEvent(state, StatusEvent{Kind: StatusEventTokenRefreshSuccess, At: statusMS(60_000)}, policy)
		if err != nil {
			t.Fatalf("ApplyStatusEvent() error = %v", err)
		}
		requireStatusState(t, got, StatusState{
			RoutingBlock: statusTestBlock(statusBlockQuotaExhausted, "quota", 20_000, 50_000),
		})
	})
	t.Run("manual recheck block never expires", func(t *testing.T) {
		t.Parallel()
		state := StatusState{
			LastFailureAt: statusMS(20_000),
			RoutingBlock: &StatusRoutingBlock{
				Kind: statusBlockPermissionDenied, Reason: "risk control", ObservedAt: statusMS(20_000), RecheckManual: true,
			},
		}
		got, err := ApplyStatusEvent(state, StatusEvent{Kind: StatusEventUpstreamSuccess, At: statusMS(600_000)}, policy)
		if err != nil {
			t.Fatalf("ApplyStatusEvent() error = %v", err)
		}
		requireStatusState(t, got, state)
	})
}

func TestApplyStatusEventManualClear(t *testing.T) {
	t.Parallel()
	policy := statusTestPolicy("codex")
	blocked := StatusState{
		CooldownUntil:       statusMS(90_000),
		ConsecutiveFailures: 2,
		SuccessCount:        1,
		LastError:           "quota_exhausted",
		LastFailureKind:     statusBlockQuotaExhausted,
		LastFailureReason:   "quota",
		LastFailureAt:       statusMS(20_000),
		LastSuccessAt:       statusMS(10_000),
		RateLimitUntil:      statusMS(70_000),
		OverloadUntil:       statusMS(80_000),
		RoutingBlock:        statusTestBlock(statusBlockQuotaExhausted, "quota", 20_000, 90_000),
		ModelCooldowns:      map[string]time.Time{"gpt-5": statusMS(90_000)},
	}
	cases := []struct {
		name  string
		state StatusState
		scope StatusClearScope
		want  StatusState
	}{
		{
			name:  "routing block scope keeps typed buckets and model state",
			state: blocked,
			scope: StatusClearRoutingBlock,
			want: StatusState{
				CooldownUntil:  statusMS(80_000),
				SuccessCount:   1,
				LastSuccessAt:  statusMS(10_000),
				RateLimitUntil: statusMS(70_000),
				OverloadUntil:  statusMS(80_000),
				ModelCooldowns: map[string]time.Time{"gpt-5": statusMS(90_000)},
			},
		},
		{
			name: "routing block scope leaves an unrelated last failure alone",
			state: func() StatusState {
				state := blocked
				state.LastFailureKind = "rate_limited"
				return state
			}(),
			scope: StatusClearRoutingBlock,
			want: StatusState{
				CooldownUntil:       statusMS(90_000),
				ConsecutiveFailures: 2,
				SuccessCount:        1,
				LastError:           "quota_exhausted",
				LastFailureKind:     "rate_limited",
				LastFailureReason:   "quota",
				LastFailureAt:       statusMS(20_000),
				LastSuccessAt:       statusMS(10_000),
				RateLimitUntil:      statusMS(70_000),
				OverloadUntil:       statusMS(80_000),
				ModelCooldowns:      map[string]time.Time{"gpt-5": statusMS(90_000)},
			},
		},
		{
			name:  "routing block scope without a block is a no-op",
			state: StatusState{LastFailureKind: "rate_limited", RateLimitUntil: statusMS(70_000)},
			scope: StatusClearRoutingBlock,
			want:  StatusState{LastFailureKind: "rate_limited", RateLimitUntil: statusMS(70_000)},
		},
		{
			name:  "full clear keeps model cooldowns",
			state: blocked,
			want: StatusState{
				SuccessCount:   1,
				LastSuccessAt:  statusMS(10_000),
				ModelCooldowns: map[string]time.Time{"gpt-5": statusMS(90_000)},
			},
		},
		{
			name: "full clear on typed buckets only drops the document",
			state: StatusState{
				CooldownUntil:  statusMS(90_000),
				RateLimitUntil: statusMS(90_000),
			},
			want: StatusState{},
		},
	}
	for _, testCase := range cases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			got, err := ApplyStatusEvent(
				testCase.state,
				StatusEvent{Kind: StatusEventManualAdminClear, At: statusMS(60_000), Scope: testCase.scope},
				policy,
			)
			if err != nil {
				t.Fatalf("ApplyStatusEvent() error = %v", err)
			}
			requireStatusState(t, got, testCase.want)
		})
	}
}

func TestApplyStatusEventCodexCredentialEvidence(t *testing.T) {
	t.Parallel()
	authInvalid := StatusState{
		CooldownUntil:       statusMS(90_000),
		ConsecutiveFailures: 3,
		LastError:           "auth_invalid_reauth_required",
		LastFailureKind:     "auth_invalid",
		LastFailureReason:   "auth_invalid_reauth_required",
		LastFailureAt:       statusMS(20_000),
		AuthInvalidUntil:    statusMS(90_000),
		RateLimitUntil:      statusMS(70_000),
	}
	cases := []struct {
		name     string
		provider string
		state    StatusState
		kind     StatusEventKind
		want     StatusState
	}{
		{
			name:     "credential update lifts auth_invalid and keeps the concurrent rate limit",
			provider: "codex",
			state:    authInvalid,
			kind:     StatusEventCredentialUpdateAfterFailure,
			want: StatusState{
				CooldownUntil:  statusMS(70_000),
				RateLimitUntil: statusMS(70_000),
			},
		},
		{
			name:     "still-valid access token takes the same path",
			provider: "codex",
			state:    authInvalid,
			kind:     StatusEventAccessTokenStillValid,
			want: StatusState{
				CooldownUntil:  statusMS(70_000),
				RateLimitUntil: statusMS(70_000),
			},
		},
		{
			name:     "a longer unrelated cooldown is not shortened",
			provider: "codex",
			state: func() StatusState {
				state := authInvalid
				state.CooldownUntil = statusMS(100_000)
				return state
			}(),
			kind: StatusEventCredentialUpdateAfterFailure,
			want: StatusState{
				CooldownUntil:  statusMS(100_000),
				RateLimitUntil: statusMS(70_000),
			},
		},
		{
			name:     "the provider special case is codex-only",
			provider: "claude",
			state:    authInvalid,
			kind:     StatusEventCredentialUpdateAfterFailure,
			want:     StatusState{},
		},
		{
			name:     "without a derived auth_invalid the evidence falls through to the generic clear",
			provider: "codex",
			state: func() StatusState {
				state := authInvalid
				state.AuthInvalidUntil = time.Time{}
				return state
			}(),
			kind: StatusEventCredentialUpdateAfterFailure,
			want: StatusState{},
		},
	}
	for _, testCase := range cases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			got, err := ApplyStatusEvent(
				testCase.state,
				StatusEvent{Kind: testCase.kind, At: statusMS(60_000)},
				statusTestPolicy(testCase.provider),
			)
			if err != nil {
				t.Fatalf("ApplyStatusEvent() error = %v", err)
			}
			requireStatusState(t, got, testCase.want)
		})
	}
}

func TestApplyStatusEventCodexQuotaRecovery(t *testing.T) {
	t.Parallel()
	policy := statusTestPolicy("codex")
	quotaState := StatusState{
		CooldownUntil:       statusMS(90_000),
		ConsecutiveFailures: 2,
		LastError:           "quota_exhausted",
		LastFailureKind:     "quota_exhausted",
		LastFailureReason:   "quota_exhausted",
		LastFailureAt:       statusMS(20_000),
		RateLimitUntil:      statusMS(90_000),
		RoutingBlock:        statusTestBlock(statusBlockQuotaExhausted, "quota", 20_000, 90_000),
		ModelCooldowns:      map[string]time.Time{"gpt-5": statusMS(90_000)},
		ModelFailureStreaks: map[string]StatusModelFailureStreak{"gpt-5": statusTestStreak("quota_exhausted", 2, 90_000, 20_000)},
	}

	t.Run("a newer available snapshot clears quota facts only", func(t *testing.T) {
		t.Parallel()
		got, err := ApplyStatusEvent(quotaState, StatusEvent{
			Kind: StatusEventVerifiedUsageSuccess, At: statusMS(60_000), Usage: codexAvailableSnapshot(50_000),
		}, policy)
		if err != nil {
			t.Fatalf("ApplyStatusEvent() error = %v", err)
		}
		requireStatusState(t, got, StatusState{})
	})

	t.Run("a quota failure newer than the snapshot blocks the recovery", func(t *testing.T) {
		t.Parallel()
		state := quotaState
		state.ModelFailureStreaks = map[string]StatusModelFailureStreak{
			"gpt-5": statusTestStreak("quota_exhausted", 2, 90_000, 55_000),
		}
		got, err := ApplyStatusEvent(state, StatusEvent{
			Kind: StatusEventVerifiedUsageSuccess, At: statusMS(60_000), Usage: codexAvailableSnapshot(50_000),
		}, policy)
		if err != nil {
			t.Fatalf("ApplyStatusEvent() error = %v", err)
		}
		requireStatusState(t, got, StatusState{
			CooldownUntil:       statusMS(90_000),
			ConsecutiveFailures: 2,
			LastError:           "quota_exhausted",
			LastFailureKind:     "quota_exhausted",
			LastFailureReason:   "quota_exhausted",
			LastFailureAt:       statusMS(20_000),
			RateLimitUntil:      statusMS(90_000),
			ModelCooldowns:      map[string]time.Time{"gpt-5": statusMS(90_000)},
			ModelFailureStreaks: map[string]StatusModelFailureStreak{"gpt-5": statusTestStreak("quota_exhausted", 2, 90_000, 55_000)},
		})
	})

	t.Run("an untrusted snapshot makes the event a no-op", func(t *testing.T) {
		t.Parallel()
		snapshot := codexAvailableSnapshot(50_000)
		snapshot.SchemaVersion = 1
		got, err := ApplyStatusEvent(quotaState, StatusEvent{
			Kind: StatusEventVerifiedUsageSuccess, At: statusMS(60_000), Usage: snapshot,
		}, policy)
		if err != nil {
			t.Fatalf("ApplyStatusEvent() error = %v", err)
		}
		requireStatusState(t, got, quotaState)
	})

	t.Run("without a snapshot the generic clear runs", func(t *testing.T) {
		t.Parallel()
		state := StatusState{
			CooldownUntil:   statusMS(90_000),
			LastFailureKind: "quota_exhausted",
			LastFailureAt:   statusMS(20_000),
			RateLimitUntil:  statusMS(90_000),
		}
		got, err := ApplyStatusEvent(state, StatusEvent{
			Kind: StatusEventVerifiedUsageSuccess, At: statusMS(60_000),
		}, policy)
		if err != nil {
			t.Fatalf("ApplyStatusEvent() error = %v", err)
		}
		requireStatusState(t, got, StatusState{})
	})

	t.Run("a trusted snapshot also clears auth_invalid even when quota is exhausted", func(t *testing.T) {
		t.Parallel()
		snapshot := codexAvailableSnapshot(50_000)
		snapshot.Entries = []StatusUsageEntry{{RemainingPct: statusPercent(0)}}
		state := StatusState{
			CooldownUntil:       statusMS(90_000),
			ConsecutiveFailures: 3,
			LastError:           "reauth",
			LastFailureKind:     "auth_invalid",
			LastFailureReason:   "reauth",
			LastFailureAt:       statusMS(20_000),
			AuthInvalidUntil:    statusMS(90_000),
			RateLimitUntil:      statusMS(70_000),
		}
		got, err := ApplyStatusEvent(state, StatusEvent{
			Kind: StatusEventVerifiedUsageSuccess, At: statusMS(60_000), Usage: snapshot,
		}, policy)
		if err != nil {
			t.Fatalf("ApplyStatusEvent() error = %v", err)
		}
		// 与 Node 一致：这条分支只摘 authInvalidUntil 并重算 cooldownUntil，
		// 不清理 lastFailureKind / lastFailureAt / consecutiveFailures。
		requireStatusState(t, got, StatusState{
			CooldownUntil:       statusMS(70_000),
			ConsecutiveFailures: 3,
			LastError:           "reauth",
			LastFailureKind:     "auth_invalid",
			LastFailureReason:   "reauth",
			LastFailureAt:       statusMS(20_000),
			RateLimitUntil:      statusMS(70_000),
		})
	})
}

func TestApplyStatusEventAgyRecovery(t *testing.T) {
	t.Parallel()
	policy := statusTestPolicy("agy")
	notSignedIn := StatusState{
		CooldownUntil:     statusMS(90_000),
		LastError:         "agy_not_signed_in",
		LastFailureKind:   "auth_invalid",
		LastFailureReason: "agy_not_signed_in",
		LastFailureAt:     statusMS(20_000),
		AuthInvalidUntil:  statusMS(90_000),
	}
	regionBlock := StatusState{
		LastFailureKind:   statusBlockPermissionDenied,
		LastFailureReason: "Eligibility check failed: not available in your location (agy_region_not_eligible)",
		LastFailureAt:     statusMS(20_000),
		RoutingBlock: statusTestBlock(
			statusBlockPermissionDenied,
			"Eligibility check failed: not available in your location (agy_region_not_eligible)",
			20_000,
			90_000,
		),
	}
	cases := []struct {
		name  string
		state StatusState
		event StatusEvent
		want  StatusState
	}{
		{
			name:  "ordinary traffic success cannot clear agy_not_signed_in",
			state: notSignedIn,
			event: StatusEvent{Kind: StatusEventUpstreamSuccess, At: statusMS(60_000)},
			want:  notSignedIn,
		},
		{
			name:  "token refresh cannot clear agy_not_signed_in",
			state: notSignedIn,
			event: StatusEvent{Kind: StatusEventTokenRefreshSuccess, At: statusMS(60_000)},
			want:  notSignedIn,
		},
		{
			name:  "login success clears agy_not_signed_in",
			state: notSignedIn,
			event: StatusEvent{Kind: StatusEventLoginSuccess, At: statusMS(60_000)},
			want:  StatusState{},
		},
		{
			name:  "usage probe clears agy_not_signed_in",
			state: notSignedIn,
			event: StatusEvent{Kind: StatusEventAgyUsageProbeVerified, At: statusMS(60_000)},
			want:  StatusState{},
		},
		{
			name:  "a newer usage probe clears the agy region block",
			state: regionBlock,
			event: StatusEvent{
				Kind: StatusEventAgyUsageProbeVerified, At: statusMS(60_000),
				Usage: &StatusUsageSnapshot{CapturedAt: statusMS(30_000)},
			},
			want: StatusState{},
		},
		{
			name:  "a newer verified usage refresh also clears the agy region block",
			state: regionBlock,
			event: StatusEvent{
				Kind: StatusEventVerifiedUsageSuccess, At: statusMS(60_000),
				Usage: &StatusUsageSnapshot{CapturedAt: statusMS(30_000)},
			},
			want: StatusState{},
		},
		{
			name:  "a probe older than the failure cannot clear the region block",
			state: regionBlock,
			event: StatusEvent{
				Kind: StatusEventAgyUsageProbeVerified, At: statusMS(60_000),
				Usage: &StatusUsageSnapshot{CapturedAt: statusMS(10_000)},
			},
			want: regionBlock,
		},
		{
			name: "a non-region permission block is not eligible for probe recovery",
			state: func() StatusState {
				state := regionBlock
				state.RoutingBlock = statusTestBlock(statusBlockPermissionDenied, "workspace policy", 20_000, 90_000)
				return state
			}(),
			event: StatusEvent{
				Kind: StatusEventAgyUsageProbeVerified, At: statusMS(60_000),
				Usage: &StatusUsageSnapshot{CapturedAt: statusMS(30_000)},
			},
			want: StatusState{
				LastFailureKind:   statusBlockPermissionDenied,
				LastFailureReason: "Eligibility check failed: not available in your location (agy_region_not_eligible)",
				LastFailureAt:     statusMS(20_000),
				RoutingBlock:      statusTestBlock(statusBlockPermissionDenied, "workspace policy", 20_000, 90_000),
			},
		},
	}
	for _, testCase := range cases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			got, err := ApplyStatusEvent(testCase.state, testCase.event, policy)
			if err != nil {
				t.Fatalf("ApplyStatusEvent() error = %v", err)
			}
			requireStatusState(t, got, testCase.want)
		})
	}
}

func TestApplyStatusEventFailure(t *testing.T) {
	t.Parallel()
	policy := statusTestPolicy("codex")
	cases := []struct {
		name    string
		state   StatusState
		failure StatusFailure
		want    StatusState
	}{
		{
			name:    "rate limited fills its typed bucket and the generic cooldown",
			failure: StatusFailure{Kind: "rate_limited", Reason: "429", Cooldown: 5 * time.Minute},
			want: StatusState{
				CooldownUntil:     statusMS(10_000 + 300_000),
				LastFailureKind:   "rate_limited",
				LastFailureReason: "429",
				LastFailureAt:     statusMS(10_000),
				RateLimitUntil:    statusMS(10_000 + 300_000),
			},
		},
		{
			name:    "failure preserves unrelated buckets and counters",
			state:   StatusState{SuccessCount: 2, OverloadUntil: statusMS(900_000), ConsecutiveFailures: 0},
			failure: StatusFailure{Kind: "rate_limited", Reason: "429", Cooldown: time.Minute},
			want: StatusState{
				CooldownUntil:     statusMS(70_000),
				SuccessCount:      2,
				LastFailureKind:   "rate_limited",
				LastFailureReason: "429",
				LastFailureAt:     statusMS(10_000),
				OverloadUntil:     statusMS(900_000),
				RateLimitUntil:    statusMS(70_000),
			},
		},
		{
			name:    "timeout uses the network bucket",
			failure: StatusFailure{Kind: "timeout", Reason: "read timeout", Cooldown: time.Minute},
			want: StatusState{
				CooldownUntil:     statusMS(70_000),
				LastFailureKind:   "timeout",
				LastFailureReason: "read timeout",
				LastFailureAt:     statusMS(10_000),
				NetworkUntil:      statusMS(70_000),
			},
		},
		{
			name:    "quota failure becomes a routing block with the guessed recheck time",
			failure: StatusFailure{Kind: "quota_exhausted", Reason: "quota"},
			want: StatusState{
				LastFailureKind:   "quota_exhausted",
				LastFailureReason: "quota",
				LastFailureAt:     statusMS(10_000),
				RoutingBlock:      statusTestBlock("quota_exhausted", "quota", 10_000, 40_000),
			},
		},
		{
			name:    "an upstream reset hint becomes the block recheck time",
			failure: StatusFailure{Kind: "quota_exhausted", Reason: "quota", Cooldown: time.Minute},
			want: StatusState{
				LastFailureKind:   "quota_exhausted",
				LastFailureReason: "quota",
				LastFailureAt:     statusMS(10_000),
				RoutingBlock:      statusTestBlock("quota_exhausted", "quota", 10_000, 70_000),
			},
		},
		{
			name: "a shorter observation cannot pull a same-kind block earlier",
			state: StatusState{
				LastFailureAt: statusMS(5_000),
				RoutingBlock:  statusTestBlock("quota_exhausted", "quota", 5_000, 900_000),
			},
			failure: StatusFailure{Kind: "quota_exhausted", Reason: "quota", Cooldown: 30 * time.Second},
			want: StatusState{
				LastFailureKind:   "quota_exhausted",
				LastFailureReason: "quota",
				LastFailureAt:     statusMS(10_000),
				RoutingBlock:      statusTestBlock("quota_exhausted", "quota", 10_000, 900_000),
			},
		},
		{
			name: "a different block kind starts its own recheck clock",
			state: StatusState{
				LastFailureAt: statusMS(5_000),
				RoutingBlock:  statusTestBlock("quota_exhausted", "quota", 5_000, 900_000),
			},
			failure: StatusFailure{Kind: "permission_denied", Reason: "policy"},
			want: StatusState{
				LastFailureKind:   "permission_denied",
				LastFailureReason: "policy",
				LastFailureAt:     statusMS(10_000),
				RoutingBlock:      statusTestBlock("permission_denied", "policy", 10_000, 40_000),
			},
		},
		{
			name:    "manual recheck blocks never expire on their own",
			failure: StatusFailure{Kind: "permission_denied", Reason: "risk control", RecheckManual: true},
			want: StatusState{
				LastFailureKind:   "permission_denied",
				LastFailureReason: "risk control",
				LastFailureAt:     statusMS(10_000),
				RoutingBlock: &StatusRoutingBlock{
					Kind: "permission_denied", Reason: "risk control",
					ObservedAt: statusMS(10_000), RecheckManual: true,
				},
			},
		},
		{
			name:    "an empty reason falls back to the block kind",
			failure: StatusFailure{Kind: "billing_blocked"},
			want: StatusState{
				LastFailureKind: "billing_blocked",
				LastFailureAt:   statusMS(10_000),
				RoutingBlock:    statusTestBlock("billing_blocked", "billing_blocked", 10_000, 40_000),
			},
		},
	}
	for _, testCase := range cases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			got, err := ApplyStatusEvent(testCase.state, StatusEvent{
				Kind: StatusEventRuntimeFailure, At: statusMS(10_000), Failure: &testCase.failure,
			}, policy)
			if err != nil {
				t.Fatalf("ApplyStatusEvent() error = %v", err)
			}
			requireStatusState(t, got, testCase.want)
		})
	}
}

func TestApplyStatusEventRuntimeStateReplace(t *testing.T) {
	t.Parallel()
	policy := statusTestPolicy("codex")
	t.Run("nil document clears the runtime state", func(t *testing.T) {
		t.Parallel()
		got, err := ApplyStatusEvent(
			StatusState{LastFailureKind: "rate_limited", RateLimitUntil: statusMS(90_000)},
			StatusEvent{Kind: StatusEventRuntimeState, At: statusMS(10_000)},
			policy,
		)
		if err != nil {
			t.Fatalf("ApplyStatusEvent() error = %v", err)
		}
		requireStatusState(t, got, StatusState{})
	})
	t.Run("historical blocks without until get the recheck interval", func(t *testing.T) {
		t.Parallel()
		got, err := ApplyStatusEvent(StatusState{}, StatusEvent{
			Kind: StatusEventRuntimeState,
			At:   statusMS(10_000),
			State: &StatusState{
				RoutingBlock: &StatusRoutingBlock{
					Kind: "billing_blocked", Reason: "billing", ObservedAt: statusMS(5_000),
				},
			},
		}, policy)
		if err != nil {
			t.Fatalf("ApplyStatusEvent() error = %v", err)
		}
		requireStatusState(t, got, StatusState{
			RoutingBlock: statusTestBlock("billing_blocked", "billing", 5_000, 35_000),
		})
	})
	t.Run("unknown block kinds are dropped during normalization", func(t *testing.T) {
		t.Parallel()
		got, err := ApplyStatusEvent(StatusState{}, StatusEvent{
			Kind: StatusEventRuntimeState,
			At:   statusMS(10_000),
			State: &StatusState{
				RoutingBlock: statusTestBlock("mystery", "mystery", 5_000, 90_000),
			},
		}, policy)
		if err != nil {
			t.Fatalf("ApplyStatusEvent() error = %v", err)
		}
		requireStatusState(t, got, StatusState{})
	})
}

func TestApplyStatusEventDoesNotMutateInput(t *testing.T) {
	t.Parallel()
	state := StatusState{
		LastFailureAt:  statusMS(20_000),
		RoutingBlock:   statusTestBlock("quota_exhausted", "quota", 20_000, 90_000),
		ModelCooldowns: map[string]time.Time{"gpt-5": statusMS(90_000)},
		ModelFailureStreaks: map[string]StatusModelFailureStreak{
			"gpt-5": statusTestStreak("quota_exhausted", 2, 90_000, 20_000),
		},
	}
	originalBlock := *state.RoutingBlock
	originalCooldown := state.ModelCooldowns["gpt-5"]

	_, err := ApplyStatusEvent(state, StatusEvent{
		Kind: StatusEventRuntimeFailure, At: statusMS(30_000),
		Failure: &StatusFailure{Kind: "quota_exhausted", Reason: "quota", Cooldown: time.Minute},
	}, statusTestPolicy("codex"))
	if err != nil {
		t.Fatalf("ApplyStatusEvent() error = %v", err)
	}
	if !reflect.DeepEqual(*state.RoutingBlock, originalBlock) {
		t.Fatalf("input block mutated: %#v", *state.RoutingBlock)
	}
	if state.ModelCooldowns["gpt-5"] != originalCooldown {
		t.Fatalf("input model cooldown mutated: %v", state.ModelCooldowns["gpt-5"])
	}
}

func TestApplyStatusEventEvidenceWhitelist(t *testing.T) {
	t.Parallel()
	// Node 的 RUNTIME_CLEAR_EVIDENCE 共 15 条；少登记一条，对应的恢复路径就会在 Go 里
	// 静默失效（Node 对未登记证据直接 return false，不会有任何日志）。
	kinds := []StatusEventKind{
		StatusEventDirectUsageSuccess,
		StatusEventDirectRateLimitSuccess,
		StatusEventAgyOAuthCredentialsRecoverable,
		StatusEventAPIKeyConfigVerified,
		StatusEventCredentialConfigVerified,
		StatusEventCredentialUpdateAfterFailure,
		StatusEventLoginSuccess,
		StatusEventManualAdminClear,
		StatusEventModelsProbeSuccess,
		StatusEventNativeSessionSuccess,
		StatusEventAccessTokenStillValid,
		StatusEventTokenRefreshSuccess,
		StatusEventUpstreamSuccess,
		StatusEventVerifiedUsageSuccess,
		StatusEventAgyUsageProbeVerified,
	}
	if len(kinds) != 15 {
		t.Fatalf("evidence count = %d, want 15", len(kinds))
	}
	for _, kind := range kinds {
		kind := kind
		t.Run(string(kind), func(t *testing.T) {
			t.Parallel()
			got, err := ApplyStatusEvent(
				StatusState{CooldownUntil: statusMS(90_000), RateLimitUntil: statusMS(90_000)},
				StatusEvent{Kind: kind, At: statusMS(60_000)},
				statusTestPolicy("claude"),
			)
			if err != nil {
				t.Fatalf("ApplyStatusEvent() error = %v", err)
			}
			requireStatusState(t, got, StatusState{})
		})
	}
}

func TestStatusStateIsZero(t *testing.T) {
	t.Parallel()
	if !(StatusState{}).IsZero() {
		t.Fatal("zero value must be zero")
	}
	if (StatusState{SuccessCount: 1}).IsZero() {
		t.Fatal("counters are part of the document")
	}
	if (StatusState{ModelCooldowns: map[string]time.Time{"m": statusMS(1)}}).IsZero() {
		t.Fatal("model cooldowns are part of the document")
	}
}

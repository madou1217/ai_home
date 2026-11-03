// Package upstreamfailure 把 AGY Code Assist 低敏错误投影为统一运行态分类。
package upstreamfailure

import (
	"net/http"
	"time"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	sharedfailure "github.com/madou1217/ai_home/internal/adapters/upstreamfailure"
)

const httpStatusTooManyRequests = http.StatusTooManyRequests

// Input 只携带 Google RPC 稳定 status/code 和可靠 Retry-After。
type Input struct {
	StatusCode   int
	Status       string
	Code         string
	RegionDenied bool
	RetryAfter   time.Duration
}

// Classify 返回运行态分类和是否应延迟到完整请求结果再归因账号。
func Classify(
	input Input,
) (sharedfailure.Classification, bool, error) {
	response, err := sharedfailure.NormalizeResponseInput(
		sharedfailure.ResponseInput{
			StatusCode: input.StatusCode,
			ErrorType:  input.Status,
			ErrorCode:  input.Code,
			RetryAfter: input.RetryAfter,
		},
	)
	if err != nil {
		return sharedfailure.Classification{}, false, err
	}
	status := response.ErrorType()
	code := response.ErrorCode()
	if input.RegionDenied {
		classification, err := sharedfailure.NewBlockingClassification(
			runtimecore.FailureRegionUnsupported,
			runtimecore.BlockScopeAccount,
		)
		return classification, false, err
	}
	switch {
	case status == "unauthenticated" || response.StatusCode() == http.StatusUnauthorized:
		classification, err := sharedfailure.NewClassification(
			runtimecore.FailureCredentialRejected,
			0,
		)
		return classification, false, err
	case status == "permission_denied" || response.StatusCode() == http.StatusForbidden:
		classification, err := sharedfailure.NewBlockingClassification(
			runtimecore.FailureCredentialRejected,
			runtimecore.BlockScopeAccount,
		)
		return classification, false, err
	case response.StatusCode() == http.StatusUnavailableForLegalReasons:
		classification, err := sharedfailure.NewBlockingClassification(
			runtimecore.FailureRegionUnsupported,
			runtimecore.BlockScopeAccount,
		)
		return classification, false, err
	case status == "not_found" || response.StatusCode() == http.StatusNotFound:
		classification, err := sharedfailure.NewClassification(
			runtimecore.FailureModelUnsupported,
			0,
		)
		return classification, false, err
	case status == "resource_exhausted" ||
		code == "429" || response.StatusCode() == http.StatusTooManyRequests:
		retryAfter := response.RetryAfter()
		classification, err := sharedfailure.NewClassification(
			runtimecore.FailureRateLimited,
			retryAfter,
		)
		return classification, retryAfter == 0, err
	case status == "invalid_argument" || response.StatusCode() == http.StatusBadRequest:
		classification, err := sharedfailure.NewClassification(
			runtimecore.FailureInvalidRequest,
			0,
		)
		return classification, false, err
	case response.StatusCode() == http.StatusRequestTimeout:
		classification, err := sharedfailure.NewClassification(
			runtimecore.FailureUnclassified,
			0,
		)
		return classification, false, err
	case response.StatusCode() == 529:
		retryAfter := defaultRetryAfter(response.StatusCode(), runtimecore.FailureModelOverloaded, response.RetryAfter())
		classification, err := sharedfailure.NewClassification(
			runtimecore.FailureModelOverloaded,
			retryAfter,
		)
		return classification, false, err
	case response.StatusCode() >= http.StatusInternalServerError:
		retryAfter := defaultRetryAfter(response.StatusCode(), runtimecore.FailureUpstreamUnavailable, response.RetryAfter())
		classification, err := sharedfailure.NewClassification(
			runtimecore.FailureUpstreamUnavailable,
			retryAfter,
		)
		return classification, false, err
	default:
		classification, err := sharedfailure.NewClassification(
			runtimecore.FailureUnclassified,
			0,
		)
		return classification, false, err
	}
}

// defaultRetryAfter mirrors Node's status-specific recovery hints. Explicit
// Retry-After remains authoritative when it is within the shared upper bound.
func defaultRetryAfter(
	statusCode int,
	kind runtimecore.FailureKind,
	explicit time.Duration,
) time.Duration {
	if explicit > 0 && explicit <= runtimecore.MaxCooldownHint {
		return explicit
	}
	switch {
	case statusCode == http.StatusServiceUnavailable && kind == runtimecore.FailureUpstreamUnavailable:
		return runtimecore.GuessedCooldown
	case statusCode >= http.StatusInternalServerError && kind == runtimecore.FailureUpstreamUnavailable:
		return runtimecore.GuessedCooldown
	case statusCode == 529 && kind == runtimecore.FailureModelOverloaded:
		return runtimecore.GuessedCooldown
	default:
		return 0
	}
}

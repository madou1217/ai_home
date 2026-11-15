package inferencegateway

import "github.com/madou1217/ai_home/core/inference"

// ResponseMetadata is the upstream terminal snapshot, independent of retry and
// account failure classification. Each attempt owns its metadata.
func (failure AttemptFailure) ResponseMetadata() inference.ResponseMetadata {
	return failure.responseMetadata
}

// WithResponseMetadata returns a copy without changing failure policy.
func (failure AttemptFailure) WithResponseMetadata(metadata inference.ResponseMetadata) AttemptFailure {
	failure.responseMetadata = metadata
	return failure
}

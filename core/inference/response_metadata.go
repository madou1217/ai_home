package inference

// ResponseMetadata contains provider-observed response facts, never request hints.
// The zero value means unknown. Each lifecycle snapshot owns its metadata: a
// terminal response must not inherit a provisional tier from response creation.
type ResponseMetadata struct {
	serviceTier string
}

// NewResponseMetadata copies an optional observed service tier without guessing
// an enum or normalizing it. Nil means absent/null, not the tier "default".
func NewResponseMetadata(serviceTier *string) (ResponseMetadata, error) {
	if serviceTier == nil {
		return ResponseMetadata{}, nil
	}
	if !isCanonicalOpaqueID(*serviceTier) {
		return ResponseMetadata{}, ErrInvalidEvent
	}
	return ResponseMetadata{serviceTier: *serviceTier}, nil
}

// ServiceTier returns only the tier explicitly reported by the provider.
func (metadata ResponseMetadata) ServiceTier() (string, bool) {
	return metadata.serviceTier, metadata.serviceTier != ""
}

// ResponseMetadata returns the provider's creation-time snapshot.
func (event ResponseStartedEvent) ResponseMetadata() ResponseMetadata {
	return event.responseMetadata
}

// WithResponseMetadata returns an event copy with the observed snapshot.
func (event ResponseStartedEvent) WithResponseMetadata(metadata ResponseMetadata) ResponseStartedEvent {
	event.responseMetadata = metadata
	return event
}

// ResponseMetadata returns the provider's terminal snapshot.
func (event ResponseCompletedEvent) ResponseMetadata() ResponseMetadata {
	return event.responseMetadata
}

// WithResponseMetadata returns an event copy with the observed snapshot.
func (event ResponseCompletedEvent) WithResponseMetadata(metadata ResponseMetadata) ResponseCompletedEvent {
	event.responseMetadata = metadata
	return event
}

// ResponseMetadata returns the provider's failure-time snapshot, if known.
func (event ResponseFailedEvent) ResponseMetadata() ResponseMetadata {
	return event.responseMetadata
}

// WithResponseMetadata returns an event copy with the observed snapshot.
func (event ResponseFailedEvent) WithResponseMetadata(metadata ResponseMetadata) ResponseFailedEvent {
	event.responseMetadata = metadata
	return event
}

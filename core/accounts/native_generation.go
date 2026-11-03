package accounts

import "bytes"

// NativeGeneration is credential-origin time metadata, never import/request time.
// A scope identifies the observation (for example access-token iat); observations
// with different scopes are not comparable even if their integers happen to match.
type NativeGeneration struct {
	Scope string
	Value int64
}

func validNativeGenerations(values []NativeGeneration) bool {
	seen := make(map[string]bool, len(values))
	for _, item := range values {
		if !ValidNativeSubject(item.Scope) || item.Value <= 0 || item.Value > maxAccountUnixMillis || seen[item.Scope] {
			return false
		}
		seen[item.Scope] = true
	}
	return len(values) <= 256
}

// Generations returns a copy; a caller cannot mutate the ordering evidence later.
func (credential *NativeCredential) Generations() []NativeGeneration {
	if credential == nil {
		return nil
	}
	return append([]NativeGeneration(nil), credential.generations...)
}

// NewerThan is a partial order. A mixed newer/older grant set or missing evidence
// is unordered and must never implement last-response-wins credential replacement.
func (credential *NativeCredential) NewerThan(stored *NativeCredential) (newer, ordered bool) {
	if credential == nil || stored == nil || credential.IdentitySeed() != stored.IdentitySeed() || credential.authKind != stored.authKind {
		return false, false
	}
	if bytes.Equal(credential.payload, stored.payload) {
		return false, true
	}
	if len(credential.generations) == 0 || len(credential.generations) != len(stored.generations) {
		return false, false
	}
	previous := make(map[string]int64, len(stored.generations))
	for _, item := range stored.generations {
		previous[item.Scope] = item.Value
	}
	greater, lesser := false, false
	for _, item := range credential.generations {
		value, present := previous[item.Scope]
		if !present {
			return false, false
		}
		greater = greater || item.Value > value
		lesser = lesser || item.Value < value
	}
	if greater && lesser {
		return false, false
	}
	if !greater && !lesser {
		return false, false
	}
	return greater, true
}

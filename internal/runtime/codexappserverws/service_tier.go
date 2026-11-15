package codexappserverws

import (
	"bytes"
	"encoding/json"
)

// inheritResumeServiceTier maps an effective launch intent to the official
// app-server field. Native resume otherwise prefers its historical tier over
// current config. Do not rewrite live turn/settings messages, explicit tiers,
// explicit null, notifications, or malformed requests. A request-level config
// tier is more specific than the launch snapshot and uses the same typed field.
func inheritResumeServiceTier(raw []byte, tier *string) []byte {
	if tier == nil || *tier == "" {
		return raw
	}
	var request map[string]json.RawMessage
	if json.Unmarshal(raw, &request) != nil || request == nil {
		return raw
	}
	if rawID, hasID := request["id"]; !hasID || isJSONNull(rawID) {
		return raw
	}
	method := extractTrimmedMethod(request["method"])
	if method != "thread/resume" && method != "thread/fork" {
		return raw
	}
	params := parseRawObjectOrNil(request["params"])
	if params == nil {
		return raw
	}
	if _, explicit := params["serviceTier"]; explicit {
		return raw
	}
	config := parseRawObjectOrNil(params["config"])
	encodedTier, explicitConfig := config["service_tier"]
	if explicitConfig {
		// Preserve explicit null and values without guessing or validating a
		// provider enum; the native typed protocol owns value validation.
		var value string
		if !isJSONNull(encodedTier) && json.Unmarshal(encodedTier, &value) != nil {
			return raw
		}
	} else {
		var err error
		encodedTier, err = json.Marshal(*tier)
		if err != nil {
			return raw
		}
	}
	params["serviceTier"] = encodedTier
	encodedParams, err := marshalNoEscapeHTML(params)
	if err != nil {
		return raw
	}
	request["params"] = encodedParams
	encoded, err := marshalNoEscapeHTML(request)
	if err != nil || bytes.Equal(encoded, raw) {
		return raw
	}
	return encoded
}

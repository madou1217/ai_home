package modelmetadata

import "context"

// ServiceTier is model catalog metadata, not proof of account entitlement or execution speed.
type ServiceTier struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
}

// ServiceTierReader returns observed metadata for an exact provider/model pair.
type ServiceTierReader interface {
	LookupServiceTiers(context.Context, string, string) []ServiceTier
}

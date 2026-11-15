package accountsapi

import "github.com/madou1217/ai_home/internal/adapters/accounts/portableaccount"

// HTTP and offline backup imports share one credential construction policy.
type StaticCredentialFactory = portableaccount.StaticCredentialFactory
type BuiltinStaticCredentialFactory = portableaccount.BuiltinStaticCredentialFactory

var (
	ErrUnsupportedProvider          = portableaccount.ErrUnsupportedProvider
	ErrUnsupportedStaticAuthKind    = portableaccount.ErrUnsupportedStaticAuthKind
	ErrInvalidStaticCredentialInput = portableaccount.ErrInvalidStaticCredentialInput
)

func NewBuiltinStaticCredentialFactory() *BuiltinStaticCredentialFactory {
	return portableaccount.NewBuiltinStaticCredentialFactory()
}

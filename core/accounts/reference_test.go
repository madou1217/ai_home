package accounts_test

import (
	"errors"
	"testing"

	"github.com/madou1217/ai_home/core/accounts"
)

type testIdentitySource struct {
	providerID   string
	identitySeed string
}

func (source testIdentitySource) ProviderID() string {
	return source.providerID
}

func (source testIdentitySource) IdentitySeed() string {
	return source.identitySeed
}

func TestDeriveAccountRefMatchesBusinessContract(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		source   testIdentitySource
		expected string
	}{
		{
			name: "Codex OAuth",
			source: testIdentitySource{
				providerID:   "codex",
				identitySeed: "oauth:codex:user-123:personal",
			},
			expected: "acct_4a6fd2d115fe1edacb4a",
		},
		{
			name: "Claude OAuth",
			source: testIdentitySource{
				providerID:   "claude",
				identitySeed: "oauth:claude:uuid:01234567-89ab-cdef-0123-456789abcdef",
			},
			expected: "acct_887f52fd4dcd702eec8b",
		},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			accountRef, err := accounts.DeriveAccountRef(test.source)
			if err != nil {
				t.Fatalf("DeriveAccountRef() error = %v", err)
			}
			if accountRef.String() != test.expected {
				t.Fatalf("AccountRef = %q, want %q", accountRef, test.expected)
			}
		})
	}
}

func TestDeriveAccountRefRejectsInvalidIdentity(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		source accounts.IdentitySource
	}{
		{name: "nil source", source: nil},
		{name: "missing provider", source: testIdentitySource{identitySeed: "oauth:codex:user:personal"}},
		{name: "non canonical provider", source: testIdentitySource{providerID: " Codex ", identitySeed: "oauth:codex:user:personal"}},
		{name: "provider trailing separator", source: testIdentitySource{providerID: "codex-", identitySeed: "oauth:codex:user:personal"}},
		{name: "missing seed", source: testIdentitySource{providerID: "codex"}},
		{name: "non canonical seed", source: testIdentitySource{providerID: "codex", identitySeed: " oauth:codex:user:personal "}},
		{name: "control character", source: testIdentitySource{providerID: "codex", identitySeed: "oauth:codex:user:\n"}},
		{name: "legacy seed", source: testIdentitySource{providerID: "codex", identitySeed: "legacy:codex:1"}},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			_, err := accounts.DeriveAccountRef(test.source)
			if !errors.Is(err, accounts.ErrInvalidIdentity) {
				t.Fatalf("error = %v, want ErrInvalidIdentity", err)
			}
		})
	}
}

func TestParseAccountRefRequiresCanonicalValue(t *testing.T) {
	t.Parallel()

	accountRef, err := accounts.ParseAccountRef("acct_4a6fd2d115fe1edacb4a")
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	if accountRef.String() != "acct_4a6fd2d115fe1edacb4a" {
		t.Fatalf("AccountRef = %q", accountRef)
	}

	invalid := []string{
		"",
		" acct_4a6fd2d115fe1edacb4a",
		"acct_4A6FD2D115FE1EDACB4A",
		"acct_4a6fd2d115fe1edacb4",
		"acct_4a6fd2d115fe1edacb4aa",
		"user_4a6fd2d115fe1edacb4a",
	}
	for _, value := range invalid {
		value := value
		t.Run(value, func(t *testing.T) {
			t.Parallel()

			_, parseErr := accounts.ParseAccountRef(value)
			if !errors.Is(parseErr, accounts.ErrInvalidAccountRef) {
				t.Fatalf("error = %v, want ErrInvalidAccountRef", parseErr)
			}
		})
	}
}

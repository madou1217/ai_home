package accounts_test

import (
	"errors"
	"math"
	"testing"

	"github.com/madou1217/ai_home/core/accounts"
)

func TestCLIAccountIDSupportsPositiveSQLiteIntegerRange(t *testing.T) {
	t.Parallel()

	tests := []struct {
		value int64
		text  string
	}{
		{value: 1, text: "1"},
		{value: 10_000, text: "10000"},
		{value: math.MaxInt64, text: "9223372036854775807"},
	}

	for _, test := range tests {
		test := test
		t.Run(test.text, func(t *testing.T) {
			t.Parallel()

			accountID, err := accounts.NewCLIAccountID(test.value)
			if err != nil {
				t.Fatalf("NewCLIAccountID() error = %v", err)
			}
			if accountID.Int64() != test.value {
				t.Fatalf("Int64() = %d, want %d", accountID.Int64(), test.value)
			}
			if accountID.String() != test.text {
				t.Fatalf("String() = %q, want %q", accountID.String(), test.text)
			}

			parsed, parseErr := accounts.ParseCLIAccountID(test.text)
			if parseErr != nil {
				t.Fatalf("ParseCLIAccountID() error = %v", parseErr)
			}
			if parsed != accountID {
				t.Fatalf("parsed = %v, want %v", parsed, accountID)
			}
		})
	}
}

func TestCLIAccountIDRejectsNonCanonicalValues(t *testing.T) {
	t.Parallel()

	for _, value := range []int64{-1, 0} {
		_, err := accounts.NewCLIAccountID(value)
		if !errors.Is(err, accounts.ErrInvalidCLIAccountID) {
			t.Fatalf("NewCLIAccountID(%d) error = %v", value, err)
		}
	}

	for _, value := range []string{"", "0", "-1", "+1", "01", " 1", "1 ", "1.0", "9223372036854775808"} {
		value := value
		t.Run(value, func(t *testing.T) {
			t.Parallel()

			_, err := accounts.ParseCLIAccountID(value)
			if !errors.Is(err, accounts.ErrInvalidCLIAccountID) {
				t.Fatalf("ParseCLIAccountID(%q) error = %v", value, err)
			}
		})
	}
}

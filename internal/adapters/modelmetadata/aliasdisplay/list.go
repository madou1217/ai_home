// Package aliasdisplay supplies build-time SDK authority for legacy wildcard
// display names. It performs no network access, Node execution or database writes.
package aliasdisplay

import (
	"errors"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf16"
)

const (
	generationsPerFamily = 3
	maxReleaseAgeMS      = int64(365 * 24 * time.Hour / time.Millisecond)
)

var (
	// ErrInvalidSource means the embedded source is missing, corrupt or has an
	// unsupported contract. Callers must not turn this into an empty migration.
	ErrInvalidSource = errors.New("alias_display_source_invalid")
	datedSnapshot    = regexp.MustCompile(`-\d{8}$`)
)

// List applies the existing Node wildcard display policy to the embedded,
// validated SDK rows at now. It is NOT a route/availability/account-model list.
// Invalid patterns and valid patterns with no eligible names return an empty
// list with no error; source failures always return ErrInvalidSource, even for
// invalid patterns. A caller migrating a wildcard must decide explicitly how to
// handle a proven empty result rather than silently treating it as missing data.
func List(pattern string, now time.Time) ([]string, error) {
	catalog, err := loadSource()
	if err != nil {
		return nil, err
	}
	alias := strings.TrimSpace(pattern)
	if !strings.HasSuffix(alias, "*") {
		return []string{}, nil
	}
	prefix := strings.TrimSuffix(alias, "*")
	if len(utf16.Encode([]rune(prefix))) < 2 || strings.Contains(prefix, "*") {
		return []string{}, nil
	}
	groups := make(map[string][]rankedRow)
	for ordinal, row := range catalog.Rows {
		if !strings.HasPrefix(row.ID, prefix) || datedSnapshot.MatchString(row.ID) {
			continue
		}
		if now.UnixMilli()-row.ReleasedAt > maxReleaseAgeMS {
			continue
		}
		groups[row.Family] = append(groups[row.Family], rankedRow{row: row, ordinal: ordinal})
	}
	families := make([]familyGroup, 0, len(groups))
	for rank, family := range catalog.Families {
		rows := groups[family]
		if len(rows) == 0 {
			continue
		}
		sort.SliceStable(rows, func(i, j int) bool {
			if rows[i].ReleasedAt != rows[j].ReleasedAt {
				return rows[i].ReleasedAt > rows[j].ReleasedAt
			}
			return rows[i].ordinal < rows[j].ordinal
		})
		if len(rows) > generationsPerFamily {
			rows = rows[:generationsPerFamily]
		}
		families = append(families, familyGroup{rows: rows, rank: rank})
	}
	sort.SliceStable(families, func(i, j int) bool {
		if families[i].rows[0].ReleasedAt != families[j].rows[0].ReleasedAt {
			return families[i].rows[0].ReleasedAt > families[j].rows[0].ReleasedAt
		}
		return families[i].rank < families[j].rank
	})
	result := make([]string, 0)
	for _, family := range families {
		for _, row := range family.rows {
			result = append(result, row.ID)
		}
	}
	return result, nil
}

type rankedRow struct {
	row
	ordinal int
}

type familyGroup struct {
	rows []rankedRow
	rank int
}

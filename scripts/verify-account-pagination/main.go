// Command verify-account-pagination exercises the WebUI account list cursor.
//
// Safety properties:
//   - Read-only by default: only GET /v1/management/webui/accounts,
//     GET /v0/webui/accounts and invalid-parameter probes are performed.
//   - -mutate only touches provider "grok" rows with cli_account_id in
//     9000..9999. It refuses to run if any grok row already exists, and a
//     deferred cleanup removes every row it created, even on failure.
//   - The management key is read from -management-key or
//     AIH_SERVER_MANAGEMENT_KEY and is never printed.
//
// Usage:
//
//	AIH_SERVER_MANAGEMENT_KEY=... go run ./scripts/verify-account-pagination
//	AIH_SERVER_MANAGEMENT_KEY=... go run ./scripts/verify-account-pagination \
//	  -mutate -aih-db "$HOME/.ai_home/aih.db"
//
// Exit codes: 0 = pass, 1 = failure, 2 = invalid invocation.
package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

const (
	accountsPath = "/v1/management/webui/accounts"
	livePath     = "/v0/webui/accounts"
	testProvider = "grok"
	testCLIMin   = 9000
	testCLIMax   = 9999
)

type options struct {
	baseURL     string
	management  string
	dbPath      string
	concurrency int
	rounds      int
	mutate      bool
}

type accountRow struct {
	AccountRef    string          `json:"accountRef"`
	Provider      string          `json:"provider"`
	RuntimeModels json.RawMessage `json:"runtimeModels"`
}

type pageView struct {
	Limit        int    `json:"limit"`
	HasMore      bool   `json:"has_more"`
	NextAfterRef string `json:"next_after_ref"`
}

type listResponse struct {
	Accounts []accountRow `json:"accounts"`
	Page     pageView     `json:"page"`
}

type liveResponse struct {
	Accounts []accountRow `json:"accounts"`
}

type client struct {
	baseURL string
	key     string
	http    *http.Client
}

func (c *client) get(path string, query url.Values) (int, []byte, error) {
	endpoint := strings.TrimRight(c.baseURL, "/") + path
	if len(query) > 0 {
		endpoint += "?" + query.Encode()
	}
	request, err := http.NewRequest(http.MethodGet, endpoint, nil)
	if err != nil {
		return 0, nil, err
	}
	request.Header.Set("Authorization", "Bearer "+c.key)
	response, err := c.http.Do(request)
	if err != nil {
		return 0, nil, err
	}
	defer func() { _ = response.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(response.Body, 4<<20))
	if err != nil {
		return response.StatusCode, nil, err
	}
	return response.StatusCode, body, nil
}

func (c *client) page(query url.Values) (listResponse, int, error) {
	status, body, err := c.get(accountsPath, query)
	if err != nil {
		return listResponse{}, status, err
	}
	if status != http.StatusOK {
		return listResponse{}, status, nil
	}
	var decoded listResponse
	if err := json.Unmarshal(body, &decoded); err != nil {
		return listResponse{}, status, err
	}
	return decoded, status, nil
}

func (c *client) reference() ([]accountRow, error) {
	status, body, err := c.get(livePath, nil)
	if err != nil {
		return nil, err
	}
	if status != http.StatusOK {
		return nil, fmt.Errorf("live endpoint returned %d", status)
	}
	var decoded liveResponse
	if err := json.Unmarshal(body, &decoded); err != nil {
		return nil, err
	}
	return decoded.Accounts, nil
}

type checker struct {
	failures int
}

func (c *checker) check(name string, ok bool, detail string) {
	if ok {
		fmt.Printf("PASS %s %s\n", name, detail)
		return
	}
	c.failures++
	fmt.Printf("FAIL %s %s\n", name, detail)
}

func (c *client) collect(limit int, provider string) ([]string, int, error) {
	var seen []string
	after := ""
	pages := 0
	for {
		query := url.Values{"limit": {strconv.Itoa(limit)}}
		if provider != "" {
			query.Set("provider", provider)
		}
		if after != "" {
			query.Set("after_ref", after)
		}
		decoded, status, err := c.page(query)
		if err != nil {
			return nil, pages, err
		}
		if status != http.StatusOK {
			return nil, pages, fmt.Errorf("http %d", status)
		}
		if decoded.Page.Limit != limit {
			return nil, pages, fmt.Errorf("page.limit=%d want %d", decoded.Page.Limit, limit)
		}
		if decoded.Page.HasMore && (len(decoded.Accounts) != limit || decoded.Page.NextAfterRef == "") {
			return nil, pages, errors.New("has_more page shape")
		}
		if !decoded.Page.HasMore && (len(decoded.Accounts) > limit || decoded.Page.NextAfterRef != "") {
			return nil, pages, errors.New("last page shape")
		}
		for _, row := range decoded.Accounts {
			if provider != "" && row.Provider != provider {
				return nil, pages, fmt.Errorf("provider leak %q", row.Provider)
			}
			seen = append(seen, row.AccountRef)
		}
		pages++
		if !decoded.Page.HasMore {
			return seen, pages, nil
		}
		after = decoded.Page.NextAfterRef
		if pages > 500 {
			return nil, pages, errors.New("too many pages")
		}
	}
}

func sortedUnique(values []string) bool {
	for index := 1; index < len(values); index++ {
		if values[index] <= values[index-1] {
			return false
		}
	}
	return true
}

func refSet(rows []accountRow) map[string]bool {
	set := make(map[string]bool, len(rows))
	for _, row := range rows {
		set[row.AccountRef] = true
	}
	return set
}

func equalSets(left []string, right map[string]bool) bool {
	if len(left) != len(right) {
		return false
	}
	for _, ref := range left {
		if !right[ref] {
			return false
		}
	}
	return true
}

func runReadOnly(c *client, reference []accountRow, concurrency, rounds int) {
	check := &checker{}
	referenceSet := refSet(reference)
	limits := []int{1, 2, 5, 10, 17, 36, 37, 50, 255}
	for _, limit := range limits {
		seen, pages, err := c.collect(limit, "")
		switch {
		case err != nil:
			check.check(fmt.Sprintf("pagination limit=%d", limit), false, err.Error())
		case len(seen) != len(referenceSet) || !sortedUnique(seen) || !equalSets(seen, referenceSet):
			check.check(fmt.Sprintf("pagination limit=%d", limit), false,
				fmt.Sprintf("pages=%d rows=%d", pages, len(seen)))
		default:
			check.check(fmt.Sprintf("pagination limit=%d", limit), true,
				fmt.Sprintf("pages=%d rows=%d", pages, len(seen)))
		}
	}

	invalid := []string{
		"limit=0", "limit=-1", "limit=256", "limit=abc",
		"foo=1", "limit=1&limit=2", "after_ref=bogus", "ref=bogus",
	}
	for _, raw := range invalid {
		status, _, err := c.get(accountsPath, mustParse(raw))
		check.check("invalid "+raw, err == nil && status == http.StatusBadRequest, fmt.Sprintf("http=%d", status))
	}

	first := reference[0].AccountRef
	last := reference[len(reference)-1].AccountRef
	check.check("after first ref",
		pageHas(c, "limit=2&after_ref="+url.QueryEscape(first), func(rows []accountRow, _ pageView) bool {
			return len(rows) == 2 && rows[0].AccountRef != first
		}), "")
	check.check("after last ref",
		pageHas(c, "limit=2&after_ref="+url.QueryEscape(last), func(rows []accountRow, page pageView) bool {
			return len(rows) == 0 && !page.HasMore
		}), "")
	check.check("after max ref",
		pageHas(c, "limit=2&after_ref=acct_ffffffffffffffffffff", func(rows []accountRow, page pageView) bool {
			return len(rows) == 0 && !page.HasMore
		}), "")
	check.check("after min ref",
		pageHas(c, "limit=2&after_ref=acct_00000000000000000000", func(rows []accountRow, _ pageView) bool {
			return len(rows) == 2
		}), "")

	// Repeated cursor: same page several times, then reuse after advancing.
	firstPage, _, firstErr := pageFor(c, "limit=5")
	if firstErr != nil || len(firstPage.Accounts) != 5 || !firstPage.Page.HasMore {
		check.check("repeated cursor", false, "base page unavailable")
	} else {
		cursor := firstPage.Page.NextAfterRef
		base, _, baseErr := pageFor(c, "limit=5&after_ref="+url.QueryEscape(cursor))
		if baseErr != nil || len(base.Accounts) == 0 {
			check.check("repeated cursor", false, "cursor page unavailable")
		} else {
			baseRefs := refsOf(base.Accounts)
			stable := true
			for repeat := 0; repeat < 8; repeat++ {
				decoded, _, pageErr := pageFor(c, "limit=5&after_ref="+url.QueryEscape(cursor))
				if pageErr != nil || !sameStrings(refsOf(decoded.Accounts), baseRefs) || decoded.Page != base.Page {
					stable = false
					break
				}
			}
			check.check("repeated cursor", stable, "")
			small, _, _ := pageFor(c, "limit=3&after_ref="+url.QueryEscape(cursor))
			large, _, _ := pageFor(c, "limit=10&after_ref="+url.QueryEscape(cursor))
			check.check("limit prefix", len(small.Accounts) == 3 && len(large.Accounts) >= 3 && sameStrings(refsOf(small.Accounts), refsOf(large.Accounts)[:3]), "")
			if len(large.Accounts) > 0 {
				_, _, _ = pageFor(c, "limit=5&after_ref="+url.QueryEscape(large.Accounts[len(large.Accounts)-1].AccountRef))
				again, _, _ := pageFor(c, "limit=5&after_ref="+url.QueryEscape(cursor))
				check.check("old cursor reusable", sameStrings(refsOf(again.Accounts), baseRefs), "")
			}
		}
	}

	providers := map[string]map[string]bool{}
	for _, row := range reference {
		if providers[row.Provider] == nil {
			providers[row.Provider] = map[string]bool{}
		}
		providers[row.Provider][row.AccountRef] = true
	}
	for _, provider := range []string{"codebuddycn", "cline", "opencode"} {
		seen, pages, providerErr := c.collect(3, provider)
		check.check("provider "+provider,
			providerErr == nil && len(seen) == len(providers[provider]) && equalSets(seen, providers[provider]) && sortedUnique(seen),
			fmt.Sprintf("pages=%d rows=%d", pages, len(seen)))
	}
	empty, _, emptyErr := c.collect(10, "grok")
	check.check("empty provider", emptyErr == nil && len(empty) == 0, "")

	type job struct {
		limit    int
		provider string
	}
	jobs := make([]job, 0, concurrency)
	limitsForWorkers := []int{1, 2, 3, 5, 7, 10, 17, 25, 36, 37, 50, 255}
	providersForWorkers := []string{"", "", "", "codebuddycn", "cline", "opencode"}
	for index := 0; index < concurrency; index++ {
		jobs = append(jobs, job{
			limit:    limitsForWorkers[index%len(limitsForWorkers)],
			provider: providersForWorkers[index%len(providersForWorkers)],
		})
	}
	var wait sync.WaitGroup
	var mu sync.Mutex
	workerFailures := 0
	for _, current := range jobs {
		current := current
		wait.Add(1)
		go func() {
			defer wait.Done()
			for round := 0; round < rounds; round++ {
				seen, _, err := c.collect(current.limit, current.provider)
				expected := referenceSet
				if current.provider != "" {
					expected = providers[current.provider]
				}
				if err != nil || len(seen) != len(expected) || !equalSets(seen, expected) || !sortedUnique(seen) {
					mu.Lock()
					workerFailures++
					mu.Unlock()
					return
				}
			}
		}()
	}
	wait.Wait()
	check.check("concurrent pagination", workerFailures == 0,
		fmt.Sprintf("workers=%d rounds=%d failures=%d", len(jobs), rounds, workerFailures))

	fmt.Printf("READ_ONLY_FAILURES %d\n", check.failures)
	if check.failures > 0 {
		os.Exit(1)
	}
}

func mustParse(raw string) url.Values {
	values, err := url.ParseQuery(raw)
	if err != nil {
		panic(err)
	}
	return values
}

func pageFor(c *client, raw string) (listResponse, int, error) {
	return c.page(mustParse(raw))
}

func pageHas(c *client, raw string, predicate func([]accountRow, pageView) bool) bool {
	decoded, status, err := pageFor(c, raw)
	return err == nil && status == http.StatusOK && predicate(decoded.Accounts, decoded.Page)
}

func refsOf(rows []accountRow) []string {
	refs := make([]string, 0, len(rows))
	for _, row := range rows {
		refs = append(refs, row.AccountRef)
	}
	return refs
}

func sameStrings(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

type writeFixture struct {
	db        *sql.DB
	testRefs  map[string]bool
	nextCLI   int
	nextValue int64
	nowMS     int64
}

func openFixture(path string) (*writeFixture, error) {
	if strings.TrimSpace(path) == "" {
		return nil, errors.New("-mutate requires -aih-db")
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec("PRAGMA busy_timeout=10000"); err != nil {
		_ = db.Close()
		return nil, err
	}
	var grokCount int
	if err := db.QueryRow("SELECT COUNT(*) FROM accounts WHERE provider_id = ?", testProvider).Scan(&grokCount); err != nil {
		_ = db.Close()
		return nil, err
	}
	if grokCount != 0 {
		_ = db.Close()
		return nil, fmt.Errorf("refusing to mutate: provider %q already has %d accounts", testProvider, grokCount)
	}
	fixture := &writeFixture{
		db:        db,
		testRefs:  map[string]bool{},
		nextCLI:   testCLIMin + 1,
		nextValue: 0x10,
		nowMS:     time.Now().UnixMilli(),
	}
	return fixture, nil
}

func (f *writeFixture) cleanup() int {
	if f == nil || f.db == nil {
		return 0
	}
	_, _ = f.db.Exec(
		"DELETE FROM accounts WHERE provider_id = ? AND cli_account_id BETWEEN ? AND ?",
		testProvider, testCLIMin, testCLIMax,
	)
	var left int
	_ = f.db.QueryRow("SELECT COUNT(*) FROM accounts WHERE provider_id = ?", testProvider).Scan(&left)
	_ = f.db.Close()
	return left
}

func (f *writeFixture) add(value int64, cli int) (string, error) {
	ref := fmt.Sprintf("acct_%020x", value)
	if _, err := f.db.Exec(
		"INSERT INTO accounts (account_ref, provider_id, cli_account_id, enabled, created_at_ms, updated_at_ms) VALUES (?, ?, ?, 1, ?, ?)",
		ref, testProvider, cli, f.nowMS, f.nowMS,
	); err != nil {
		return "", err
	}
	f.testRefs[ref] = true
	return ref, nil
}

func (f *writeFixture) remove(ref string) error {
	if _, err := f.db.Exec("DELETE FROM accounts WHERE account_ref = ?", ref); err != nil {
		return err
	}
	delete(f.testRefs, ref)
	return nil
}

func (f *writeFixture) reset(count int) error {
	for ref := range f.testRefs {
		if err := f.remove(ref); err != nil {
			return err
		}
	}
	f.nextCLI = testCLIMin + 1
	f.nextValue = 0x10
	for index := 0; index < count; index++ {
		if _, err := f.add(f.nextValue, f.nextCLI); err != nil {
			return err
		}
		f.nextValue += 0x10
		f.nextCLI++
	}
	return nil
}

func (f *writeFixture) addNext() (string, error) {
	f.nextValue += 0x0f
	f.nextCLI++
	if f.nextCLI > testCLIMax {
		f.nextCLI = testCLIMin + 1
	}
	return f.add(f.nextValue, f.nextCLI)
}

func runMutating(c *client, dbPath string) int {
	check := &checker{}
	fixture, err := openFixture(dbPath)
	if err != nil {
		check.check("mutate fixture", false, err.Error())
		fmt.Printf("MUTATE_FAILURES %d\n", check.failures)
		return check.failures
	}
	cleaned := false
	defer func() {
		if !cleaned {
			_ = fixture.cleanup()
		}
	}()
	if err := fixture.reset(8); err != nil {
		check.check("seed rows", false, err.Error())
		return check.failures
	}

	// Delete the cursor row after page one; the next page must continue past it.
	decoded, _, pageErr := pageFor(c, "provider=grok&limit=2")
	if pageErr != nil || len(decoded.Accounts) != 2 || !decoded.Page.HasMore {
		check.check("cursor delete setup", false, "page unavailable")
		return check.failures
	}
	cursor := decoded.Page.NextAfterRef
	seen := refsOf(decoded.Accounts)
	if err := fixture.remove(cursor); err != nil {
		check.check("cursor delete", false, err.Error())
		return check.failures
	}
	for decoded.Page.HasMore {
		decoded, _, pageErr = pageFor(c, "provider=grok&limit=2&after_ref="+url.QueryEscape(cursor))
		if pageErr != nil {
			check.check("cursor delete", false, pageErr.Error())
			return check.failures
		}
		seen = append(seen, refsOf(decoded.Accounts)...)
		if decoded.Page.HasMore {
			cursor = decoded.Page.NextAfterRef
		}
	}
	check.check("cursor delete", len(seen) == 8 && sortedUnique(seen), fmt.Sprintf("rows=%d", len(seen)))

	// Insert before the cursor is not revisited; insert after it is.
	if err := fixture.reset(5); err != nil {
		check.check("insert before setup", false, err.Error())
		return check.failures
	}
	decoded, _, _ = pageFor(c, "provider=grok&limit=2")
	cursor = decoded.Page.NextAfterRef
	seen = refsOf(decoded.Accounts)
	before, err := fixture.add(0x0f, testCLIMin+20)
	if err != nil {
		check.check("insert before cursor", false, err.Error())
		return check.failures
	}
	for decoded.Page.HasMore {
		decoded, _, _ = pageFor(c, "provider=grok&limit=2&after_ref="+url.QueryEscape(cursor))
		seen = append(seen, refsOf(decoded.Accounts)...)
		if decoded.Page.HasMore {
			cursor = decoded.Page.NextAfterRef
		}
	}
	check.check("insert before cursor", !containsString(seen, before) && len(seen) == 5 && sortedUnique(seen), fmt.Sprintf("rows=%d", len(seen)))

	if err := fixture.reset(5); err != nil {
		check.check("insert after setup", false, err.Error())
		return check.failures
	}
	decoded, _, _ = pageFor(c, "provider=grok&limit=2")
	cursor = decoded.Page.NextAfterRef
	seen = refsOf(decoded.Accounts)
	if _, err := fixture.add(0x28, testCLIMin+21); err != nil {
		check.check("insert after cursor", false, err.Error())
		return check.failures
	}
	for decoded.Page.HasMore {
		decoded, _, _ = pageFor(c, "provider=grok&limit=2&after_ref="+url.QueryEscape(cursor))
		seen = append(seen, refsOf(decoded.Accounts)...)
		if decoded.Page.HasMore {
			cursor = decoded.Page.NextAfterRef
		}
	}
	check.check("insert after cursor", len(seen) == 6 && sortedUnique(seen), fmt.Sprintf("rows=%d", len(seen)))

	// Concurrent pagination while rows are inserted/deleted; anchors stay stable.
	if err := fixture.reset(5); err != nil {
		check.check("concurrent setup", false, err.Error())
		return check.failures
	}
	stableRefs := make([]string, 0, len(fixture.testRefs))
	for ref := range fixture.testRefs {
		stableRefs = append(stableRefs, ref)
	}
	sort.Strings(stableRefs)
	anchors := make(map[string]bool)
	for index := 0; index < len(stableRefs) && index < 3; index++ {
		anchors[stableRefs[index]] = true
	}
	var wait sync.WaitGroup
	var mu sync.Mutex
	failures := 0
	for worker := 0; worker < 8; worker++ {
		wait.Add(1)
		go func(limit int) {
			defer wait.Done()
			for round := 0; round < 2; round++ {
				seen, _, err := c.collect(limit, "grok")
				if err != nil || !sortedUnique(seen) {
					mu.Lock()
					failures++
					mu.Unlock()
					return
				}
				for anchor := range anchors {
					if !containsString(seen, anchor) {
						mu.Lock()
						failures++
						mu.Unlock()
						return
					}
				}
			}
		}(3 + worker%5)
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if len(fixture.testRefs) > 3 {
			for ref := range fixture.testRefs {
				if anchors[ref] {
					continue
				}
				_ = fixture.remove(ref)
				break
			}
		}
		if _, err := fixture.addNext(); err != nil {
			mu.Lock()
			failures++
			mu.Unlock()
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	wait.Wait()
	check.check("concurrent insert delete", failures == 0, fmt.Sprintf("failures=%d", failures))

	left := fixture.cleanup()
	cleaned = true
	check.check("cleanup grok rows", left == 0, fmt.Sprintf("left=%d", left))
	fmt.Printf("MUTATE_FAILURES %d\n", check.failures)
	return check.failures
}

func containsString(values []string, needle string) bool {
	for _, value := range values {
		if value == needle {
			return true
		}
	}
	return false
}

func main() {
	var opts options
	flag.StringVar(&opts.baseURL, "base-url", "http://127.0.0.1:9527", "AIH server base URL")
	flag.StringVar(&opts.management, "management-key", "", "management key (default AIH_SERVER_MANAGEMENT_KEY)")
	flag.StringVar(&opts.dbPath, "aih-db", "", "path to aih.db; required by -mutate")
	flag.IntVar(&opts.concurrency, "concurrency", 16, "read-only pagination workers")
	flag.IntVar(&opts.rounds, "rounds", 2, "rounds per worker")
	flag.BoolVar(&opts.mutate, "mutate", false, "run insert/delete cases against provider grok (cli 9000-9999)")
	flag.Parse()
	if opts.management == "" {
		opts.management = strings.TrimSpace(os.Getenv("AIH_SERVER_MANAGEMENT_KEY"))
	}
	if opts.management == "" {
		fmt.Fprintln(os.Stderr, "management key required: -management-key or AIH_SERVER_MANAGEMENT_KEY")
		os.Exit(2)
	}
	if opts.concurrency < 1 || opts.rounds < 1 {
		fmt.Fprintln(os.Stderr, "concurrency and rounds must be >= 1")
		os.Exit(2)
	}
	c := &client{baseURL: opts.baseURL, key: opts.management, http: &http.Client{Timeout: 20 * time.Second}}
	reference, err := c.reference()
	if err != nil {
		fmt.Fprintf(os.Stderr, "read reference: %v\n", err)
		os.Exit(1)
	}
	if len(reference) == 0 {
		fmt.Fprintln(os.Stderr, "reference has no accounts")
		os.Exit(1)
	}
	sort.Slice(reference, func(left, right int) bool { return reference[left].AccountRef < reference[right].AccountRef })
	runReadOnly(c, reference, opts.concurrency, opts.rounds)
	if opts.mutate {
		if failures := runMutating(c, opts.dbPath); failures > 0 {
			os.Exit(1)
		}
	}
}

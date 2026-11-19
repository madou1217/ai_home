package managementops

import (
	"encoding/binary"
	"github.com/madou1217/ai_home/internal/adapters/modelcatalogsettings"
	"hash/fnv"
	"math"
	"sort"
	"strconv"
	"strings"
)

// parseCodexForkKey 等价于 codexFileEventPattern 与 CTE 的 substr/GLOB 校验，零正则开销。
func parseCodexForkKey(provider, eventKey, kind string) (string, int64, bool) {
	if provider != "codex" {
		return "", 0, false
	}
	const prefix = "codex:file:"
	if !strings.HasPrefix(eventKey, prefix) {
		return "", 0, false
	}
	suffix := ":" + kind
	minLen := len(prefix) + 16 + 1 + len(suffix)
	if len(eventKey) <= minLen || !strings.HasSuffix(eventKey, suffix) {
		return "", 0, false
	}
	if eventKey[27] != ':' {
		return "", 0, false
	}
	hash := eventKey[11:27]
	for i := 0; i < 16; i++ {
		c := hash[i]
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
			return "", 0, false
		}
	}
	offsetText := eventKey[28 : len(eventKey)-len(suffix)]
	if len(offsetText) == 0 {
		return "", 0, false
	}
	for i := 0; i < len(offsetText); i++ {
		if offsetText[i] < '0' || offsetText[i] > '9' {
			return "", 0, false
		}
	}
	offset, err := strconv.ParseInt(offsetText, 10, 64)
	if err != nil {
		return "", 0, false
	}
	return hash, offset, true
}

func isCodexFileUsageOrPrompt(provider, eventKey, kind string) bool {
	_, _, ok := parseCodexForkKey(provider, eventKey, kind)
	return ok
}

func applyCodexForkToUsageRow(
	provider, eventKey, sessionID, project, cwd string,
	forksByHash map[string]forkDescriptor,
) (newSessionID, newProject, newCWD string, keep bool, isCodexFile bool) {
	hash, offset, ok := parseCodexForkKey(provider, eventKey, "usage")
	if !ok {
		return sessionID, project, cwd, true, false
	}
	desc, matched := forksByHash[hash]
	if !matched {
		return sessionID, project, cwd, true, true
	}
	if desc.ReplayPending {
		return "", "", "", false, true
	}
	if desc.BoundaryOffset > 0 {
		if offset <= desc.BoundaryOffset {
			return "", "", "", false, true
		}
		if desc.SessionID != "" {
			sessionID = desc.SessionID
		}
		if desc.Project != "" {
			project = desc.Project
		}
		if desc.CWD != "" {
			cwd = desc.CWD
		}
	}
	return sessionID, project, cwd, true, true
}

func applyCodexForkToPromptRow(
	provider, eventKey, sessionID string,
	forksByHash map[string]forkDescriptor,
) (newSessionID string, keep bool, isCodexFile bool) {
	hash, offset, ok := parseCodexForkKey(provider, eventKey, "prompt")
	if !ok {
		return sessionID, true, false
	}
	desc, matched := forksByHash[hash]
	if !matched {
		return sessionID, true, true
	}
	if desc.ReplayPending {
		return "", false, true
	}
	if desc.BoundaryOffset > 0 {
		if offset <= desc.BoundaryOffset {
			return "", false, true
		}
		if desc.SessionID != "" {
			sessionID = desc.SessionID
		}
	}
	return sessionID, true, true
}

func hashInt64(h interface{ Write([]byte) (int, error) }, v int64) {
	var buf [8]byte
	binary.LittleEndian.PutUint64(buf[:], uint64(v))
	_, _ = h.Write(buf[:])
}

func hashString(h interface{ Write([]byte) (int, error) }, s string) {
	hashInt64(h, int64(len(s)))
	_, _ = h.Write([]byte(s))
}

func hashOptFloat64(h interface{ Write([]byte) (int, error) }, v *float64) {
	if v == nil {
		_, _ = h.Write([]byte{0})
		return
	}
	_, _ = h.Write([]byte{1})
	hashInt64(h, int64(math.Float64bits(*v)))
}

func computeForkDigest(forks []forkDescriptor) int64 {
	h := fnv.New64a()
	if len(forks) == 0 {
		return int64(h.Sum64())
	}
	ordered := append([]forkDescriptor(nil), forks...)
	sort.Slice(ordered, func(i, j int) bool { return ordered[i].SourceHash < ordered[j].SourceHash })
	hashInt64(h, int64(len(ordered)))
	for _, f := range ordered {
		hashString(h, f.SourceHash)
		if f.ReplayPending {
			hashInt64(h, 1)
		} else {
			hashInt64(h, 0)
		}
		hashInt64(h, f.BoundaryOffset)
		hashString(h, f.SessionID)
		hashString(h, f.CWD)
		hashString(h, f.Project)
	}
	return int64(h.Sum64())
}

func computeCustomPricingDigest(custom map[string]modelcatalogsettings.CustomPricing) int64 {
	h := fnv.New64a()
	if len(custom) == 0 {
		return int64(h.Sum64())
	}
	keys := make([]string, 0, len(custom))
	for k := range custom {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	hashInt64(h, int64(len(keys)))
	for _, k := range keys {
		cp := custom[k]
		hashString(h, k)
		hashOptFloat64(h, cp.Input)
		hashOptFloat64(h, cp.Output)
		hashOptFloat64(h, cp.CacheRead)
		hashOptFloat64(h, cp.CacheWrite)
	}
	return int64(h.Sum64())
}

func computeAttrSliceDigest(attrs []usageAttribution) hourAttrDigest {
	if len(attrs) == 0 {
		return hourAttrDigest{}
	}
	ordered := append([]usageAttribution(nil), attrs...)
	sort.Slice(ordered, func(i, j int) bool {
		if ordered[i].ScannerID != ordered[j].ScannerID {
			return ordered[i].ScannerID < ordered[j].ScannerID
		}
		return ordered[i].ProxyID < ordered[j].ProxyID
	})
	h := fnv.New64a()
	hashInt64(h, int64(len(ordered)))
	for _, a := range ordered {
		hashInt64(h, a.ScannerID)
		hashInt64(h, a.ProxyID)
		hashString(h, a.Model)
		hashString(h, a.AccountProvider)
		hashString(h, a.AccountRef)
		hashInt64(h, int64(math.Float64bits(a.CostUSD)))
	}
	return hourAttrDigest{
		count:  len(ordered),
		digest: int64(h.Sum64()),
	}
}

func computeHourAttrDigests(attrs []usageAttribution, minHour, maxHourEnd int64) map[int64]hourAttrDigest {
	if len(attrs) == 0 {
		return nil
	}
	filterRange := maxHourEnd > minHour
	buckets := make(map[int64][]usageAttribution)
	addToHour := func(h int64, a usageAttribution) {
		if filterRange && (h < minHour || h >= maxHourEnd) {
			return
		}
		buckets[h] = append(buckets[h], a)
	}
	for _, a := range attrs {
		sh := hourFloorMS(a.ScannerTimestampMS)
		ph := hourFloorMS(a.ProxyTimestampMS)
		addToHour(sh, a)
		if ph != sh {
			addToHour(ph, a)
		}
	}
	out := make(map[int64]hourAttrDigest, len(buckets))
	for h, list := range buckets {
		out[h] = computeAttrSliceDigest(list)
	}
	return out
}

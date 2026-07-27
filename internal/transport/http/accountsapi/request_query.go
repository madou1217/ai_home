package accountsapi

import (
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// errInvalidQuery 表示账号 HTTP 查询参数不符合当前路由合同。
var errInvalidQuery = errors.New("账号 HTTP 查询参数无效")

// parseOverviewQuery 校验唯一查询参数，并多取一行用于 has_more。
func parseOverviewQuery(
	request *http.Request,
) (accountapp.OverviewQuery, int, error) {
	values, err := url.ParseQuery(request.URL.RawQuery)
	if err != nil || request.URL.RawQuery != "" && len(values) == 0 {
		return accountapp.OverviewQuery{}, 0, errInvalidQuery
	}
	for key, entries := range values {
		if (key != "after_ref" && key != "limit") || len(entries) != 1 {
			return accountapp.OverviewQuery{}, 0, errInvalidQuery
		}
	}
	afterRef, err := parseOptionalAccountRef(
		values.Get("after_ref"),
		values.Has("after_ref"),
	)
	if err != nil {
		return accountapp.OverviewQuery{}, 0, errInvalidQuery
	}
	visibleLimit, err := parsePageSize(values.Get("limit"), values.Has("limit"))
	if err != nil {
		return accountapp.OverviewQuery{}, 0, errInvalidQuery
	}
	query, err := accountapp.NewOverviewQuery(afterRef, visibleLimit+1)
	if err != nil {
		return accountapp.OverviewQuery{}, 0, errInvalidQuery
	}
	return query, visibleLimit, nil
}

// parseOptionalAccountRef 区分缺省游标和调用方显式传入的空游标。
func parseOptionalAccountRef(
	value string,
	present bool,
) (accountcore.AccountRef, error) {
	if !present {
		return "", nil
	}
	if value == "" {
		return "", accountcore.ErrInvalidAccountRef
	}
	return accountcore.ParseAccountRef(value)
}

// parsePageSize 只对缺省参数应用默认值，显式空值属于无效输入。
func parsePageSize(value string, present bool) (int, error) {
	if !present {
		return accountapp.DefaultOverviewLimit, nil
	}
	limit, err := strconv.Atoi(value)
	if err != nil || limit < 1 || limit > apiMaxPageSize {
		return 0, errInvalidQuery
	}
	return limit, nil
}

// parseMemberAccountRef 拒绝空成员、尾斜杠和嵌套资源。
func parseMemberAccountRef(path string) (accountcore.AccountRef, error) {
	value := strings.TrimPrefix(path, CollectionPath+"/")
	if value == "" || strings.Contains(value, "/") {
		return "", accountcore.ErrInvalidAccountRef
	}
	return accountcore.ParseAccountRef(value)
}

// rejectUnexpectedQuery 拒绝没有声明查询参数的资源操作。
func rejectUnexpectedQuery(
	response http.ResponseWriter,
	request *http.Request,
) bool {
	if request.URL.RawQuery == "" {
		return false
	}
	writeInvalidQuery(response)
	return true
}

package accountsapi

import (
	"encoding/json"
	"net/http"
	"strings"
)

// Backup adapter uses the already-running canonical store and routing index;
// it never launches another server or writes through an unobserved side store.
func (handler *Handler) handleBackupAccounts(w http.ResponseWriter, r *http.Request) {
	if handler.backupAccounts == nil {
		writeAPIError(w, 503, "backup_accounts_unavailable", "备份账号端口未装配")
		return
	}
	action := strings.TrimPrefix(r.URL.Path, CollectionPath+"/backup/")
	if (action != "import" && action != "preflight" && action != "export") || r.Method != http.MethodPost {
		writeMethodNotAllowed(w)
		return
	}
	if rejectUnexpectedQuery(w, r) {
		return
	}
	var raw json.RawMessage
	if e := decodeJSONRequestWithLimit(w, r, &raw, 64*1024*1024); e != nil {
		writeRequestDecodeError(w, e)
		return
	}
	result, e := handler.backupAccounts(r.Context(), action, raw)
	if e != nil {
		writeAPIError(w, 400, "backup_accounts_rejected", "备份账号导入或导出失败")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(200)
	_, _ = w.Write(result)
}

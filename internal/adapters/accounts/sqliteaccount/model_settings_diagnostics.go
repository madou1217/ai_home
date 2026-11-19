package sqliteaccount

// logModelSettings keeps watcher diagnostics on the owning host's explicit sink.
// It never falls back to the process logger or foreground terminal.
func (store *Store) logModelSettings(format string, args ...any) {
	if store == nil || store.modelSettingsLogf == nil {
		return
	}
	store.modelSettingsLogf(format, args...)
}

-- Host default ownership is an integrity fence, not a second launch selector.
-- Consumers still read account_defaults. The receipt constrains legacy writers
-- even when an old running binary issues SQL without checking the new owner.
CREATE TABLE account_default_ownership (
  provider_id TEXT NOT NULL PRIMARY KEY,
  owner TEXT NOT NULL CHECK(owner = 'go'),
  expected_ref TEXT,
  operation_id TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TRIGGER guard_owned_default_insert BEFORE INSERT ON account_defaults
WHEN EXISTS (SELECT 1 FROM account_default_ownership o
  WHERE o.provider_id = NEW.provider_id
    AND (o.expected_ref IS NULL OR o.expected_ref <> NEW.account_ref))
BEGIN SELECT RAISE(ABORT, 'host_default_write_requires_projection'); END;

CREATE TRIGGER guard_owned_default_update BEFORE UPDATE ON account_defaults
WHEN EXISTS (SELECT 1 FROM account_default_ownership o
  WHERE o.provider_id = NEW.provider_id
    AND (o.expected_ref IS NULL OR o.expected_ref <> NEW.account_ref))
BEGIN SELECT RAISE(ABORT, 'host_default_write_requires_projection'); END;

CREATE TRIGGER guard_owned_default_delete BEFORE DELETE ON account_defaults
WHEN EXISTS (SELECT 1 FROM account_default_ownership o
  WHERE o.provider_id = OLD.provider_id AND o.expected_ref IS NOT NULL)
  AND EXISTS (SELECT 1 FROM accounts a WHERE a.account_ref = OLD.account_ref AND a.enabled = 1)
BEGIN SELECT RAISE(ABORT, 'host_default_write_requires_projection'); END;

CREATE TRIGGER release_deleted_default_owner AFTER DELETE ON accounts
BEGIN UPDATE account_default_ownership SET expected_ref = NULL
  WHERE expected_ref = OLD.account_ref; END;

PRAGMA user_version = 31;

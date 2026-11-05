-- v23：别名补 display_models_json。
--
-- 通配别名（alias 以 * 结尾）的 displayModels 是 Node 按 models.dev 快照算好的展示名单。
-- v22 只存了别名本身，重启后从库里恢复的 wildcard 会丢掉名单——推送还没到之前
-- 模型目录里就少了一批可展示型号。
ALTER TABLE model_alias ADD COLUMN display_models_json TEXT NOT NULL DEFAULT '[]';

PRAGMA user_version = 23;


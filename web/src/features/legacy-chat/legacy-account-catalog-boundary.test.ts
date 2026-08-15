import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('聊天账号目录使用独立只读适配器，不复用 Go 账号管理 Facade', async () => {
  const source = await readFile(
    new URL('./use-chat-account-catalog.ts', import.meta.url),
    'utf8',
  );

  assert.match(
    source,
    /import \{ legacyChatAccountCatalogAPI \} from '@\/services\/legacy-chat-account-catalog';/,
  );
  assert.doesNotMatch(source, /import \{ accountsAPI \} from '@\/services\/api';/);
});

test('通用 Web API 不重导出 Go 账号管理 Facade，同时保留正式 Node 账号合同', async () => {
  const source = await readFile(
    new URL('../../services/api.ts', import.meta.url),
    'utf8',
  );

  assert.doesNotMatch(source, /export \{ accountsAPI \} from '.\/account-management\/facade';/);
	assert.match(source, /export const accountsAPI\s*=/);
	assert.match(source, /AccountImportPayload|AccountImportUploadFile|AccountExportFormat/);
});

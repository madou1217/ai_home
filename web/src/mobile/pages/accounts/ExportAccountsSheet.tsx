import { ExportOutlined } from '@ant-design/icons';
import { DetailSheet, HudCard } from '@/mobile/ui';
import type { AccountExportFormat } from '@/services/api';
import { EXPORT_ACTIONS } from '@/features/accounts/account-import-export';
import styles from '../MobileAccounts.module.css';

interface Props {
  open: boolean;
  exporting: boolean;
  onClose: () => void;
  onExport: (format: AccountExportFormat) => void;
}

/** 导出账号：与桌面导出菜单同样的三种格式（EXPORT_ACTIONS），走 accountsAPI.export 下载文件。 */
export default function ExportAccountsSheet({ open, exporting, onClose, onExport }: Props) {
  return (
    <DetailSheet open={open} onClose={onClose} code="EXPORT" title="导出账号">
      <div className={styles.sheetStack}>
        {EXPORT_ACTIONS.map((action) => (
          <HudCard
            key={action.format}
            code={action.format.toUpperCase()}
            title={action.label}
            extra={<ExportOutlined aria-hidden="true" />}
            onClick={exporting ? undefined : () => {
              onClose();
              onExport(action.format);
            }}
            ariaLabel={action.label}
          >
            <p className={styles.cardDesc}>{action.description}</p>
          </HudCard>
        ))}
      </div>
    </DetailSheet>
  );
}

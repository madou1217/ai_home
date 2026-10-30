import { useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { MobilePageProps } from '@/mobile/mobile-routes';
import { HudChips, MobilePage } from '@/mobile/ui';
import { useSwitchFade } from '@/hooks/use-switch-fade';
import AliasesPanel from './settings/AliasesPanel';
import BasicSettingsPanel from './settings/BasicSettingsPanel';
import UpstreamErrorMappingsPanel from './settings/UpstreamErrorMappingsPanel';
import styles from './settings/MobileSettings.module.css';

type SettingsTab = 'basic' | 'aliases' | 'upstream-errors';

const TABS = [
  { key: 'basic', label: '基础设置' },
  { key: 'aliases', label: '模型别名' },
  { key: 'upstream-errors', label: '上游异常映射' }
];

/**
 * 移动端设置（/settings）：与桌面同样的配置分区（?tab=aliases/upstream-errors 直达）。
 * Server 管理与 SSH 开发机有独立路由（/fabric/servers、/fabric/ssh-hosts），经「更多」面板进入。
 */
export default function MobileSettings(_props: MobilePageProps) {
  const [searchParams] = useSearchParams();
  const [tab, setTab] = useState<SettingsTab>(() => (
    (['aliases', 'upstream-errors'] as const).includes(String(searchParams.get('tab') || '').trim() as 'aliases' | 'upstream-errors')
      ? String(searchParams.get('tab')).trim() as SettingsTab
      : 'basic'
  ));
  // 基础设置是 hidden 常驻、其余分区按需挂载：切换时整块面板淡入一次（只碰 opacity）。
  const panelBodyRef = useRef<HTMLDivElement | null>(null);
  useSwitchFade(panelBodyRef, tab, { scope: 'mobile-settings-tab' });

  return (
    <MobilePage lead="管理 server、额度刷新和模型别名。">
      <HudChips ariaLabel="设置分区" items={TABS} value={tab} onChange={(key) => setTab(key as SettingsTab)} />
      <div ref={panelBodyRef}>
      {/* 基础设置常驻挂载：切换分区不丢未保存的表单输入（桌面同为 forceRender）；别名分区按需挂载 */}
      <div hidden={tab !== 'basic'} role="tabpanel" aria-label="基础设置" className={styles.panel}>
        <BasicSettingsPanel />
      </div>
      {tab === 'aliases' ? (
        <div role="tabpanel" aria-label="模型别名" className={styles.panel}>
          <AliasesPanel />
        </div>
      ) : null}
      {tab === 'upstream-errors' ? (
        <div role="tabpanel" aria-label="上游异常映射" className={styles.panel}>
          <UpstreamErrorMappingsPanel />
        </div>
      ) : null}
      </div>
    </MobilePage>
  );
}

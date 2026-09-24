/** 页面分包加载中的 HUD 占位（真实加载态，不伪造数据）。 */
export default function MobileBoot({ label = 'LOADING' }: { label?: string }) {
  return (
    <div className="mhud-boot" role="status" aria-live="polite">
      <span className="mhud-boot__bar" aria-hidden="true"><span /></span>
      <span className="mhud-boot__label">{label}</span>
    </div>
  );
}

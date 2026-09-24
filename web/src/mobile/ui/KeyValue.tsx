import type { ReactNode } from 'react';

interface Row {
  key: string;
  label: ReactNode;
  value: ReactNode;
  mono?: boolean;
  tone?: 'ok' | 'warn' | 'err' | 'info' | 'muted';
}

/** 详情抽屉里的键值行：大写淡色键 + 等宽值，发丝分隔。 */
export default function KeyValue({ rows }: { rows: Row[] }) {
  return (
    <dl className="mhud-kv">
      {rows.map((row) => (
        <div key={row.key} className="mhud-kv__row">
          <dt className="mhud-kv__key">{row.label}</dt>
          <dd className={`mhud-kv__value${row.mono === false ? ' is-prose' : ''}${row.tone ? ` mhud-tone--${row.tone}` : ''}`}>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

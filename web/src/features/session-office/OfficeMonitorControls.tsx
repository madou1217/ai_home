import { useMemo } from 'react';
import {
  CheckOutlined,
  DesktopOutlined,
  DragOutlined,
  MinusOutlined,
  PlusOutlined,
  SplitCellsOutlined,
  UndoOutlined,
} from '@ant-design/icons';
import AppButton from '@/components/ui/AppButton';
import SettingStatusTag from '@/components/ui/SettingStatusTag';
import {
  OFFICE_MONITOR_TRANSFORM_BOUNDS,
  type OfficeMonitorTransform,
} from './office-computer-state';
import type {
  OfficeMonitorDragMode,
  OfficeMonitorIndex,
} from './office-scene-types';
import './OfficeMonitorControls.css';

export interface OfficeMonitorControlsProps {
  dualMonitor: boolean;
  activeMonitorIndex: OfficeMonitorIndex;
  dragMode: OfficeMonitorDragMode;
  transform: OfficeMonitorTransform;
  onToggleDualMonitor: (nextDual: boolean) => void;
  onSelectMonitorIndex: (index: OfficeMonitorIndex) => void;
  onChangeDragMode: (mode: OfficeMonitorDragMode) => void;
  onStepAxis: (axis: keyof OfficeMonitorTransform, delta: number) => void;
  onResetMonitors: () => void;
  onDone: () => void;
}

const DRAG_MODE_OPTIONS: ReadonlyArray<{
  mode: OfficeMonitorDragMode;
  label: string;
}> = [
  { mode: 'xz', label: '平面' },
  { mode: 'y', label: '高度' },
  { mode: 'yaw', label: '旋转' },
];

interface AxisStepperSpec {
  axis: keyof OfficeMonitorTransform;
  label: string;
  decLabel: string;
  incLabel: string;
  format: (value: number) => string;
}

function formatSignedMeters(value: number): string {
  const normalized = value === 0 ? 0 : value;
  const sign = normalized >= 0 ? '+' : '';
  return `${sign}${normalized.toFixed(2)}m`;
}

function formatYawDegrees(yawRad: number): string {
  return `${Math.round((yawRad * 180) / Math.PI)}°`;
}

const AXIS_STEPPERS: ReadonlyArray<AxisStepperSpec> = [
  {
    axis: 'x',
    label: 'X',
    decLabel: '向左移动显示器 (减小 X)',
    incLabel: '向右移动显示器 (增大 X)',
    format: formatSignedMeters,
  },
  {
    axis: 'y',
    label: 'Y',
    decLabel: '降低显示器高度 (减小 Y)',
    incLabel: '升高显示器高度 (增大 Y)',
    format: formatSignedMeters,
  },
  {
    axis: 'z',
    label: 'Z',
    decLabel: '向后推显示器 (减小 Z)',
    incLabel: '向前拉显示器 (增大 Z)',
    format: formatSignedMeters,
  },
  {
    axis: 'yaw',
    label: '角',
    decLabel: '顺时针微调显示器偏航角',
    incLabel: '逆时针微调显示器偏航角',
    format: formatYawDegrees,
  },
];

function isTransformAdjusted(transform: OfficeMonitorTransform): boolean {
  return (
    Math.abs(transform.x) > 1e-4 ||
    Math.abs(transform.y) > 1e-4 ||
    Math.abs(transform.z) > 1e-4 ||
    Math.abs(transform.yaw) > 1e-4
  );
}

interface AxisStepperProps {
  spec: AxisStepperSpec;
  value: number;
  onStep: (axis: keyof OfficeMonitorTransform, delta: number) => void;
}

function AxisStepper({ spec, value, onStep }: AxisStepperProps) {
  const bounds = OFFICE_MONITOR_TRANSFORM_BOUNDS[spec.axis];
  const atMin = value <= bounds.min;
  const atMax = value >= bounds.max;
  return (
    <div className="office-monitor-stepper">
      <span className="office-monitor-stepper-label">{spec.label}</span>
      <button
        type="button"
        className="office-monitor-step-btn"
        aria-label={spec.decLabel}
        disabled={atMin}
        onClick={() => onStep(spec.axis, -bounds.step)}
      >
        <MinusOutlined aria-hidden="true" />
      </button>
      <span className="office-monitor-stepper-val">{spec.format(value)}</span>
      <button
        type="button"
        className="office-monitor-step-btn"
        aria-label={spec.incLabel}
        disabled={atMax}
        onClick={() => onStep(spec.axis, bounds.step)}
      >
        <PlusOutlined aria-hidden="true" />
      </button>
    </div>
  );
}

export function OfficeMonitorControls({
  dualMonitor,
  activeMonitorIndex,
  dragMode,
  transform,
  onToggleDualMonitor,
  onSelectMonitorIndex,
  onChangeDragMode,
  onStepAxis,
  onResetMonitors,
  onDone,
}: OfficeMonitorControlsProps) {
  const effectiveMonitorIndex: OfficeMonitorIndex = dualMonitor && activeMonitorIndex === 1 ? 1 : 0;
  const adjusted = useMemo(() => isTransformAdjusted(transform), [transform]);

  return (
    <div className="office-monitor-editor" role="region" aria-label="3D 显示器位置与双屏调节">
      <div className="office-monitor-editor-row">
        <div className="office-monitor-controls-cluster">
          <div className="office-monitor-field">
            <span className="office-monitor-field-label">
              {dualMonitor ? <SplitCellsOutlined aria-hidden="true" /> : <DesktopOutlined aria-hidden="true" />}
              <span>布局</span>
            </span>
            <div className="office-monitor-editor-group" role="group" aria-label="屏幕数量切换">
              <button
                type="button"
                className={`office-monitor-seg-btn${!dualMonitor ? ' is-active' : ''}`}
                aria-pressed={!dualMonitor}
                onClick={() => onToggleDualMonitor(false)}
              >
                单屏
              </button>
              <button
                type="button"
                className={`office-monitor-seg-btn${dualMonitor ? ' is-active' : ''}`}
                aria-pressed={dualMonitor}
                onClick={() => onToggleDualMonitor(true)}
              >
                双屏
              </button>
            </div>
          </div>

          {dualMonitor ? (
            <div className="office-monitor-field">
              <span className="office-monitor-field-label">屏幕</span>
              <div className="office-monitor-editor-group" role="group" aria-label="目标显示器">
                <button
                  type="button"
                  className={`office-monitor-seg-btn${effectiveMonitorIndex === 0 ? ' is-active' : ''}`}
                  aria-pressed={effectiveMonitorIndex === 0}
                  onClick={() => onSelectMonitorIndex(0)}
                >
                  主屏 #1
                </button>
                <button
                  type="button"
                  className={`office-monitor-seg-btn${effectiveMonitorIndex === 1 ? ' is-active' : ''}`}
                  aria-pressed={effectiveMonitorIndex === 1}
                  onClick={() => onSelectMonitorIndex(1)}
                >
                  副屏 #2
                </button>
              </div>
            </div>
          ) : null}

          <div className="office-monitor-field">
            <span className="office-monitor-field-label">
              <DragOutlined aria-hidden="true" />
              <span>拖拽</span>
            </span>
            <div className="office-monitor-editor-group" role="group" aria-label="3D 拖拽轴向">
              {DRAG_MODE_OPTIONS.map((item) => (
                <button
                  key={item.mode}
                  type="button"
                  className={`office-monitor-seg-btn${dragMode === item.mode ? ' is-active' : ''}`}
                  aria-pressed={dragMode === item.mode}
                  onClick={() => onChangeDragMode(item.mode)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="office-monitor-editor-actions">
          <SettingStatusTag
            status={adjusted ? 'dirty' : 'applied'}
            label={adjusted ? '已偏移' : '默认位'}
            compact
          />
          <AppButton
            size="small"
            icon={<UndoOutlined />}
            disableDebounce
            onClick={onResetMonitors}
            aria-label="重置显示器位置"
          >
            重置
          </AppButton>
          <AppButton
            size="small"
            type="primary"
            icon={<CheckOutlined />}
            disableDebounce
            onClick={onDone}
            aria-label="退出显示器调整模式"
          >
            完成
          </AppButton>
        </div>
      </div>

      <div className="office-monitor-steppers" role="group" aria-label="精确坐标微调">
        {AXIS_STEPPERS.map((spec) => (
          <AxisStepper
            key={spec.axis}
            spec={spec}
            value={transform[spec.axis]}
            onStep={onStepAxis}
          />
        ))}
      </div>
    </div>
  );
}

export default OfficeMonitorControls;

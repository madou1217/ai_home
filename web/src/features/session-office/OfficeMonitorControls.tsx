import {
  CheckOutlined,
  MinusOutlined,
  PlusOutlined,
  UndoOutlined,
} from '@ant-design/icons';
import { Button } from 'antd';
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
  { mode: 'xz', label: '平面拖拽' },
  { mode: 'y', label: '高度拖拽' },
  { mode: 'yaw', label: '朝向旋转' },
];

function formatSignedMeters(value: number): string {
  const normalized = value === 0 ? 0 : value;
  const sign = normalized >= 0 ? '+' : '';
  return `${sign}${normalized.toFixed(2)}m`;
}

function formatYawDegrees(yawRad: number): string {
  return `${Math.round((yawRad * 180) / Math.PI)}°`;
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

  return (
    <div className="office-monitor-editor" role="region" aria-label="3D 显示器位置与双屏调节">
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

      {dualMonitor ? (
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
      ) : null}

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

      <div className="office-monitor-steppers" role="group" aria-label="精确坐标微调">
        <div className="office-monitor-stepper">
          <span className="office-monitor-stepper-label">X</span>
          <button
            type="button"
            className="office-monitor-step-btn"
            aria-label="向左移动显示器 (减小 X)"
            disabled={transform.x <= OFFICE_MONITOR_TRANSFORM_BOUNDS.x.min}
            onClick={() => onStepAxis('x', -OFFICE_MONITOR_TRANSFORM_BOUNDS.x.step)}
          >
            <MinusOutlined aria-hidden="true" />
          </button>
          <span className="office-monitor-stepper-val">
            {formatSignedMeters(transform.x)}
          </span>
          <button
            type="button"
            className="office-monitor-step-btn"
            aria-label="向右移动显示器 (增大 X)"
            disabled={transform.x >= OFFICE_MONITOR_TRANSFORM_BOUNDS.x.max}
            onClick={() => onStepAxis('x', OFFICE_MONITOR_TRANSFORM_BOUNDS.x.step)}
          >
            <PlusOutlined aria-hidden="true" />
          </button>
        </div>

        <div className="office-monitor-stepper">
          <span className="office-monitor-stepper-label">Y</span>
          <button
            type="button"
            className="office-monitor-step-btn"
            aria-label="降低显示器高度 (减小 Y)"
            disabled={transform.y <= OFFICE_MONITOR_TRANSFORM_BOUNDS.y.min}
            onClick={() => onStepAxis('y', -OFFICE_MONITOR_TRANSFORM_BOUNDS.y.step)}
          >
            <MinusOutlined aria-hidden="true" />
          </button>
          <span className="office-monitor-stepper-val">
            {formatSignedMeters(transform.y)}
          </span>
          <button
            type="button"
            className="office-monitor-step-btn"
            aria-label="升高显示器高度 (增大 Y)"
            disabled={transform.y >= OFFICE_MONITOR_TRANSFORM_BOUNDS.y.max}
            onClick={() => onStepAxis('y', OFFICE_MONITOR_TRANSFORM_BOUNDS.y.step)}
          >
            <PlusOutlined aria-hidden="true" />
          </button>
        </div>

        <div className="office-monitor-stepper">
          <span className="office-monitor-stepper-label">Z</span>
          <button
            type="button"
            className="office-monitor-step-btn"
            aria-label="向后推显示器 (减小 Z)"
            disabled={transform.z <= OFFICE_MONITOR_TRANSFORM_BOUNDS.z.min}
            onClick={() => onStepAxis('z', -OFFICE_MONITOR_TRANSFORM_BOUNDS.z.step)}
          >
            <MinusOutlined aria-hidden="true" />
          </button>
          <span className="office-monitor-stepper-val">
            {formatSignedMeters(transform.z)}
          </span>
          <button
            type="button"
            className="office-monitor-step-btn"
            aria-label="向前拉显示器 (增大 Z)"
            disabled={transform.z >= OFFICE_MONITOR_TRANSFORM_BOUNDS.z.max}
            onClick={() => onStepAxis('z', OFFICE_MONITOR_TRANSFORM_BOUNDS.z.step)}
          >
            <PlusOutlined aria-hidden="true" />
          </button>
        </div>

        <div className="office-monitor-stepper">
          <span className="office-monitor-stepper-label">角</span>
          <button
            type="button"
            className="office-monitor-step-btn"
            aria-label="顺时针微调显示器偏航角"
            disabled={transform.yaw <= OFFICE_MONITOR_TRANSFORM_BOUNDS.yaw.min}
            onClick={() => onStepAxis('yaw', -OFFICE_MONITOR_TRANSFORM_BOUNDS.yaw.step)}
          >
            <MinusOutlined aria-hidden="true" />
          </button>
          <span className="office-monitor-stepper-val">
            {formatYawDegrees(transform.yaw)}
          </span>
          <button
            type="button"
            className="office-monitor-step-btn"
            aria-label="逆时针微调显示器偏航角"
            disabled={transform.yaw >= OFFICE_MONITOR_TRANSFORM_BOUNDS.yaw.max}
            onClick={() => onStepAxis('yaw', OFFICE_MONITOR_TRANSFORM_BOUNDS.yaw.step)}
          >
            <PlusOutlined aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="office-monitor-editor-actions">
        <Button
          size="small"
          icon={<UndoOutlined />}
          onClick={onResetMonitors}
          aria-label="重置显示器位置"
        >
          重置
        </Button>
        <Button
          size="small"
          type="primary"
          icon={<CheckOutlined />}
          onClick={onDone}
          aria-label="退出显示器调整模式"
        >
          完成
        </Button>
      </div>
    </div>
  );
}

export default OfficeMonitorControls;

import { useEffect, useRef } from 'react';
import { BarChart, LineChart } from 'echarts/charts';
import {
  AriaComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent
} from 'echarts/components';
import * as echarts from 'echarts/core';
import type { EChartsCoreOption, EChartsType } from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([
  AriaComponent,
  BarChart,
  GridComponent,
  LegendComponent,
  LineChart,
  TooltipComponent,
  CanvasRenderer
]);

export interface UsageChartPalette {
  heading: string;
  text: string;
  muted: string;
  border: string;
  brand: string;
  teal: string;
  amber: string;
  blue: string;
  violet: string;
  danger: string;
}

interface EChartCanvasProps {
  ariaLabel: string;
  buildOption: (palette: UsageChartPalette) => EChartsCoreOption;
  onDataClick?: (dataIndex: number) => void;
}

function readCssVariable(element: HTMLElement, name: string, fallback: string) {
  const value = getComputedStyle(element).getPropertyValue(name).trim();
  return value || fallback;
}

function readPalette(element: HTMLElement): UsageChartPalette {
  const isDark = document.body.classList.contains('dark') || document.documentElement.getAttribute('data-theme') === 'dark';
  return {
    heading: readCssVariable(element, '--color-heading', isDark ? '#f8fafc' : '#0f172a'),
    text: readCssVariable(element, '--color-text', isDark ? '#e2e8f0' : '#334155'),
    muted: readCssVariable(element, '--color-muted', isDark ? '#94a3b8' : '#64748b'),
    border: readCssVariable(element, '--color-border', isDark ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.08)'),
    brand: readCssVariable(element, '--color-brand', '#0a59f7'),
    teal: readCssVariable(element, '--c-teal-500', '#10b981'),
    amber: readCssVariable(element, '--color-warning', '#f59e0b'),
    blue: readCssVariable(element, '--color-info', '#3b82f6'),
    violet: readCssVariable(element, '--c-violet-500', '#8b5cf6'),
    danger: readCssVariable(element, '--color-danger', '#ef4444')
  };
}

export default function EChartCanvas({ ariaLabel, buildOption, onDataClick }: EChartCanvasProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<EChartsType | null>(null);
  const onDataClickRef = useRef(onDataClick);

  onDataClickRef.current = onDataClick;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const chart = echarts.init(host, undefined, {
      renderer: 'canvas',
      devicePixelRatio: Math.min(window.devicePixelRatio || 1, 2)
    });
    chartRef.current = chart;
    const handleClick = (event: { dataIndex?: number }) => {
      const dataIndex = Number(event?.dataIndex);
      if (Number.isInteger(dataIndex)) onDataClickRef.current?.(dataIndex);
    };
    chart.on('click', handleClick);
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(host);
    return () => {
      observer.disconnect();
      chart.off('click', handleClick);
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    const chart = chartRef.current;
    if (!host || !chart) return;
    chart.setOption(buildOption(readPalette(host)), { notMerge: true, lazyUpdate: true });
  }, [buildOption]);

  return <div ref={hostRef} className="usage-chart-canvas" role="img" aria-label={ariaLabel} />;
}

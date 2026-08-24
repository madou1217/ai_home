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
  return {
    heading: readCssVariable(element, '--color-heading', '#172033'),
    text: readCssVariable(element, '--color-text', '#334155'),
    muted: readCssVariable(element, '--color-muted', '#718096'),
    border: readCssVariable(element, '--color-border', '#d9e1ea'),
    brand: readCssVariable(element, '--color-brand', '#2563eb'),
    teal: readCssVariable(element, '--c-teal-500', '#0f9f8f'),
    amber: readCssVariable(element, '--color-warning', '#d97706'),
    blue: readCssVariable(element, '--color-info', '#0284c7'),
    violet: readCssVariable(element, '--c-violet-500', '#7c3aed'),
    danger: readCssVariable(element, '--color-danger', '#dc2626')
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

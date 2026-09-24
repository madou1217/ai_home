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
  /** 浮层（tooltip）底色：随主题翻转的 raised 表面 */
  surface: string;
  /** 中性占位系列（例如「其他」条形） */
  neutral: string;
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

/**
 * 渲染时从 CSS 变量读取图表配色（design-tokens.css），轴线 / 网格 / 文字随主题翻转；
 * 第二个参数只是变量缺失（如测试环境）时的兜底值，取自同一套 token 的浅 / 深色取值。
 */
function readPalette(element: HTMLElement): UsageChartPalette {
  const isDark = document.body.classList.contains('dark') || document.documentElement.getAttribute('data-theme') === 'dark';
  return {
    heading: readCssVariable(element, '--color-heading', isDark ? '#fafafa' : '#18181b'),
    text: readCssVariable(element, '--color-text', isDark ? '#e4e4e7' : '#27272a'),
    muted: readCssVariable(element, '--color-muted', isDark ? '#a1a1aa' : '#71717a'),
    border: readCssVariable(element, '--color-border', isDark ? '#2b2b31' : '#e3e3e7'),
    surface: readCssVariable(element, '--color-surface-raised', isDark ? '#1e1e22' : '#fcfcfc'),
    neutral: readCssVariable(element, '--color-disabled', isDark ? '#5b5b63' : '#d1d1d6'),
    brand: readCssVariable(element, '--color-accent', isDark ? '#7b9cff' : '#2f5bd3'),
    teal: readCssVariable(element, '--c-teal-500', '#0d9488'),
    amber: readCssVariable(element, '--color-warning', isDark ? '#e0a94a' : '#b45309'),
    blue: readCssVariable(element, '--c-info-500', '#4a72e0'),
    violet: readCssVariable(element, '--c-purple-500', '#8b5cf6'),
    danger: readCssVariable(element, '--color-danger', isDark ? '#f07068' : '#c2322b')
  };
}

/** 统一的 tooltip 外观：不透明 raised 表面 + 发丝线描边，文字随主题翻转。 */
export function buildChartTooltipStyle(palette: UsageChartPalette) {
  return {
    backgroundColor: palette.surface,
    borderColor: palette.border,
    borderWidth: 1,
    textStyle: { color: palette.text, fontSize: 12 },
    extraCssText: 'box-shadow: var(--elevation-3); border-radius: var(--hos-radius-sm);'
  };
}

export default function EChartCanvas({ ariaLabel, buildOption, onDataClick }: EChartCanvasProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<EChartsType | null>(null);
  const onDataClickRef = useRef(onDataClick);
  const buildOptionRef = useRef(buildOption);

  onDataClickRef.current = onDataClick;
  buildOptionRef.current = buildOption;

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
    // 主题切换（html[data-theme] / body.dark）后重新读取 CSS 变量并重绘，轴线与文字跟随主题。
    const themeObserver = new MutationObserver(() => {
      chart.setOption(buildOptionRef.current(readPalette(host)), { notMerge: true, lazyUpdate: true });
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    return () => {
      observer.disconnect();
      themeObserver.disconnect();
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

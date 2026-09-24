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
import { readThemeMode } from '@/services/theme-mode';

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
  /** 轴标签 / 次要刻度：HUD faint 文字 */
  faint: string;
  border: string;
  /** 浮层（tooltip）底色：随主题翻转的 raised 表面 */
  surface: string;
  /** 中性占位系列（例如「其他」条形） */
  neutral: string;
  /** Electric Cyan：主系列（输入 / Tokens 条形） */
  brand: string;
  /** Matrix Green：成功 / 金额类系列（成本、缓存读取） */
  success: string;
  /** Amber：缓存写入、缓存命中率 */
  amber: string;
  /** Rose：输出 */
  danger: string;
  /** 推理系列：与事件块「思考」同一语义色（--event-thinking） */
  violet: string;
  /** 轴 / 图例 / tooltip 的等宽数据字体栈（--font-mono 的实际取值，canvas 不能解析 var()） */
  fontMono: string;
  /** 深色 HUD 下系列线条的辉光半径；日光主题为 0（不发光） */
  glow: number;
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
 * 渲染时从 CSS 变量读取图表配色（design-tokens.css），轴线 / 网格 / 文字 / 系列色随主题翻转；
 * 第二个参数只是变量缺失（如测试环境）时的兜底值，取自同一套 HUD token 的日光 / 深色取值。
 */
function readPalette(element: HTMLElement): UsageChartPalette {
  const isDark = readThemeMode() === 'dark' || document.body.classList.contains('dark');
  return {
    heading: readCssVariable(element, '--color-heading', isDark ? '#f2fbff' : '#07121f'),
    text: readCssVariable(element, '--color-text', isDark ? '#e2f1f8' : '#13233a'),
    muted: readCssVariable(element, '--color-muted', isDark ? '#7f9bb3' : '#4f6a83'),
    faint: readCssVariable(element, '--color-faint', isDark ? '#5c7890' : '#6f879c'),
    border: readCssVariable(element, '--color-border', isDark ? '#15263d' : '#cbd8e3'),
    surface: readCssVariable(element, '--color-surface-raised', isDark ? '#0c1524' : '#f7fafc'),
    neutral: readCssVariable(element, '--color-disabled', isDark ? '#3a5068' : '#aabdcd'),
    brand: readCssVariable(element, '--color-accent', isDark ? '#00f0ff' : '#0086a0'),
    success: readCssVariable(element, '--color-success', isDark ? '#00ff66' : '#00874a'),
    amber: readCssVariable(element, '--color-warning', isDark ? '#ffaa00' : '#b86e00'),
    danger: readCssVariable(element, '--color-danger', isDark ? '#ff0055' : '#c20042'),
    violet: readCssVariable(element, '--event-thinking', isDark ? '#c38bff' : '#7c3aed'),
    fontMono: readCssVariable(element, '--font-mono', "'JetBrains Mono', ui-monospace, monospace"),
    glow: isDark ? 8 : 0
  };
}

/** 统一的 tooltip 外观：HUD 浮层 —— 不透明 raised 表面 + 青色发丝框 + 辉光，等宽数据字体，方角。 */
export function buildChartTooltipStyle(palette: UsageChartPalette) {
  return {
    backgroundColor: palette.surface,
    borderColor: palette.brand,
    borderWidth: 1,
    textStyle: { color: palette.text, fontSize: 12, fontFamily: palette.fontMono },
    extraCssText: 'box-shadow: var(--elevation-3), var(--hud-glow-accent); border-radius: 0; font-family: var(--font-mono);'
  };
}

/** 所有图表统一的等宽数据字体（轴标签、图例、数值）——在各图 option 之上兜底注入。 */
function withHudTextStyle(option: EChartsCoreOption, palette: UsageChartPalette): EChartsCoreOption {
  const base = (option as { textStyle?: Record<string, unknown> }).textStyle || {};
  return { ...option, textStyle: { fontFamily: palette.fontMono, ...base } };
}

function renderOption(chart: EChartsType, host: HTMLElement, build: (palette: UsageChartPalette) => EChartsCoreOption) {
  const palette = readPalette(host);
  chart.setOption(withHudTextStyle(build(palette), palette), { notMerge: true, lazyUpdate: true });
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
      renderOption(chart, host, buildOptionRef.current);
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
    renderOption(chart, host, buildOption);
  }, [buildOption]);

  return <div ref={hostRef} className="usage-chart-canvas" role="img" aria-label={ariaLabel} />;
}

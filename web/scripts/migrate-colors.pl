#!/usr/bin/env perl
# 将组件 CSS 里的硬编码颜色吸附到 design-tokens.css 的 token。
# 用法: perl migrate-colors.pl <file.css>
# 十六进制用负向前瞻 (?![0-9a-fA-F]) 防止短值匹配进长值，顺序无关。
use strict; use warnings;

# value(lowercase hex, no trailing word-char) => token
my @hex = (
  # white / near-white
  ['ffffff','var(--c-neutral-0)'], ['fff','var(--c-neutral-0)'],
  ['fbfcfe','var(--c-neutral-25)'], ['f9fbff','var(--c-neutral-25)'],
  # L50
  ['f8fafc','var(--c-neutral-50)'], ['f7f9fc','var(--c-neutral-50)'],
  ['f7f8fa','var(--c-neutral-50)'], ['f6f8fb','var(--c-neutral-50)'],
  ['f5f5f5','var(--c-neutral-50)'],
  # L100
  ['f3f4f6','var(--c-neutral-100)'], ['f1f5f9','var(--c-neutral-100)'],
  ['eef2f6','var(--c-neutral-100)'],
  # L200
  ['e8edf3','var(--c-neutral-200)'], ['e8e8e8','var(--c-neutral-200)'],
  ['e5e7eb','var(--c-neutral-200)'], ['e4eaf2','var(--c-neutral-200)'],
  ['e1e7ef','var(--c-neutral-200)'], ['e0e0e0','var(--c-neutral-200)'],
  ['dfe5ee','var(--c-neutral-200)'], ['dbe3ee','var(--c-neutral-200)'],
  # L300
  ['d8dee8','var(--c-neutral-300)'], ['d7dee8','var(--c-neutral-300)'],
  ['d0d7e2','var(--c-neutral-300)'], ['d0d5dd','var(--c-neutral-300)'],
  ['c8d2df','var(--c-neutral-300)'], ['c9d1d9','var(--c-neutral-300)'],
  ['c0c7d1','var(--c-neutral-300)'], ['b6bdc7','var(--c-neutral-300)'],
  # L400
  ['98a2b3','var(--c-neutral-400)'], ['9ca3af','var(--c-neutral-400)'],
  ['94a3b8','var(--c-neutral-400)'], ['bbb','var(--c-neutral-400)'],
  # L500
  ['667085','var(--ink-neutral)'],
  ['6b7280','var(--c-neutral-500)'], ['64748b','var(--c-neutral-500)'],
  ['999','var(--c-neutral-500)'], ['7a7a7a','var(--c-neutral-500)'],
  # L600
  ['475467','var(--c-neutral-600)'], ['475569','var(--c-neutral-600)'],
  ['4b5563','var(--c-neutral-600)'], ['666','var(--c-neutral-600)'],
  # L700
  ['344054','var(--c-neutral-700)'], ['334155','var(--c-neutral-700)'],
  ['374151','var(--c-neutral-700)'],
  # L800
  ['27364a','var(--c-neutral-800)'], ['253145','var(--c-neutral-800)'],
  ['263445','var(--c-neutral-800)'], ['1f2a37','var(--c-neutral-800)'],
  ['1f2937','var(--c-neutral-800)'], ['333','var(--c-neutral-800)'],
  # L900
  ['111827','var(--c-neutral-900)'], ['0f172a','var(--c-neutral-900)'],
  # accents / status text
  ['2f5aa8','var(--c-accent-blue)'], ['35a06f','var(--c-accent-green)'],
  ['1d4ed8','var(--c-info-600)'], ['1890ff','var(--c-info-500)'],
  ['60a5fa','var(--c-info-500)'], ['4f46e5','var(--c-accent-blue)'],
  ['eef4ff','var(--tint-info)'], ['eef2ff','var(--tint-info)'],
  ['f2f4f7','var(--tint-neutral)'],
  ['257348','var(--ink-success)'], ['067647','var(--ink-success)'],
  ['24764b','var(--ink-success)'],
  ['f3fbf6','var(--tint-success)'], ['e8f7f0','var(--tint-success)'],
  ['ecfdf3','var(--tint-success)'],
  ['c9ead8','var(--bd-success)'], ['9bd3b4','var(--bd-success)'],
  ['9a5a00','var(--ink-warning)'], ['d98a00','var(--c-warning-500)'],
  ['fff7e6','var(--tint-warning)'],
  ['b42318','var(--ink-danger)'], ['d92d20','var(--c-danger-600)'],
  ['cf1322','var(--c-danger-600)'], ['ff4d4f','var(--c-danger-500)'],
  ['991b1b','var(--c-danger-600)'], ['b91c1c','var(--c-danger-600)'],
  ['fff1f0','var(--tint-danger)'], ['fff2f0','var(--tint-danger)'],
  ['ffccc7','var(--bd-danger)'],
  # extra neutrals / tints seen in page CSS
  ['e2e8f0','var(--c-neutral-200)'], ['dce5f0','var(--c-neutral-200)'],
  ['f8fbff','var(--c-neutral-25)'],
  ['eef6ff','var(--tint-info)'], ['f4f6ff','var(--tint-info)'],
  ['edf3ff','var(--tint-info)'], ['fff7ed','var(--tint-warning)'],
);

# rgba(R,G,B,A) => color-mix(in srgb, TOKEN A%, transparent)
# 精确等价：srgb 下与 transparent 按 A 混合，结果即 rgba(R,G,B,A)。内部空格随意。
my @rgba = (
  [47,90,168,  'var(--c-accent-blue)'],
  [53,160,111, 'var(--c-accent-green)'],
  [47,128,255, 'var(--c-info-500)'],
  [148,163,184,'var(--c-neutral-400)'],
  [100,116,139,'var(--c-neutral-500)'],
  [71,85,105,  'var(--c-neutral-600)'],
  [51,65,85,   'var(--c-neutral-700)'],
  [15,23,42,   'var(--c-neutral-900)'],
  [226,232,240,'var(--c-neutral-200)'],
  [241,245,249,'var(--c-neutral-100)'],
  [238,242,246,'var(--c-neutral-100)'],
  [203,213,225,'var(--c-neutral-300)'],
  [255,255,255,'var(--c-neutral-0)'],
  [0,0,0,      'var(--c-brand-900)'],
  [23,23,23,   'var(--c-brand-600)'],
  [244,246,248,'var(--c-neutral-50)'],
  [17,24,39,   'var(--c-neutral-900)'],
  [17,20,24,   'var(--c-neutral-900)'],
  [220,38,38,  'var(--c-danger-600)'],
  [14,159,154, 'var(--c-teal-500)'],
  [15,118,110, 'var(--c-teal-500)'],
  [216,226,236,'var(--c-neutral-200)'],
  [216,208,195,'var(--c-neutral-300)'],
  [183,121,31, 'var(--c-warning-600)'],
  [49,87,255,  'var(--c-info-600)'],
  [36,87,255,  'var(--c-info-600)'],
);

local $/; my $css = <>;
for my $p (@hex) {
  my ($v,$t) = @$p;
  $css =~ s/#\Q$v\E(?![0-9a-fA-F])/$t/gi;
}
for my $p (@rgba) {
  my ($r,$g,$b,$tok) = @$p;
  my $re = qr/rgba\(\s*\Q$r\E\s*,\s*\Q$g\E\s*,\s*\Q$b\E\s*,\s*([0-9.]+)\s*\)/;
  $css =~ s/$re/"color-mix(in srgb, $tok " . (0+$1)*100 . "%, transparent)"/ge;
}
print $css;

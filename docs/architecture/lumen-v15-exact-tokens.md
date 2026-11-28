# V15 exact visual tokens (curated, verified against the HTML rules)

Source: `docs/design/v15/paste-lumen-v15.html`. Automated cascade merging was
unreliable (state/variant selectors leak), so this sheet is curated from the
actual rule text. Each block names the winning selector(s). Native code must use
these numbers verbatim; the previous auto-extracted card block (19px radius,
140deg background) is superseded.

## Orbit card

Winning selectors: `.clip` (base) + `.rail .clip.v10card` (later, higher
specificity) + `.shared-orbit .rail-item .clip.v10card` (V15 block).

```css
width: clamp(166px, 14.3vw, 220px);   /* 14.3% of the rail viewport width */
min-height: 148px;
max-height: 242px;
border-radius: 16px;
border: 1px solid #ffffff95;
background: linear-gradient(155deg, #fbfdfff5, #e2eaf6ed);
box-shadow: 0 6px 18px #142a4220;
color: #20324b;
display: flex; flex-direction: column; gap: 0;
overflow: hidden;
padding: 0;
```

Dark (`.dark .clip.v10card`):

```css
background: linear-gradient(145deg, #344660ef, #202e44f2);
color: #eaf1ff;
border-color: #9fb8df4a;
```

Lift (V15 block; the same variable drives the close button):

```css
--v15-lift: 0px;            /* near: -2px; hover/focus-within: -5px; selected: -7px */
--v15-lift-time: 320ms;
--v15-lift-ease: cubic-bezier(.2, .9, .25, 1.2);
```

## Orbit card header

```css
height: 34px; min-height: 34px; flex: 0 0 34px;
padding: 0 12px;
align-items: center;
gap: 7px;
font-size: 10px;
color: #61728a;
white-space: nowrap;
transition: padding-right 210ms cubic-bezier(.22, .8, .22, 1) 100ms;
/* hover / focus-within */
padding-right: 43px;
transition-delay: 0ms;
```

Dark: `color: #a9bbd4`.

## Orbit card time

```css
margin-left: auto;
font-size: 10.5px;
font-variant-numeric: tabular-nums;
white-space: nowrap;
```

## Orbit card footer

```css
padding: 8px 12px 10px;
display: flex; align-items: center; gap: 6px;
font-size: 10px;
color: #78869d;
min-height: 31px;
white-space: nowrap;
```

## Orbit close (remove history entry)

V15 block wins over the earlier `.clip-remove` rules.

```css
/* hit target, sibling of the card surface */
position: absolute; right: 7px; top: calc(4px + var(--v15-lift));
width: 28px; height: 28px; border-radius: 50%;
border: 0; background: none; box-shadow: none;
color: #53647b; display: grid; place-items: center;
transform: scale(.80); transform-origin: center;
opacity: 0; pointer-events: none;
transition: top var(--v15-lift-time) var(--v15-lift-ease),
            opacity 100ms, transform 240ms cubic-bezier(.2,.8,.2,1),
            color 160ms;

/* the 22x22 visual circle */
::before { inset: 3px; border-radius: 50%;
  background: linear-gradient(145deg, #f9fbffff, #e4ebf6f0);
  box-shadow: inset 0 0 0 .6px #ffffffef, 0 1px 4px #243b5c22; }

/* glyph */
.ico { width: 13px; height: 13px; stroke-width: 1.9; stroke-linecap: round; }

/* hover / focus-within */
opacity: 1; pointer-events: auto; transform: scale(1);
transition-delay: 0ms, 145ms, 85ms, 0ms;
:hover      { color: #a63e55; transform: scale(1.08); }
:hover::before { background: #fff1f3; box-shadow: inset 0 0 0 .6px #fff, 0 2px 7px #b9698130; }
:hover .ico { transform: rotate(90deg) scale(.95); }
:active     { transform: scale(.88) !important; }
:focus-visible { outline: 2px solid #6c9eff; outline-offset: 1px; }
```

Dark: `color: #d9e5f6`; `::before` gradient `#53637b → #394960`, inset
`#c1d4ef55`, shadow `0 1px 5px #080f252e`; hover `#ffe0e6`, `::before #644454`.

## Optical dots

Column width 38. Each dot button is `width: 38px; height: var(--step)`
(`--step` = column height / 5) and only the middle glyph is visible:

```css
i { width: 5px; height: 5px; border-radius: 50%;
    background: #e7f3ff; opacity: .24; scale: .78;
    transition: scale 320ms cubic-bezier(.2,.75,.2,1), opacity 260ms, background 260ms; }
.type-dot.on i { background: #f5faff; scale: 1.12; opacity: .43;
                 box-shadow: 0 0 5px #e1f4ff50; }
```

Hover bubble:

```css
left: 37px; top: 0;
transform: translate(-5px, calc(var(--bubble-i,0) * var(--step) - 4px));
background: #f5f9ffed; border: 1px solid #ffffffb0; color: #415a7d;
border-radius: 9px; padding: 5px 10px; font-size: 11px; font-weight: 600;
box-shadow: 0 5px 18px #142d5140; opacity: 0;
transition: opacity .18s, transform .28s cubic-bezier(.18,.85,.25,1);
/* V15 refinements */ border: 0; border-radius: 7px; padding: 6px 9px;
box-shadow: 0 6px 18px #1d36552c; font-weight: 500;
```

Dark bubble: `background: #263b58ef; color: #e8f3ff; border-color: #b2cced66`.

## Rail container

```css
display: flex; align-items: center; gap: 13px;
width: 100%; height: 100%;
padding: 27px 25px 21px;
/* V15 rail adjustments */
margin-left: 38px; padding-left: 12px; scroll-padding-left: 12px;
padding-top: 22px; padding-bottom: 15px;
overflow-x: auto; overflow-y: hidden; scrollbar-width: none;
```

## Library surfaces (to be curated in phase B)

The earlier auto-extracted App values are indicative only; phase B must repeat
this same selector-by-selector curation before touching the Library UI.
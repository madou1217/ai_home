# V15 从 HTML 提取的精确视觉 token（最终生效值）

来源：`docs/design/v15/paste-lumen-v15.html` 的全部 <style> 块，按文档顺序合并同名选择器的最终值。
原生实现必须逐项采用这些数值（DIP=CSS px），不得近似；系统装饰（标题栏/交通灯）除外。

## Orbit 外壳 .shared-orbit

```css
--orbit-card-w: clamp(178px,14.2vw,222px);
--orbit-card-max: 246px;
--orbit-gap: 12px;
```

## Orbit 轨道 .shared-orbit .rail

```css
position: relative;
z-index: 1;
gap: 13px;
touch-action: pan-x;
user-select: none;
width: 100%;
margin-left: 38px;
padding-left: 12px;
scroll-padding-left: 12px;
padding-top: 22px;
padding-bottom: 15px;
display: flex;
align-items: center;
height: 100%;
padding: 27px 25px 21px;
overflow-x: auto;
overflow-y: hidden;
scrollbar-width: none;
overscroll-behavior: contain;
scroll-padding: 25px;
perspective: none;
```

## Orbit 卡片 .clip.v10card

```css
transition: transform .32s cubic-bezier(.2,.9,.25,1.2),box-shadow .3s,border .25s,opacity .25s;
position: relative;
flex: 0 0 auto;
width: clamp(166px,14.3vw,220px);
height: 100%;
max-height: 242px;
min-height: 148px;
border: 1px solid #ffffff70;
border-radius: 19px;
background: linear-gradient(140deg,#fcfdffeF,#e9f1fbe0 60%,#dce7f6e0);
box-shadow: 0 9px 25px #0b1d3924,inset 0 1px 1px #fff9;
display: flex;
flex-direction: column;
overflow: hidden;
text-align: left;
color: #26344e;
padding: 0;
transform-origin: center 90%;
outline: none;
--shine-x: 50%;
--shine-y: 0%;
isolation: isolate;
cursor: pointer;
```

## Orbit 头部 .clip-head

```css
height: 34px;
min-height: 34px;
flex: 0 0 34px;
padding: 12px 12px 9px;
align-items: center;
transition: padding-right 210ms cubic-bezier(.22,.8,.22,1) 100ms;
display: flex;
gap: 7px;
font-size: 10px;
color: #61728a;
white-space: nowrap;
```

## Orbit 类型 .v10kind

```css
min-width: 0;
overflow: hidden;
text-overflow: ellipsis;
white-space: nowrap;
flex: 0 1 auto;
font-weight: 550;
font-size: 11px;
letter-spacing: 0;
color: #526984;
```

Dark:
```css
color: #b4c6dd;
```

## Orbit 时间 .time

```css
margin-left: auto;
font-size: 10.5px;
font-variant-numeric: tabular-nums;
white-space: nowrap;
```

## Orbit 移除按钮 .clip-remove

```css
top: 7px;
right: 8px;
width: 28px;
height: 28px;
border: 1px solid #ffffffd9;
border-radius: 50%;
background: radial-gradient(circle at 32% 18%,#fff,#e8f1fbdc 80%);
box-shadow: 0 2px 9px #233b6026,inset 0 1px 1px white;
color: #4c6079;
display: grid;
place-items: center;
isolation: isolate;
transform: translateY(1px) scale(.75);
transform-origin: center;
opacity: 0;
transition: opacity .19s,transform .28s cubic-bezier(.19,1,.24,1.15),background .2s,color .2s,box-shadow .25s;
pointer-events: none;
position: absolute;
z-index: 7;
padding: 0;
```

Dark:
```css
color: #e3edf9;
background: linear-gradient(145deg,#4b5b74,#29374f);
box-shadow: 0 3px 12px #080e2455;
border-color: #a2b6d66b;
```

## Orbit 移除圆面 ::before

```css
content: "";
position: absolute;
inset: 3px;
z-index: -1;
border-radius: 50%;
background: linear-gradient(145deg,#f9fbffff,#e4ebf6f0);
box-shadow: inset 0 0 0 .6px #ffffffef,0 1px 4px #243b5c22;
transition: none!important;
```

Dark:
```css
background: linear-gradient(145deg,#53637b,#394960);
box-shadow: inset 0 0 0 .6px #c1d4ef55,0 1px 5px #080f252e;
```

## Orbit 正文 .v10text/.v10title/.v10code

```css
font-size: 10.5px;
line-height: 1.5;
letter-spacing: -.15px;
font-weight: 590;
font-family: ui-monospace,'SFMono-Regular',Consolas,'Liberation Mono',monospace;
font-variant-ligatures: none;
font: 10.5px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;
background: #24344c;
border-radius: 9px;
padding: 9px;
color: #d3e8fa;
white-space: pre-wrap;
overflow-wrap: anywhere;
overflow: hidden;
margin: 0;
flex: 1;
min-height: 0;
```

## Orbit 页脚 .clip-foot/.key

```css
font-size: 10px;
line-height: 1.4;
letter-spacing: 0;
padding: 8px 12px 10px;
display: grid;
align-items: center;
gap: 6px;
white-space: nowrap;
color: #fff;
min-height: 31px;
margin-left: auto;
border-radius: 5px;
background: #6589d7;
min-width: 19px;
height: 19px;
place-items: center;
```

## Orbit 来源 .app-origin

```css
background: #8296b4;
```

## 光点 .type-dock

```css
position: absolute;
left: 0;
top: 50%;
transform: translateY(-50%);
width: 38px;
--step: 26px;
--active-i: 0;
display: flex;
flex-direction: column;
align-items: center;
justify-content: flex-start;
z-index: 10;
isolation: isolate;
padding: 0;
touch-action: none;
user-select: none;
height: calc(var(--step)*5);
overflow: visible;
opacity: 1;
```

## 光点 .type-dot

```css
display: grid;
place-items: center;
width: 38px;
height: var(--step);
background: none;
border: 0;
padding: 0;
cursor: pointer;
outline: none;
position: relative;
color: inherit;
flex: none;
```

## 光点 圆点 i

```css
width: 5px;
height: 5px;
border-radius: 50%;
background: #e7f3ff;
box-shadow: none!important;
transition: scale 320ms cubic-bezier(.2,.75,.2,1),opacity 260ms,background 260ms;
pointer-events: none;
opacity: .24;
scale: .78;
```

Dark:
```css
background: #d6eaff;
```

## 光点 当前 i

```css
background: #f5faff;
scale: 1.12;
box-shadow: 0 0 5px #e1f4ff50;
opacity: .43;
```

Dark:
```css
background: #fff;
```

## 光点 空类 i

```css
opacity: .13;
```

## 光点 标签 .type-bubble

```css
position: absolute;
left: 37px;
top: 0;
transform: translate( -5px,calc(var(--bubble-i,0)*var(--step) - 4px));
background: #f5f9ffed;
border: 0;
color: #415a7d;
border-radius: 7px;
padding: 6px 9px;
font-size: 11px;
font-weight: 500;
white-space: nowrap;
box-shadow: 0 6px 18px #1d36552c;
opacity: 0;
transition: opacity .25s,transform .4s cubic-bezier(.18,.86,.22,1);
pointer-events: none;
z-index: 9;
```

Dark:
```css
background: #263b58ef;
color: #e8f3ff;
border-color: #b2cced66;
```

## App 侧栏 .sidebar

```css
padding: 15px 6px;
background: linear-gradient(155deg,#ecf1fa,#f6f8fc 70%);
display: flex;
flex-direction: column;
min-height: 0;
padding-left: 10px;
padding-right: 10px;
```

Dark:
```css
background: linear-gradient(145deg,#18263a,#121b2a);
```

## App 导航 .nav button

```css
transition: background .19s,color .19s,box-shadow .2s,transform .22s cubic-bezier(.2,.8,.2,1);
height: 39px;
display: flex;
align-items: center;
gap: 6px;
padding: 0 5px;
border-radius: 9px;
text-align: left;
font-size: 11px;
color: #65738a;
white-space: nowrap;
```

Dark:
```css
color: #9cacc5;
```

## App 导航选中 .nav button.on

```css
background: #dfe7fa;
color: #3f65c5;
font-weight: 650;
box-shadow: inset 0 1px 0 #fff9;
```

Dark:
```css
background: #263e64;
color: #c0d2ff;
box-shadow: none;
```

## App 导航标签 .navlabel

```css
font-size: 10px;
color: #8a98ad;
font-weight: 600;
padding: 0 10px 8px;
letter-spacing: .08em;
text-transform: uppercase;
```

## App 列表区 .history

```css
overflow: visible;
scrollbar-width: thin;
scrollbar-color: #a9bad555 transparent;
padding-right: 3px;
min-width: 0;
```

## App 行 .native-row

```css
height: 52px;
display: flex;
align-items: center;
gap: 7px;
width: 100%;
text-align: left;
border-radius: 8px;
position: relative;
padding: 6px 9px;
border: 1px solid transparent;
transition: background .16s,border-color .16s;
overflow: hidden;
color: var(--a-ink);
```

## App 行选中

```css
background: linear-gradient(105deg,#8295e529,#8194e119);
border-color: #8194e145;
```

Dark:
```css
background: linear-gradient(105deg,#8295e52e,#8194e118);
```

## App 行缩略 .row-thumb

```css
transition: transform .24s cubic-bezier(.2,.8,.2,1);
```

## App 列表标题 .clip-title

```css
display: block;
```

## App 列表摘要 .excerpt

```css
display: block;
overflow: hidden;
text-overflow: ellipsis;
white-space: nowrap;
font-size: 11px;
```

## App 搜索 .native-search

```css
transition: border-color .2s,box-shadow .2s,background .2s;
```

## App 顶部 .app-top

```css
display: flex;
align-items: center;
justify-content: space-between;
padding: 13px;
gap: 12px;
flex-shrink: 0;
padding-left: 16px;
padding-right: 15px;
flex-wrap: wrap;
```

## App Inspector

```css
border-radius: 16px;
background: var(--surface);
border: 1px solid var(--line);
box-shadow: var(--shadow);
padding: 12px;
display: flex;
flex-direction: column;
min-height: 260px;
overflow: auto;
scrollbar-width: thin;
flex-shrink: 0;
```

## App Inspector 详情 .detail-native

```css
min-height: 100%;
display: flex;
flex-direction: column;
animation: detailIn .3s cubic-bezier(.2,.8,.2,1);
```

## App 分隔条 .splitter

```css
cursor: col-resize;
background: var(--a-line);
position: relative;
z-index: 5;
width: 5px;
transition: background .2s;
touch-action: none;
```

# Relay MCP 前端重设计规格

视觉参考页：`docs/design/knowledge-overview-reference.html`（用浏览器直接打开）。本文与参考页冲突时以本文为准。本文只含执行指令，按章节顺序实施。

## 0. 硬约束

- 只改表现层和交互结构。不改后端、API 方法与参数、幂等键（`ui-...`）、路由路径、权限判断（`user.isAdmin`）、`localStorage` 的 `token`。
- 所有现有功能保留。控制项不得删除，只能移动到本文规定的位置。
- UI 文案一律英文，sentence case。
- 只做深色主题，无主题切换。
- 禁止 `: any` 和 `as any`。用具体类型，或 `unknown` 加类型守卫。
- 不引入 UI 组件库。允许新增的依赖只有 §2.3 的字体包。
- 每改完一个页面，在真实浏览器中打开该路由，控制台无报错，再进入下一个页面。
- `frontend/src/pages/KnowledgeOverviewNew.tsx` 在浏览器中白屏，原因未诊断。不要复用，按本文重写。

## 1. 技术栈

| 项 | 取值 |
|---|---|
| 框架 | React + TypeScript，沿用现有版本 |
| 构建 | Vite 5（`frontend/vite.config.ts`）。构建：`cd frontend && npm run build`（即 `node --import tsx/esm build.mjs`）。开发：`npm run dev`，端口 5173 |
| 样式 | Tailwind CSS v3（postcss）加 CSS 变量。复杂效果写在 `src/styles/tokens.css` |
| 路由 | react-router-dom，沿用 `App.tsx` 路由表，不增删路径 |
| 图标 | lucide-react，`strokeWidth={1.75}`，尺寸 14、16、20 |
| 状态 | 组件本地 state。跨页 context 只有三个：Auth（已有）、ProjectScope（§4.2）、Toast（§5） |

## 2. 设计令牌

### 2.1 颜色

| Token | 值 | 用途 |
|---|---|---|
| ink | #061216 | mint 填充上的文字 |
| bg-0 | #071418 | html 底色 |
| bg-1 | #081a1f | 页面渐变中段 |
| bg-2 | #07161b | 页面渐变底部 |
| mint | #6ee7c8 | 主色、激活态、ok |
| sun | #ffb454 | warn、stale、accent 按钮、焦点环 |
| coral | #ff7a70 | error、failed、danger |
| iris | #8ab4ff | info、Operations 卡片常态色（参考页没有，本文新增） |
| fg | #e8f1ef | 主文字 |
| muted | #8fa8a6 | 次要文字 |
| line | rgba(255,255,255,.09) | 分隔线、默认边框 |
| line-strong | rgba(255,255,255,.22) | hover 边框 |
| glass-top | rgba(255,255,255,.07) | 玻璃面板渐变起点 |
| glass-bottom | rgba(255,255,255,.02) | 玻璃面板渐变终点 |
| field | rgba(255,255,255,.04) | 输入框底色 |
| plate-top | #10303a | 孔板底板渐变起点 |
| plate-bottom | #08191e | 孔板底板渐变终点 |
| glow-sun | rgba(255,170,80,.20) | 页面光晕，右上 |
| glow-teal | rgba(20,184,166,.22) | 页面光晕，左侧 |
| glow-blue | rgba(70,100,210,.20) | 页面光晕，底部 |

状态色规则，写入 `src/lib/status.ts`，语义与现有 `StatusBadge` 一致：

```ts
export type Tone = 'ok' | 'warn' | 'bad' | 'neutral';

export function toneOf(status: unknown): Tone {
  const text = String(status ?? 'unknown');
  if (/failed|error|deprecated|rejected/i.test(text)) return 'bad';
  if (/warning|partial|needs_review|stale|queued|running/i.test(text)) return 'warn';
  if (/approved|succeeded|verified|ready|healthy|accepted/i.test(text)) return 'ok';
  return 'neutral';
}

export function statusLabel(status: unknown): string {
  const text = String(status ?? 'unknown').replaceAll('_', ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}
```

色调到颜色：ok 为 mint，warn 为 sun，bad 为 coral，neutral 为 muted。

### 2.2 `src/styles/tokens.css`（完整内容）

在 `main.tsx` 中先导入 `./index.css`，再导入 `./styles/tokens.css`，保证本文件覆盖 Tailwind preflight。

```css
:root{
  --ink:6 18 22; --mint:110 231 200; --sun:255 180 84; --coral:255 122 112; --iris:138 180 255;
  --fg:232 241 239; --muted:143 168 166;
  --bg-0:#071418;
  --line:rgba(255,255,255,.09); --line-strong:rgba(255,255,255,.22);
  --glass-top:rgba(255,255,255,.07); --glass-bottom:rgba(255,255,255,.02);
  --field:rgba(255,255,255,.04);
  --font-display:'Bricolage Grotesque Variable','Segoe UI Variable Display','Segoe UI','Microsoft YaHei',sans-serif;
  --font-sans:'IBM Plex Sans','Segoe UI','Microsoft YaHei',sans-serif;
  --font-mono:'IBM Plex Mono','Cascadia Mono',Consolas,monospace;
}
html{color-scheme:dark;background:var(--bg-0);scroll-padding-top:112px}
body{min-height:100vh;font:15px/1.6 var(--font-sans);color:rgb(var(--fg));
  background:
    radial-gradient(900px 620px at 88% -8%,rgba(255,170,80,.20),transparent 62%),
    radial-gradient(820px 700px at -6% 18%,rgba(20,184,166,.22),transparent 62%),
    radial-gradient(1000px 640px at 55% 112%,rgba(70,100,210,.20),transparent 62%),
    linear-gradient(180deg,#071418,#081a1f 60%,#07161b)}
body::before{content:'';position:fixed;inset:0;z-index:0;pointer-events:none;opacity:.07;mix-blend-mode:overlay;
  background-image:url(data:image/svg+xml,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20width=%27160%27%20height=%27160%27%3E%3Cfilter%20id=%27n%27%3E%3CfeTurbulence%20type=%27fractalNoise%27%20baseFrequency=%27.8%27%20numOctaves=%272%27%20stitchTiles=%27stitch%27/%3E%3C/filter%3E%3Crect%20width=%27100%25%27%20height=%27100%25%27%20filter=%27url%28%23n%29%27/%3E%3C/svg%3E)}
#root{position:relative;z-index:1}

a:focus-visible,button:focus-visible,summary:focus-visible,[tabindex]:focus-visible{outline:2px solid rgb(var(--sun));outline-offset:3px;border-radius:6px}
.skip-link{position:absolute;left:16px;top:-56px;z-index:100;padding:8px 14px;border-radius:8px;background:rgb(var(--mint));color:rgb(var(--ink));font-weight:500}
.skip-link:focus{top:12px}

.glass{position:relative;border:1px solid var(--line);border-radius:16px;overflow:hidden;
  background:linear-gradient(165deg,var(--glass-top),var(--glass-bottom));backdrop-filter:blur(14px);transition:border-color .25s}
.glass::after{content:'';position:absolute;inset:0;pointer-events:none;opacity:0;transition:opacity .3s;
  background:radial-gradient(320px circle at var(--mx,50%) var(--my,50%),rgba(255,255,255,.09),transparent 65%)}
.glass:hover{border-color:var(--line-strong)}
.glass:hover::after{opacity:1}
@media (pointer:coarse){.glass::after{display:none}}

.well{aspect-ratio:1;border-radius:50%;filter:brightness(var(--b,1));transition:transform .15s;
  animation:light .55s cubic-bezier(.2,.8,.2,1) backwards;animation-delay:var(--d,0ms)}
.well:hover{transform:scale(1.2)}
.well.ok{background:radial-gradient(circle at 35% 30%,#c4fbec 0,#6ee7c8 38%,#1f9c86 100%);box-shadow:0 0 14px rgba(110,231,200,.35),inset 0 -3px 6px rgba(0,0,0,.25)}
.well.stale{background:radial-gradient(circle at 35% 30%,#ffe3b5,#ffb454 42%,#b36a12 100%);box-shadow:0 0 16px rgba(255,180,84,.5),inset 0 -3px 6px rgba(0,0,0,.25)}
.well.fail{background:radial-gradient(circle at 35% 30%,#ffc2bc,#ff7a70 42%,#b8322a 100%);box-shadow:0 0 16px rgba(255,122,112,.5),inset 0 -3px 6px rgba(0,0,0,.25)}
.well.wait{background:rgba(255,255,255,.04);box-shadow:inset 0 0 0 1.5px rgba(255,255,255,.16)}
@keyframes light{from{opacity:0;transform:scale(.4);filter:brightness(2.2)}}

@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}
```

### 2.3 字体

不使用 Google Fonts（当前网络下被拦截）。在 `frontend` 目录执行：

```
npm i @fontsource-variable/bricolage-grotesque @fontsource/ibm-plex-sans @fontsource/ibm-plex-mono
```

先用 `npm view <包名>` 确认包存在。`main.tsx` 中导入：

```ts
import '@fontsource-variable/bricolage-grotesque';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
```

若 npm 无法安装，把 woff2 放进 `frontend/public/fonts/`，用 `@font-face`（`font-display:swap`）引用，family 名与 §2.2 的变量一致。

### 2.4 字阶

| 角色 | 字体 | 字号/行高 | 字重 | 字距 |
|---|---|---|---|---|
| Overview 主标题 h1 | display | clamp(32px,4.2vw,52px)/1.08 | 600 | -.03em |
| 页面标题 h1 | display | 30px/1.15 | 600 | -.02em |
| 区块标题 h2 | display | 22px/1.25 | 600 | -.01em |
| 平面卡片标题 h3 | display | 24px/1.2 | 600 | -.02em |
| 面板内标题 h3 | display | 17px/1.3 | 600 | -.01em |
| 正文 | sans | 15px/1.6 | 400，强调 500 | 0 |
| 次要文字 | sans | 14px/1.55 | 400 | 0 |
| 元信息 | sans | 12.5px/1.5 | 400 | 0 |
| 路径、ID | mono | 13.5px/1.5 | 400 | 0 |
| 数字、计数 | mono | 13px | 500 | 0 |
| 导航、按钮 | sans | 14px | 500 | 0 |

所有标题加 `text-wrap:balance`。数字加 `font-variant-numeric:tabular-nums`。正文最大行宽 68ch。

禁止：全大写文字、带字距的大写标签、标题上方的 eyebrow 标签、用中点分隔的元信息（改用逗号或独立元素）、`WORD — fragment` 式标签、链接和按钮文字末尾的箭头、标题内只给一个词换色。

### 2.5 圆角、间距、阴影

- 间距基数 4px，常用 4、8、12、16、20、24、32、40、56、80。
- 圆角：按钮 8，输入框 10，玻璃面板 16，孔板外壳 24，胶囊和孔位 999。
- 阴影只有一处：孔板外壳 `0 40px 80px -30px rgba(0,0,0,.65), 0 0 90px -20px rgba(110,231,200,.20)`。状态点辉光 `0 0 10px currentColor`。其余元素无投影。
- z-index：TopBar 40，SubNav 30，Popover 60，Drawer 70，Dialog 80，Toast 90，skip link 100。

## 3. Tailwind 配置

先把 `frontend/tailwind.config.js` 恢复为只含 content 与 `theme: { extend: {} }`，删除此前试验加入的 `slate-bg`、`border`、`accent`、`text` 颜色和 `borderRadius` 覆盖。然后写成：

```js
/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: 'rgb(var(--ink) / <alpha-value>)',
        mint: 'rgb(var(--mint) / <alpha-value>)',
        sun: 'rgb(var(--sun) / <alpha-value>)',
        coral: 'rgb(var(--coral) / <alpha-value>)',
        iris: 'rgb(var(--iris) / <alpha-value>)',
        fg: 'rgb(var(--fg) / <alpha-value>)',
        muted: 'rgb(var(--muted) / <alpha-value>)',
      },
      fontFamily: {
        display: ['var(--font-display)'],
        sans: ['var(--font-sans)'],
        mono: ['var(--font-mono)'],
      },
      borderRadius: { ctl: '8px', field: '10px', panel: '16px', plate: '24px' },
      borderColor: { line: 'var(--line)', 'line-strong': 'var(--line-strong)' },
    },
  },
  plugins: [],
};
```

不要覆盖 Tailwind 默认色板（`gray`、`indigo`、`amber`、`rose` 等）。未迁移的旧页面还依赖它们，P7 清理完成前保持不动。

## 4. 应用外壳

用 `components/shell/AppShell.tsx` 替代 `components/Layout.tsx`，`App.tsx` 中 `path='/'` 的 element 改为 `<AppShell />`。结构：

```tsx
<div>
  <a className='skip-link' href='#main'>Skip to content</a>
  <TopBar />
  {inKnowledge && <SubNav />}
  <main id='main'><Outlet /></main>
  <footer>Web/API build {version}, commit {commit.slice(0, 12)}, built {buildTime}</footer>
</div>
```

页脚数据来自 `api.health()`，只在 AppShell 调用一次，失败时不渲染页脚。页脚样式：max-width 1280，水平居中，左右 padding 40，底部 padding 40，13px，muted。各页面里原有的 build 信息一律删除。

### 4.1 导航层级

三层导航，外观互不相同：L1 是实心 mint 胶囊，L2 是下划线标签，L3 是中性分段控件。

L1（TopBar）：

| 标签 | 路径 | 可见性 |
|---|---|---|
| Projects | /projects | 所有人 |
| Servers | /servers | 所有人 |
| Instances | /instances | 所有人 |
| Tools | /tools | 所有人 |
| Knowledge | /knowledge | 所有人 |
| Tokens | /tokens | 所有人 |
| Users | /users | 仅 `user.isAdmin` |

若现有 `Layout.tsx` 对其中某项的可见性不同，沿用现有规则。激活判断：`pathname.startsWith(路径)`，激活项加 `aria-current='page'`。

L2（SubNav，仅 `/knowledge` 下显示）：

| 标签 | 跳转路径 | 激活条件 |
|---|---|---|
| Overview | /knowledge | pathname 等于 /knowledge |
| Control plane | /knowledge/integrated | 以 /knowledge/integrated 开头 |
| Wiki | /knowledge/wiki | 以 /knowledge/wiki 开头 |
| Product docs | /knowledge/product-docs | 以 /knowledge/product-docs 开头 |
| Solutions | /knowledge/solution | 以 /knowledge/solution 开头 |
| Memory | /knowledge/memory | /knowledge/memory、sessions、evidence、observations、candidate-insights、candidates、cases、patterns、confirmed-memory |
| Playbooks | /knowledge/playbooks | 以 /knowledge/playbooks 开头 |
| Operations | /knowledge/operations/capture | 以 /knowledge/operations 开头 |

L3（PageTabs，放在页面标题下方）：

| 所属 | 标签与路径 |
|---|---|
| Product docs | Documents /knowledge/product-docs；Topics /knowledge/product-docs/topics；Imports /knowledge/product-docs/imports（仅 admin，沿用现有规则）；Versions and diffs /knowledge/product-docs/versions；Search /knowledge/product-docs/search |
| Memory | Workspace /knowledge/memory；Sessions /knowledge/sessions；Evidence /knowledge/evidence；Observations /knowledge/observations；Candidate insights /knowledge/candidate-insights；Confirmed memory /knowledge/confirmed-memory |
| Operations | Capture /knowledge/operations/capture；Ingest /knowledge/operations/ingest；Index and providers /knowledge/operations/index |

路径 `/knowledge/candidates`、`/cases`、`/patterns` 保持可访问，但没有 L3 标签，L2 高亮 Memory。

L3 用 `<NavLink>` 渲染在 `<nav>` 内，不使用 `role='tablist'`。

### 4.2 项目范围

新增 `ProjectScopeProvider`：启动时调用一次 `api.listProjects()`，默认选第一个项目，选择结果持久化到 `localStorage['knowledge.projectId']`。

项目级页面（目前页内自带项目选择器的页面，以实际代码为准）删除页内选择器，改读 context。SubNav 右侧显示 ScopeChip：胶囊，13px，边框 `line`，文字 `Project: {name}`，点击打开 Popover 项目列表，选中项右侧显示 Check 图标。全局页面（Product docs、Overview、Operations）不显示 ScopeChip。

删除旧的 `localStorage['knowledge.nav.open']` 读写。

### 4.3 视觉

TopBar：
- sticky top 0，高 64，水平 padding 40（移动端 20），背景 `rgba(6,18,22,.6)`，`backdrop-filter:blur(14px)`，下边框 `line`。
- 品牌：26px 方块，圆角 8，背景 `conic-gradient(from 210deg,#6ee7c8,#ffb454,#6ee7c8)`，阴影 `0 0 20px rgba(110,231,200,.4)`；右侧文字 `Relay MCP`，display 600 18px，字距 -.01em，与方块间距 10。
- L1 胶囊：padding `7px 15px`，圆角 999，14px，默认 muted，hover 文字 fg 加背景 `rgba(255,255,255,.06)`，激活背景 mint、文字 ink、字重 500；间距 4；过渡 200ms；窄屏横向滚动。
- 右侧 UserMenu：用户名 13px muted；管理员再显示 `Admin` 胶囊（12px，sun，边框 sun 40%，padding `2px 10px`）。点击打开 Popover，唯一条目 `Sign out`，执行 `logout()` 后 `navigate('/login')`。

SubNav：
- sticky top 64，高 48，背景 `rgba(6,18,22,.45)`，blur 14，下边框 `line`，水平 padding 同 TopBar。
- 标签：14px，padding `0 14px`，高 48，默认 muted，hover fg，激活 fg 加底部 2px mint 线（`box-shadow:0 0 12px rgba(110,231,200,.5)`）。
- ScopeChip 靠右。

PageTabs（L3）：容器 `inline-flex`，padding 3，圆角 999，背景 `field`，边框 `line`；项 padding `6px 14px`，圆角 999，14px，默认 muted，激活背景 `rgba(255,255,255,.10)` 加文字 fg。

### 4.4 移动端（宽度小于 700px）

- TopBar 只留品牌和菜单 IconButton（Menu 图标）。菜单打开后是 `fixed inset-x-0 bottom-0 top-16` 的整屏面板，背景 `rgba(6,18,22,.96)`，L1 项每行高 48，面板内含 UserMenu 的 `Sign out`。
- SubNav 和 PageTabs 横向滚动，不换行。

## 5. 组件库（`src/components/ui/`）

| 组件 | 规格 |
|---|---|
| GlassPanel | 使用 `.glass`。`padding` 取 none、md（22）、lg（26）。`useGlow` 在 mousemove 时用 requestAnimationFrame 节流设置 `--mx`、`--my`；`matchMedia('(pointer: coarse)')` 为真时不绑定 |
| Button | 高 38，padding `0 18px`，圆角 8，14px/500，inline-flex，gap 8。sm：高 32，padding `0 12px`，13px。变体见下表。`loading` 时图标换成 Loader2（旋转），宽度不变，加 `aria-busy`。disabled：opacity .45，禁用指针 |
| IconButton | 36×36，圆角 8，ghost 样式，必须传 `aria-label` |
| Field | label 13px/500 fg，下间距 6；hint 12.5px muted；error 12.5px coral，用 `aria-describedby` 关联 |
| Input、Select、Textarea | 高 38（Textarea 最小 96），padding `0 12px`，圆角 10，背景 `field`，边框 `line`，14px fg，placeholder 为 muted 70%。hover 边框 `line-strong`。focus：边框 mint，加 `0 0 0 3px rgba(110,231,200,.18)`，去掉 outline。invalid：边框 `rgba(255,122,112,.6)`。Select 使用原生 `<select>`，`appearance:none`，右侧叠 ChevronDown 16px |
| Dropzone | 虚线边框 `line-strong`，圆角 16，padding 28，居中文字。拖入状态：边框 mint，背景 `rgba(110,231,200,.06)`。已选文件逐行列出，每行带移除按钮 |
| Badge | 胶囊，padding `2px 10px`，12px/500，边框 `line`，文字 muted。带色变体：边框用对应色 40%，文字用对应色 |
| StatusPill | 8px 圆点（`currentColor`，辉光 `0 0 10px currentColor`）加 13px 文字，整体用 §2.1 色调。文字用 `statusLabel()` |
| SegmentedBar | 高 6，圆角 99，轨道 `rgba(255,255,255,.06)`；分段 `flex-grow` 取数量：imported 用 mint，skipped 用 `rgba(255,255,255,.22)`，failed 用 coral |
| PageHeader | 左：h1（30px display）加可选描述（14px muted，最大 60ch，上间距 8）。右：操作按钮，gap 12。下方 24px 处放 PageTabs。整体下边距 32 |
| DataTable | 外层 `.glass`，padding 0。表头 12.5px muted，padding `12px 22px`。行 padding `16px 22px`，上边框 `line`，hover 背景 `rgba(255,255,255,.04)`。可点击行 `cursor:pointer`。被抽屉打开的行：背景 `rgba(110,231,200,.06)` 加左侧 2px mint 线。首列 `min-w-0` 并截断。窄屏变为两行堆叠 |
| Pagination | 文案 `Showing {from} to {to} of {total}`（13px muted，数字用 mono），右侧 `Previous`、`Next` 两个 ghost sm 按钮。数据来自现有 `page.total` 和 limit |
| Dialog | portal。遮罩 `rgba(3,10,12,.72)` 加 blur 4。面板 `.glass`，宽 `min(520px, calc(100vw - 32px))`，padding 26。标题 display 22px。底部按钮右对齐，gap 12（ghost 取消在左，主操作在右）。进入动画 160ms（opacity 0 到 1，scale .98 到 1）。焦点陷阱，Esc 和点遮罩关闭（忙碌时禁用），关闭后焦点回到触发元素 |
| ConfirmDialog | 取代所有 `window.confirm`。props：`title`、`description`、`confirmLabel`、`tone`（primary 或 danger）、`requireReason`、`onConfirm(reason?: string)`。`requireReason` 为真时显示必填 Textarea（label 为 `Reason`，hint 为 `Recorded in the audit log`），trim 后为空则确认按钮禁用。执行中两个按钮禁用，确认按钮显示 spinner。失败时对话框保持打开，内部显示 coral 错误文字 |
| Drawer | portal，从右侧滑入，宽 `min(760px, 100vw)`，全高。遮罩 `rgba(3,10,12,.55)`。面板背景 `#0a1c21`，左边框 `line`。头部高 72：标题加关闭 IconButton。内容区滚动。底部固定区：上边框 `line`，背景 `rgba(6,18,22,.9)` 加 blur。进入动画 240ms `cubic-bezier(.2,.8,.2,1)`（translateX 24px 到 0，opacity 0 到 1）。焦点陷阱，Esc 关闭。开关状态由 URL 参数 `id` 决定，关闭时用 replace 删除该参数，浏览器后退也会关闭 |
| Popover | 锚定面板，背景 `rgba(8,26,31,.96)`，边框 `line`，圆角 12，padding 8，blur 14。进入 120ms（opacity，translateY 4px 到 0）。Esc 和点外部关闭 |
| Toast | 右下角堆叠（移动端底部居中），gap 8，宽 360，`.glass` 加 3px 左侧色条（色调色）。success 和 info 4 秒自动消失，error 需手动关闭。进入 200ms 滑入。success 用 `role='status'`，error 用 `role='alert'`。API：`useToast()` 返回 `{ success(text), error(text) }` |
| Tooltip | 12.5px，背景 `rgba(6,18,22,.96)`，边框 `line`，圆角 8，padding `6px 10px`，延迟 250ms，hover 和 focus 都触发 |
| EmptyState | `.glass`，居中，padding 48。标题 display 17px，一句 14px muted 的说明（写明下一步动作），可选 primary 按钮 |
| ErrorState | 同 EmptyState 容器，顶部 AlertCircle 22px coral，文字说明发生了什么和如何处理，`Retry` ghost 按钮 |
| Skeleton | 背景 `rgba(255,255,255,.06)`，圆角 8，opacity 在 .5 和 1 之间 1.2s 脉动 |

Button 变体：

| 变体 | 样式 |
|---|---|
| primary | 背景 mint，文字 ink。hover：`filter:brightness(1.08)` 加 `box-shadow:0 0 22px -4px rgba(110,231,200,.5)` |
| accent | 背景 `rgba(255,180,84,.08)`，边框 `rgba(255,180,84,.45)`，文字 sun。hover：背景 `rgba(255,180,84,.16)` 加 `box-shadow:0 0 22px -4px rgba(255,180,84,.5)`。参考页的 Refresh 按钮就是此变体 |
| ghost | 边框 `line`，文字 fg。hover：背景 `rgba(255,255,255,.06)` |
| danger | 背景 `rgba(255,122,112,.08)`，边框 `rgba(255,122,112,.45)`，文字 coral。hover：背景 `rgba(255,122,112,.16)` |

过渡统一 200ms ease。

## 6. 页面

通用页面容器 `.page`：max-width 1280，水平居中，padding `40px 40px 96px`；Overview 顶部 padding 为 52。窄屏见 §9。

### 6.1 Overview（`/knowledge`，重写 `pages/KnowledgeOverview.tsx`）

数据：保留现有 `load()` 中的全部调用与公式，只去掉 `api.health()`（页脚已承担）。派生值：
- `pendingReview`：`dashboard.counts` 中 `kind==='candidate' && lifecycle==='draft'` 的 `count` 之和。
- `unlinkedEvidence`：`unlinkedResult.page.total`。
- `productDocumentCount`：`productResult.page.total`。
- `failedRuns`：最近运行中 `status` 匹配 `/failed|partial/i` 的数量。
- 索引：`indexResult` 的 `stale`、`indexedDocuments`、`documents`。
- 采集：`capture.status`、`capture.deadLetterCount`。

布局（宽度 960 以上）：
1. Hero：`grid-template-columns:minmax(0,1.5fr) minmax(0,1fr)`，gap 56，垂直居中。左侧 IndexPlate，右侧文字栏。
2. 区块 `Where to work`：上间距 80，h2 加三列 PlaneCard（gap 20）。
3. 区块 `Recent ingest runs`：上间距 80，行头为 h2 加右侧链接 `View all runs`，下方 IngestRunList。
4. 末尾一行 `Default project: {name}`，13px muted，名称用 fg，上间距 28。名称来自 ProjectScope context。

不再渲染：LifecyclePipeline、Quick actions 面板、八张指标卡。对应信息由 Needs attention、PlaneCard 脚注取代。

右侧文字栏自上而下：
1. h1 标题（逻辑见下）。
2. lede 段落：上间距 16，muted，最大 38ch。
3. Legend：两列网格，gap `8px 20px`，上下间距 `26px 0 24px`，14px muted。每项：10px 圆点（颜色同孔位，带辉光；Waiting 用 `inset 0 0 0 1.5px rgba(255,255,255,.35)` 空心圆）加标签加 mono 计数（fg，500）。项目：Current、Stale、Failed、Waiting。Failed 计数为 0 时隐藏该项。
4. Refresh 按钮（accent 变体，RefreshCw 图标，加载时图标旋转）。
5. 小标题 `Needs attention`（14px/500 muted，上间距 36，下间距 6）。
6. AttentionList。

标题与 lede 逻辑：

| 条件 | h1 | lede |
|---|---|---|
| `documents === 0` | No documents indexed yet | Import product documents to build the index. |
| `stale` 为真 | Index is stale | Rebuild the index to bring search up to date. 下方加 ghost sm 链接按钮 `Open index controls` 指向 /knowledge/operations/index |
| 无 Waiting 且无 Failed | Index is current | 见下行 |
| 其他 | Index is current except {n} batches（n 为 1 时用 batch） | 见下行 |

lede 默认值：`batchSize === 1` 时为 `Each well is one document. Hover a well for its position and state.`，否则为 `Each well is a batch of about {batchSize} documents. Hover a well for its position and state.`

孔板数据映射，写入 `src/lib/plate.ts`（纯函数）：

```ts
export type WellState = 'ok' | 'stale' | 'fail' | 'wait';
export const PLATE_SIZE = 96;

export interface PlateInput {
  documents: number;
  indexedDocuments: number;
  stale: boolean;
  failedBatches: number;
}

export function buildPlate({ documents, indexedDocuments, stale, failedBatches }: PlateInput): { wells: WellState[]; batchSize: number } {
  const batchSize = Math.max(1, Math.ceil(documents / PLATE_SIZE));
  const indexed = documents <= 0 ? 0 : Math.min(PLATE_SIZE, Math.floor(indexedDocuments / batchSize));
  const failed = Math.min(Math.max(0, failedBatches), PLATE_SIZE - indexed);
  const wells: WellState[] = [];
  for (let i = 0; i < PLATE_SIZE; i += 1) {
    if (i < indexed) wells.push(stale ? 'stale' : 'ok');
    else if (i < indexed + failed) wells.push('fail');
    else wells.push('wait');
  }
  return { wells, batchSize };
}
```

- 孔位按行优先排列（左到右、上到下）。
- `failedBatches`：先到 `src/server` 中查看 `knowledgeOperationsIndex` 对应路由是否返回失败文档数；有则取 `ceil(failedDocuments / batchSize)`，没有则恒为 0。
- 不得为孔位编造来源文档名。Tooltip 文案：`{A1}, {current|stale|failed|waiting to index}`；`batchSize > 1` 时追加 `, about {batchSize} documents`。

IndexPlate 样式：
- 外壳：padding 1，圆角 24，背景 `linear-gradient(145deg,rgba(255,255,255,.30),rgba(255,255,255,.04) 42%,rgba(110,231,200,.26))`，阴影见 §2.5。
- 内板：圆角 23，padding `24px 26px 28px 18px`，背景 `linear-gradient(160deg,#10303a 0%,#08191e 72%)`，`box-shadow:inset 0 1px 0 rgba(255,255,255,.08)`。
- 网格：`grid-template-columns:18px repeat(12,1fr)`，gap 10（移动端 6），`align-items:center`。首行：空单元格加列标 1 到 12。其后 8 行：行标 A 到 H 加 12 个孔。标签 mono 11px，muted，opacity .75，居中。
- 孔位：类名 `well ok|stale|fail|wait`（样式见 §2.2）。亮度 `--b` 取 0.82 到 1.12，用固定种子 LCG 生成：`seed=7; seed=(seed*9301+49297)%233280; b=0.82+(seed/233280)*0.3`。入场延迟 `--d` 等于 `(行号+列号)*35` 毫秒。
- 入场动画只在 Overview 挂载时和点击 Refresh 加载完成后各播放一次（通过 `key` 递增重新挂载孔位）。这是全站唯一的非用户触发动效。
- 无障碍：容器 `role='img'`，`aria-label='Index coverage: {ok} of 96 batches current, {stale} stale, {fail} failed, {wait} waiting'`。

AttentionList：三行链接，每行 flex 两端对齐，padding `14px 10px`，上边框 `line`，hover 背景 `rgba(255,255,255,.05)`，计数用 mono 15px/500。

| 文案 | 目标 | 计数 | 计数颜色（大于 0） |
|---|---|---|---|
| Candidate insights waiting for review | /knowledge/candidate-insights | pendingReview | sun |
| Evidence not linked to any knowledge | /knowledge/evidence | unlinkedEvidence | mint |
| Imports that failed | admin 为 /knowledge/product-docs/imports，否则 /knowledge/operations/ingest | failedRuns | coral |

计数为 0 时用 muted。三项都为 0 时只渲染一行 muted 文字 `Nothing needs attention`。未加载到的值显示 `—`。

PlaneCard（整张卡是链接）：`.glass`，flex 纵向，gap 28，padding 26，最小高 210。背景叠加 `radial-gradient(300px 190px at 0 0, rgba(var(--tint),.26), transparent 70%)`，其上是 glass 渐变。标题 24px display；描述上间距 8，muted，最大 30ch；脚注 `margin-top:auto`，mono 13px/500，颜色 `rgb(var(--tint))`。

| 卡片 | 描述 | 脚注 | 目标 | tint |
|---|---|---|---|---|
| Product docs | Versioned documentation you can import, compare and search. | `{n} documents` | /knowledge/product-docs | 110,231,200 |
| Memory | What sessions captured, and the insights waiting to become knowledge. | `{pendingReview} waiting for review` | /knowledge/memory | 255,180,84 |
| Operations | Capture, ingest and index health, with rebuild controls. | `failedRuns > 0` 时 `{n} failed imports`，否则 `Capture {capture.status 小写}` | /knowledge/operations/capture | `failedRuns > 0` 为 255,122,112，否则 138,180,255 |

IngestRunList：外层 `.glass` padding 0，只显示前 5 条。每行为链接，指向 `/knowledge/operations/ingest?run={encodeURIComponent(id)}`，网格 `minmax(0,1fr) 200px 110px`，gap 24，padding `16px 22px`，行间上边框 `line`（首行无），hover 背景 `rgba(255,255,255,.04)`：
- 第一列：路径（`source_locator ?? id`，mono 13.5px，单行截断）；其下元信息 12.5px muted：`{imported} imported, {skipped} skipped, {failed} failed`。
- 第二列：SegmentedBar。
- 第三列：StatusPill，右对齐。

无记录时用 EmptyState：标题 `No ingest runs yet`，说明 `Import product documents to start one.`，admin 额外显示 primary 按钮 `Import documents`（跳转 Imports）。

加载态：孔板显示 96 个 `wait` 孔（无入场动画），其余用 Skeleton，不用整屏 spinner。错误态：ErrorState 加 `Retry`，调用 `load`。

### 6.2 列表页模板

适用页面：Product docs 的 Documents、Imports、Topics、Versions and diffs、Search；Memory 下全部页面；Playbooks；Solutions；Ingest。

结构自上而下：
1. PageHeader：标题、描述、右侧至多一个主操作按钮；L3 页面带 PageTabs。
2. 工具栏（flex，gap 12，可换行）：搜索框（`flex:1`，最小宽 280，左侧 Search 图标 15px muted，左 padding 36）；至多 2 个行内 Select（宽 160）；`Filters` ghost 按钮（SlidersHorizontal 图标，有生效筛选时右侧显示数量 Badge，色调 mint）；最右结果数 `{n} results`（13px muted，数字 mono）。
3. 生效筛选：Badge 加移除 X，行尾 ghost 文字按钮 `Clear all`。无生效筛选时不渲染该行。
4. DataTable。
5. Pagination。

规则：
- 现有页面中的筛选输入超出 2 个的部分，全部放进 `Filters` Popover（宽 320，纵向 Field 列表，底部 `Reset` 和 `Apply`）。
- 筛选值、搜索词、页码、当前记录写入 URL search params（`q`、`page`、`id`、各筛选项名），刷新和后退可恢复。用 `hooks/useUrlState.ts` 封装。
- 点击行打开右侧 Drawer（§6.3），不再使用常驻三栏布局。
- 默认分页 25 条，沿用现有 limit 参数。
- 空结果用 EmptyState，说明要写明如何放宽筛选或如何导入。

Product docs 的 Documents 页具体映射：
- 行内 Select：Version（`sampleManagerVersion`）、Document type。Popover：Solution、Module、Language、Authority。
- 列：Title、Version、Type、Language、Authority、Updated。
- 主操作：`Import documents`，打开 §6.5。
- 抽屉内标签：Overview、Versions and diffs（选择对比版本，展示 diff，复核按钮 `Accept`、`Reject`、`Needs review`，复核必须填写 Reason）。

### 6.3 记录抽屉与审核

抽屉头部：标题；下方一行 Badge（记录类型）加 StatusPill（lifecycle）加 mono 13px muted 的 id。抽屉内用 L3 同款分段控件切换内容：
- Summary：卡片内容与反馈。
- Evidence：关联证据列表，每行一个 mono 12.5px 的 id 加 ghost sm 按钮 `Download`（沿用现有下载流程）。
- History：审核历史，每条为动作（fg）加时间（muted，右对齐）加原因（muted，下一行）。无记录显示 `No review history yet.`
- Impact：按钮 `Load impact graph`；加载后列出关系：`{from.title} to {to.title}`，下方 `{relationType}` 加 StatusPill（verified 为 ok，unverified 为 neutral）。

Summary 内部版式（无卡片套卡片）：
- 信息项用两列 `<dl>`：dt 13px muted，dd 14px fg。
- Hypothesis：左侧 2px sun 竖线，左 padding 16，小标题 `Hypothesis, unconfirmed`。
- Verified conclusion：左侧 2px mint 竖线；不存在时显示 muted `Not verified yet.`
- Verification plan、Actions：`<ul>`，左 padding 20，行间距 8。
- Raw event：`<details>`，summary 文字 `Raw event`，内容 mono 12.5px，最大高 384，溢出滚动，`white-space:pre-wrap`。
- 区块之间间距 24，区块标题 h3 17px。
- 底部区块 `Was this useful?`：`Helpful`、`Not helpful` 两个 ghost sm 按钮加可选 Textarea（label `Comment`）。成功后 toast `Feedback saved.`

审核底栏（固定在抽屉底部，仅候选类记录显示）：
1. 默认状态：按钮行 `Accept`（primary）、`Reject`（danger）、`Deprecate`（danger）、`Edit card`（ghost）。
2. 点击前三个之一：底栏展开必填 Textarea（label `Reason`，hint `Recorded in the audit log`），按钮行变为 `Cancel`（ghost）和 `Confirm {动作小写}`（对应色调）。trim 后为空时确认按钮禁用。
3. 成功：toast `Accepted.`、`Rejected.` 或 `Deprecated.`；抽屉保持打开并刷新详情；列表行和左侧计数同步刷新。
4. 失败：在底栏内显示 coral 错误文字，保持展开。
5. 点击 `Edit card`：Summary 内容切换为可编辑表单（summary、problem statement、hypothesis、applicability、actions 每行一条、verification plan 每行一条、confidence 0 到 1），底栏为 `Cancel` 和 `Save card`，同样要求 Reason。成功后 toast `Card saved.`

按钮文案与 toast 动词保持一致。幂等键沿用现有格式。

置信度文案：`Low, signal only`、`Medium, needs validation`、`High, evidence-backed`、`Not scored`。

### 6.4 Operations 页面

通用：PageHeader 加 PageTabs；所有写操作（测试 provider、重建索引、重放事件、使 embedding 失效等）改用 ConfirmDialog，`description` 为 `This action is recorded in the audit log.`，`confirmLabel` 写明动作（如 `Rebuild index`）。权限判断沿用现有逻辑。

Capture：
- 顶部状态条：外层 `.glass`，六列网格，列间用 `line` 竖线分隔。每格：标签 13px muted，值 display 600 24px（状态类用 StatusPill）。六格：Capture availability、Last success、Backlog、Consecutive failures、Event loss risk、Dead-letter。窄屏变两列。
- 下方区块：`Recent captures`（沿用 `CaptureHistory` 组件，按新样式重写）；`Replay events` 折叠面板（`<details>`，展开后为 Field 表单：Event ID、Type、From、To、Limit；按钮 `Preview replay`（ghost，dryRun）和 `Replay events`（danger，经 ConfirmDialog））；`Smoke check` ghost 按钮，结果显示在其下方的 `.glass` 面板里。

Ingest：
- 使用 §6.2 模板。行点击打开抽屉，抽屉内为阶段时间线：纵向列表，每阶段一行，左侧 StatusPill 圆点，中间阶段名，右侧时间（muted）；圆点之间用 1px `line` 竖线连接。抽屉头部显示来源、状态、幂等记录。
- 选中运行写入 URL `?run=`（沿用现有参数名）。

Index and providers：
- 顶部状态条同 Capture 样式，格子为 FTS、Vector、Rerank、Inference、Redaction。
- 下方 provider 列表使用 DataTable；操作按钮靠右：`Test providers`、`Rebuild index`，均走 ConfirmDialog。
- `ProviderSetupForm` 放进 Drawer，标题 `Provider setup`。

### 6.5 导入对话框（Import documents）

Dialog 宽 640，字段自上而下：
1. Project（Select，默认取 ProjectScope，必填）。
2. Files（Dropzone，`accept='.md,.markdown,.html,.htm,.pdf,.zip'`，多选）。
3. SampleManager version（必填）。
4. Product（可选）。
5. Workspace folder（默认 `knowledge/product-docs`）。
6. `Advanced` 折叠区：Solution、Module、Language、Authority。

底部：`Cancel` 和 `Import documents`（primary）。校验失败时在底部上方显示 coral 文字：`Choose at least one file and enter the SampleManager version.`

提交后对话框内容切换为逐文件进度列表（`Uploading {name}`、完成后 `Uploaded {name}`、失败 coral 加原因）。上传逻辑逐字沿用现有实现：创建上传会话、PUT 文件、再调用 `productDocumentImport`。全部成功后关闭对话框，toast `Imported {n} documents.`，并刷新列表。任一文件失败时对话框保持打开，显示失败原因和 `Retry` 按钮。

### 6.6 登录页

全屏居中，背景同全站。`.glass` 面板宽 400，padding 32：品牌方块加 `Relay MCP`；h1 `Sign in`（display 28px）；Field：Username、Password；全宽 primary 按钮 `Sign in`。保留现有注册入口，文字链接 `Create an account`。错误显示在对应字段下方，文案 `Username or password is incorrect.`（沿用现有判断逻辑，仅改文案和位置）。

### 6.7 其余页面（Projects、Servers、Instances、Tools、Tokens、Users）

- 使用 §6.2 模板。创建和编辑表单放进 Dialog（字段少于 6 个）或 Drawer（字段不少于 6 个），不再内联展开在列表上方。
- 删除、撤销等破坏性操作走 ConfirmDialog（`tone='danger'`），确认按钮文案写明对象，如 `Delete server`、`Revoke token`。
- 令牌创建后若现有页面一次性展示令牌，则用 Dialog 展示：mono 文本块加按钮 `Copy token`（toast `Token copied.`）。保持现有展示规则，不新增说明文字。
- 迁移前先读取每个页面，把现有每个控制项映射到上述位置，再动手改。

## 7. 文案规范

规则：
- sentence case；主动语态；动作名称写明会发生什么，如 `Save changes`，不写 `Submit`。
- 同一动作的按钮、对话框确认键、toast 使用同一个动词：`Import documents` 对应 `Imported 3 documents.`
- 不使用感叹号、emoji、`Oops`、道歉用语、箭头。
- 错误文案：一句说明发生了什么，一句说明如何处理。
- 空状态：一句话说明下一步。
- 成功反馈用 toast，不再用页内绿色横幅。字段校验错误显示在字段下方；页面加载失败用 ErrorState。

术语替换：

| 旧 | 新 |
|---|---|
| Knowledge Workbench、Knowledge Overview | 不使用，Overview 以状态标题开头 |
| Choose a Knowledge plane | Where to work |
| plane（任何位置的用户可见文字） | 删除 |
| Integrated control plane | Control plane |
| Product Knowledge | Product docs |
| Solution Knowledge、Artifacts and Source | Solutions |
| Approved Operations | Playbooks |
| Versions and Diffs | Versions and diffs |
| Product Search | Search |
| Import Runs | Imports |
| Capture Health | Capture |
| Ingest Runs | Ingest |
| Index and Providers | Index and providers |
| Candidate Insights | Candidate insights |
| Confirmed Memory | Confirmed memory |
| Memory workspace | Workspace |
| Pending review records | Candidate insights waiting for review |
| Unlinked evidence | Evidence not linked to any knowledge |
| Import failures | Imports that failed |

页面标题与描述：

| 页面 | 标题 | 描述 |
|---|---|---|
| Product docs | Product docs | Versioned documentation. Import, compare and search. |
| Solutions | Solutions | Solution artifacts and their sources. |
| Memory | Memory | Sessions, evidence and the insights built from them. |
| Candidate insights | Candidate insights | Review each insight before it becomes confirmed memory. |
| Confirmed memory | Confirmed memory | Insights that passed review. |
| Playbooks | Playbooks | Approved operating procedures. |
| Capture | Capture | Worker availability, backlog and dead-letter records. |
| Ingest | Ingest | Product, casebook and context imports in one timeline. |
| Index and providers | Index and providers | Search index, vectors, rerank and redaction health. |

其余页面按同样长度和语气（不超过 90 个字符）写一句描述，或省略描述。

其他固定文案：
- 搜索降级提示：`Search is running without semantic matching. Results use keyword search only.`
- 抽屉未选中占位不再需要（抽屉按需出现）。
- 状态文字一律经 `statusLabel()`，如 `Needs review`、`Succeeded`、`Partial`、`Failed`。

## 8. 动效规范

允许：

| 动效 | 参数 |
|---|---|
| 孔板入场 | 550ms `cubic-bezier(.2,.8,.2,1)`，延迟 `(行+列)*35ms`；仅 Overview 挂载和 Refresh 完成 |
| 玻璃面板跟随光斑 | 仅指针设备；opacity 过渡 300ms |
| 按钮 hover | 200ms ease |
| 导航、标签、行 hover | 200ms ease |
| Drawer | 240ms `cubic-bezier(.2,.8,.2,1)` |
| Dialog | 160ms |
| Popover | 120ms |
| Toast | 200ms |
| Spinner、Skeleton 脉动 | 仅在忙碌态 |

禁止：滚动触发的出现动画、各区块依次淡入上移、卡片 hover 上浮、扫光效果、文字发光（text-shadow）、视差、背景渐变动画、页面切换动画。

`prefers-reduced-motion: reduce` 下所有动画与过渡关闭（规则已在 §2.2）。

## 9. 响应式

| 宽度 | 规则 |
|---|---|
| 1280 及以上 | 默认桌面布局 |
| 960 到 1279 | Hero 保持双列；页面水平 padding 32 |
| 小于 960 | Hero 改单列（孔板在上，文字在下，gap 40）；PlaneCard 单列 |
| 小于 700 | 页面 padding `32px 20px 64px`；区块间距 56；TopBar 使用菜单（§4.4）；孔板 gap 6；DataTable 与 IngestRunList 改为两行堆叠（第二行放 SegmentedBar，占满整行）；Drawer 宽 100vw；交互元素最小点击高度 40 |

## 10. 无障碍

- 焦点样式：`a`、`button`、`summary`、`[tabindex]` 使用 sun 色 2px outline，偏移 3px；输入框使用 mint 外环（§5）。
- 对比度：fg 在背景上不低于 12:1，muted 不低于 7:1。muted 文字不得小于 12.5px，不得再降低透明度。
- 颜色不是唯一信号：StatusPill 带文字；孔板带图例和计数。
- 地标：TopBar 的 `<nav aria-label='Primary'>`，SubNav 的 `<nav aria-label='Knowledge'>`，`<main id='main'>`，skip link `Skip to content`。
- 每页一个 h1。
- Dialog 与 Drawer：`role='dialog'`，`aria-modal='true'`，`aria-labelledby` 指向标题，焦点陷阱，Esc 关闭，关闭后焦点返回触发元素。
- Toast 使用 live region（见 §5）。

## 11. 文件清单

```
frontend/src/
  main.tsx                         改：导入字体、index.css、tokens.css；包裹 ToastProvider、ProjectScopeProvider
  styles/tokens.css                新建（§2.2）
  lib/status.ts                    新建：toneOf、statusLabel
  lib/plate.ts                     新建：buildPlate
  hooks/useGlow.ts                 新建
  hooks/useUrlState.ts             新建
  components/shell/                AppShell、TopBar、SubNav、PageTabs、ScopeChip、UserMenu、MobileMenu
  components/ui/                   Button、IconButton、Field、Input、Select、Textarea、Dropzone、Badge、StatusPill、
                                   SegmentedBar、PageHeader、DataTable、Pagination、GlassPanel、Dialog、ConfirmDialog、
                                   Drawer、Popover、Tooltip、Toast、Skeleton、EmptyState、ErrorState
  components/knowledge/            IndexPlate、PlaneCard、AttentionList、IngestRunList、ImportDialog、ReviewFooter、RecordDrawer
  pages/                           按 §6 重写
```

最终删除：`components/Layout.tsx`、`components/KnowledgePrimitives.tsx` 中被取代的导出（`PageShell`、`StatePanel`、`Badge`、`StatusBadge`、`ScopeBanner`、`LifecyclePipeline`、`cardClass`、`inputClass`）。`formatDate`、`jsonValue` 迁移到 `lib/format.ts` 后再删除原导出。

## 12. 实施步骤与验收

每个阶段结束都要执行 `cd frontend && npm run build`，无错误。

**P0 清理**
- 删除 `pages/KnowledgeOverviewNew.tsx`、`styles/design-tokens.css`、`frontend/DESIGN_DEMO.md`、`frontend/design-demo.html`。
- 删除 `App.tsx` 中 `KnowledgeOverviewNew` 的 import 和 `knowledge/new-design` 路由。
- 按 §3 恢复 `tailwind.config.js`。
- `pages/Knowledge.tsx` 在 `App.tsx` 的 import 列表中没有出现。用 LSP references 确认无任何引用后删除；若有引用，先报告再处理。
- 验收：构建通过；`/knowledge` 仍然能打开（旧页面）。

**P1 基础**
- 安装字体包，新建 `tokens.css`，改 `tailwind.config.js` 与 `main.tsx`，实现 §5 的全部组件，`lib/status.ts`、`hooks/useGlow.ts`、`hooks/useUrlState.ts`。
- 验收：新建一个临时路由页逐个展示所有组件的全部状态（default、hover、focus、disabled、loading、error），在浏览器中检查后删除该页。

**P2 外壳**
- 实现 AppShell 及 §4 全部内容，替换 `Layout`。
- 验收：§12 末尾路由清单中的每个路径都能在新外壳内打开；L1、L2、L3 激活态与 §4.1 的表一致；非 admin 看不到 Users 和 Imports；`Sign out` 可用；宽度 390 下菜单可用。

**P3 Overview**
- 按 §6.1 重写。
- 验收：宽度 1440 和 390 各截图一张，与参考页对照；真实数据能渲染；通过浏览器的请求拦截分别模拟四种状态（无文档、stale、全部 current、有 Waiting），确认标题、lede、图例、孔板与 §6.1 的表一致；Refresh 后孔板重新点亮；字体来自本地包（Network 面板无 `fonts.googleapis.com` 请求）。
- 通过后把 `frontend/design-demo-v2.html` 移到 `docs/design/knowledge-overview-reference.html`，删除 `frontend/design-demo-v2.html`。

**P4 列表页**
- 逐页迁移：Product docs（Documents、Imports、Topics、Versions and diffs、Search）、Memory 全部页面、Playbooks、Solutions、Control plane。每页先读取现有代码并列出所有控制项，确认全部落位后再改。
- 验收：每页的所有 API 调用与幂等键不变；筛选、分页、抽屉均能通过 URL 复现；审核四个动作和 `Edit card` 的流程符合 §6.3；导入对话框完成一次真实导入。

**P5 Operations**
- 按 §6.4 迁移三个页面，`window.confirm` 全部替换。
- 验收：`grep -rn 'window.confirm' frontend/src` 无结果；各写操作都经 ConfirmDialog。

**P6 其余页面与登录**
- 按 §6.6、§6.7 迁移。
- 验收：登录、创建、编辑、删除各走通一遍。

**P7 收尾**
- 删除 §11 列出的旧文件和旧导出（先用 LSP references 确认无引用）。
- 验收：`grep -rnE 'indigo-|uppercase|tracking-wide|tracking-wider|rounded-xl' frontend/src` 无结果；`grep -rnE ': any|as any' frontend/src` 无结果；JSX 文本中不含 ` · ` 分隔符。
- 在 `docs/` 中保留本文，并在 README 的前端相关段落（如有）指向它。

**全部路由（每个都要在宽度 1440 和 390 下打开，控制台无报错）**

`/login`、`/projects`、`/servers`、`/instances`、`/tools`、`/tokens`、`/users`、`/knowledge`、`/knowledge/integrated`、`/knowledge/memory`、`/knowledge/sessions`、`/knowledge/evidence`、`/knowledge/observations`、`/knowledge/candidate-insights`、`/knowledge/candidates`、`/knowledge/confirmed-memory`、`/knowledge/cases`、`/knowledge/patterns`、`/knowledge/playbooks`、`/knowledge/product-docs`、`/knowledge/product-docs/topics`、`/knowledge/product-docs/imports`、`/knowledge/product-docs/versions`、`/knowledge/product-docs/search`、`/knowledge/solution`、`/knowledge/operations/capture`、`/knowledge/operations/ingest`、`/knowledge/operations/index`

## 13. 编写本文时尚未读取的文件

实施前必须先读取：`pages/Login.tsx`、`Projects.tsx`、`Servers.tsx`、`Instances.tsx`、`Tools.tsx`、`Tokens.tsx`、`Users.tsx`、`KnowledgeProduct.tsx`、`KnowledgeMemory.tsx`、`KnowledgeProject.tsx`、`KnowledgeSource.tsx`、`KnowledgeIntegrated.tsx`；`components/ProviderSetupForm.tsx`、`CandidateReviewDetail.tsx`、`CaptureHistory.tsx`、`KnowledgeMarkup.tsx`、`LazyKnowledgeMarkup.tsx`；`api/client.ts` 的类型；`src/server` 中 `knowledgeOperationsIndex` 对应路由的返回字段。

上述文件的实际控制项、字段和权限规则优先于本文的假设；发现与本文冲突时，保留现有功能，并在提交说明中记录差异。

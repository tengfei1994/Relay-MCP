# Relay MCP 网站设计说明 v2

**文件位置**: `docs/design/relay-website-preview-v2.html`  
**日期**: 2026-11-06  
**基于用户反馈的重新设计**

## 设计目标

基于用户反馈调整：
1. **简化内容结构** - 删除独立的 Projects/Knowledge/Memory 演示板块，改为一个统一的流程场景
2. **降低颜色对比** - 从纯黑白黄调整为青蓝、紫色、绿色渐变，柔和的黄绿色强调
3. **保留核心动效** - 保留滚动驱动的小圆点路径动画和步骤淡入淡出
4. **压缩底部信息** - Getting started + FAQ + CTA 压缩到一屏，提高信息密度

## 页面结构

```
Header (sticky, 80px)
  ↓
Hero
  "Connect your agent. Keep the context."
  ↓
Flow Scene (滚动驱动，4 个步骤)
  Step 1: Authenticate & scope
  Step 2: Retrieve Knowledge
  Step 3: Execute on target
  Step 4: Review and confirm Memory
  ↓
Bottom Section (两栏)
  Getting started (3 steps + config)  |  FAQ (4 questions)
  ↓
CTA
  "Bring your work into context."
  ↓
Footer
```

## 新的流程场景设计

### SVG 布局
```
Codex (左上)
  ↓ (请求线)
Relay (中心，旋转 45° 的方形)
  ↓ ↓ ↓ (三条路径)
Knowledge  A-SERVER  Evidence
(左下)     (中下)     (右下)
```

### 4 个滚动步骤

| 阶段 | 滚动进度 | 高亮节点 | 文案 | 示例内容 |
|------|----------|----------|------|----------|
| 1 | 0-25% | Codex → Relay | Authenticate the call | `Authorization: Bearer ****` |
| 2 | 25-45% | Relay → Knowledge | Retrieve Knowledge | 一个确认的 Case Memory 卡片 |
| 3 | 45-65% | Relay → A-SERVER | Run it on the right server | `[SSH] tail -n 100 /var/log/app.log` |
| 4 | 65-85% | A-SERVER → Evidence | Review and confirm Memory | Pending review → Confirmed |

### 小圆点移动路径
- 0-25%: Codex (180, 80) → Relay (500, 280)，Relay 核心从 0 → 0.3 透明度
- 25-45%: Relay → Knowledge (200, 520)，Knowledge 路径描边动画
- 45-65%: Relay → A-SERVER (500, 520)，A-SERVER 路径描边动画
- 65-85%: Relay → Evidence (800, 520)，Evidence 路径描边动画
- 85-100%: 停在 Evidence，Relay 核心达到 0.8 透明度

## 颜色方案（降低对比）

```css
--bg: #0a0b0d (深炭黑，比纯黑 #000 柔和)
--surface: #13141a (表面)
--text: #e8e9f0 (柔和白，不是纯白)
--muted: #9ea2b8 (紫灰，取代之前的纯灰)
--accent: #b8f24e (黄绿，降低饱和度)
--accent-ink: #0d1106 (强调色上的文字)

/* 三条路径的渐变色 */
--knowledge-from: #4a90e2 (青蓝)
--knowledge-to: #5bc0de
--execution-from: #9b59b6 (紫色)
--execution-to: #c792ea
--memory-from: #2ecc71 (绿色)
--memory-to: #6dd582
--evidence: #f39c12 (琥珀)
```

## 关键改动

### 删除的内容
- ❌ 独立的 `#projects` section（环境切换器 + FLIP 动画）
- ❌ 独立的 `#knowledge` section（搜索框 + 文档过滤）
- ❌ 独立的 `#memory` section（三栏拖拽 + 状态切换）
- ❌ `.device` 3D 倾斜容器
- ❌ `.seg` 分段控件和 FLIP thumb 动画

### 保留的内容
- ✅ Hero 淡入淡出
- ✅ 滚动驱动的场景容器 (`.flow-scene` 560vh)
- ✅ 4 个步骤面板的淡入淡出逻辑
- ✅ 小圆点路径动画
- ✅ Relay 核心发光效果（`--core` CSS 变量）
- ✅ Getting started 3 步 + 配置示例
- ✅ FAQ 折叠面板
- ✅ Reduced-motion 静态视图

### 新增的内容
- ✅ 更完整的流程：认证 → Knowledge 检索 → 执行 → Evidence → Memory 审核
- ✅ 步骤面板中的代码示例和卡片
- ✅ 底部两栏布局（桌面并排，移动堆叠）
- ✅ 降低对比的渐变色系

## 响应式

- **桌面 (1440px)**：Getting started 和 FAQ 并排显示
- **移动 (≤900px)**：底部两栏堆叠，导航隐藏
- **Reduced-motion**：场景高度从 560vh → 自动，4 个步骤并排显示

## 验证结果

- ✅ 1440px 桌面：Hero、4 个滚动步骤、底部两栏、CTA、Footer 布局正常
- ✅ 390px 移动：场景垂直滚动正常，底部堆叠正确
- ✅ Reduced-motion：场景静态展开，4 个步骤并排，无动画
- ⚠️ 字体加载失败（路径相对于 HTML 文件，需要调整）

## 与 v1 对比

| 维度 | v1 (relay-website-preview.html) | v2 (relay-website-preview-v2.html) |
|------|--------------------------------|-----------------------------------|
| 内容板块 | Hero + 流程场景 + Projects + Knowledge + Memory + Getting started | Hero + 流程场景 + Getting started（合并底部） |
| 场景步骤 | 4 步（Token → Scope → Execution → Audit） | 4 步（Auth → Knowledge → Execute → Memory） |
| 交互演示 | 环境切换、搜索、Memory 拖拽 | 无独立交互，只有滚动 |
| 颜色 | 纯黑 (#08090a) + 纯白 + 黄绿 (#e4f222) | 深炭黑 + 柔和白 + 青蓝/紫/绿渐变 |
| 信息密度 | 低（每个概念一屏） | 高（底部压缩到一屏） |
| 文件大小 | ~28 KB | ~23 KB |

## 下一步

如果用户满意 v2 设计：
1. 调整字体路径或内嵌 base64
2. 根据实际架构图调整 SVG 节点位置和标签
3. 移植到 `frontend/src/pages/Landing.tsx`
4. 更新 `docs/product-website-design.md`

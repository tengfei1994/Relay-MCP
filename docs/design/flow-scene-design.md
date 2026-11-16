# Relay MCP 流程场景重设计

## 目标
替换现有 `relay-website-preview.html` 中的滚动场景，展示完整的 MCP 调用 + Knowledge 检索 + 远程执行 + Evidence 捕获 + Memory 审核确认的循环。

## 保留部分
- Hero（"Connect your agent. Keep the context."）
- Getting started（3 steps + config）
- FAQ
- Footer

## 删除部分
- 独立的 Projects/Knowledge/Memory 三个板块
- 环境切换器、搜索框、Memory 拖拽演示

## 新的滚动场景结构

### 视觉布局
```
┌─────────────────────────────────────┐
│  Codex (左上)                        │
│    ↓ (请求线)                        │
│  Relay (中心，钻石形状)               │
│    ↓ ↓ ↓ (三条路径)                  │
│  Knowledge DB   SSH Server   Agent   │
│    (左下)        (右下)      (右下)   │
│                                     │
│  Evidence → Candidate → Review      │
│             → Memory (底部流程)      │
└─────────────────────────────────────┘
```

### 滚动阶段（4 个步骤）

**Step 1: Authenticate & scope (0-25%)**
- 高亮：Codex → Relay，Token 验证图标亮起
- 文案："Codex sends `fetch_logs` with MCP Access Token. Relay checks the token, project and server scope."
- 代码示例：`tools/call fetch_logs Authorization: Bearer ****`

**Step 2: Retrieve Knowledge (25-50%)**
- 高亮：Relay → Knowledge DB，返回文档卡片
- 文案："Relay searches product documents and confirmed Memory for relevant context. Only authorized scopes are queried."
- 示例卡片：一个 Case Memory 的标题和摘要

**Step 3: Execute on target (50-75%)**
- 高亮：Relay → SSH Server 或 Agent，命令执行动画
- 文案："Relay reaches the analysis server over SSH or hands the job to a Relay Agent. Results and logs are captured as Evidence."
- 示例：`[SSH] tail -n 100 /var/log/app.log` → Evidence ID

**Step 4: Review and confirm Memory (75-100%)**
- 高亮：Evidence → Candidate → Administrator review → Confirmed Memory
- 文案："The agent submits what it learned. An administrator reviews the outcome and conditions, then confirms it as Project or General Memory."
- 状态变化：Pending → In review → Confirmed（绿色勾选）

### 颜色方案（降低对比）
```css
--bg: #0a0b0d
--surface: #13141a
--text: #e8e9f0
--muted: #9ea2b8
--accent: #b8f24e (降低饱和度的黄绿)
--knowledge-glow: #4a90e2 (青蓝)
--execution-glow: #9b59b6 (紫色)
--memory-glow: #2ecc71 (绿色)
--evidence: #f39c12 (琥珀)
```

### 尺寸
- 桌面：1080px 宽 SVG，保持现有 aspect-ratio
- 移动：切换到垂直布局，Codex 在顶，Memory 在底

## 实现策略
1. 复用现有的 `.relay-scene` 滚动容器和 `--intro`, `--build-in` 等 CSS 变量
2. 重绘 SVG：Codex(左上) → Relay(中心) → Knowledge/Server/Agent(下方) → Evidence/Candidate/Memory(底部)
3. 4 个步骤面板，复用现有的 `.steps-panel` 淡入淡出逻辑
4. 删除 `#projects`, `#knowledge`, `#memory` 三个独立 section
5. 压缩 Getting started + FAQ 到一屏（`display: grid; grid-template-columns: 1fr 1fr`）

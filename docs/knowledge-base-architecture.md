# Relay MCP 知识库功能设计

**文档版本**：v1.1  
**日期**：2026-09-02  
**适用范围**：Relay MCP、SampleManager LIMS 技术案例库、PT/EM/Global Pharma 等解决方案扩展

## 1. 目标与定位

知识库用于把开发、部署、故障排查和验证过程中产生的经验，沉淀为可审计、可检索、可复用的技术知识。

它不是简单的聊天历史，也不是把所有经验硬编码到 Skill 中，更不是一开始就建设一个图数据库。推荐定位如下：

```text
Relay MCP Control Plane       权限、Project、Server、LIMS Instance、Job、Deployment、Audit
Knowledge Plane               Case、Pattern、Playbook、Evidence、Relation、RAG
Execution Plane               SQL、Form、Assembly、Build、Deploy、Cache、Restart、Playwright
Model Provider Layer          Embedding、Rerank、结构化抽取、脱敏
```

核心原则：

1. 原始工程证据、技术案例、派生索引分开保存。
2. RAG 是检索层，不是知识库本体。
3. 关系表/图谱是影响分析层，不是经验事实源。
4. Skill 只负责路由、稳定规则和执行规范。
5. 自动生成候选知识，受控批准知识生效。
6. 所有 SampleManager 经验都必须带版本、环境和证据来源。

### 实施前置条件

进入阶段 0/1 前必须明确并落实以下三项：

1. `knowledge.db` 的 schema 迁移机制和唯一变更来源；
2. Relay 最小领域事件与 outbox 机制；
3. MCP 工具按域注册，新 Knowledge 工具不再追加到巨型 `src/mcp/index.ts`。

## 2. 产品边界

### 2.1 技术知识库与客户案例库分离

Relay MCP 技术知识库与现有客户案例库不是同一类产品，应分别管理：

```text
客户案例库
  case-index.xlsx + 客户文件夹/附件
  管理客户全称、简称、行业、GMP、地区、合同、验收等信息

技术 Casebook
  Markdown/YAML + 证据附件 + Git
  管理 SampleManager 故障、配置、代码、部署、验证和适用边界
```

两者通过 `customer_case_id`、`project_id` 或 `deployment_id` 建立关联，不能互相取代。

### 2.2 知识对象分层

| 对象 | 用途 | 默认状态 |
|---|---|---|
| Fact | 当前环境中的短事实，如版本、路径、缓存位置 | 可自动记录，但必须有来源和时间 |
| Evidence | XML、C#、SQL、DLL、日志、部署记录、测试产物 | 不可变或追加式保存 |
| Case | 一次真实事件的症状、证据、根因、修复、验证 | 可自动生成草稿 |
| Pattern | 从多个案例或评审中提炼的可泛化经验 | 自动提议，受控批准 |
| Playbook | 可执行的检查清单、决策树、回滚和验证步骤 | 需版本化和审核 |
| Skill | Agent 的稳定路由、行为规则和工具规范 | 通过代码/配置评审发布 |
| Relation | 对象之间的确定性依赖关系 | 从证据抽取，不允许模型臆测 |

知识晋级链路：

```text
Observation / Evidence
        ↓
Case Candidate
        ↓
Reviewed Case
        ↓
Pattern Candidate
        ↓
Approved Pattern
        ↓
Versioned Playbook
        ↓
Skill routing rule
```

## 3. 总体技术架构

```text
Codex / Claude / Cursor / Web UI / CLI
                    │
          MCP / REST / 管理后台适配层
                    │
    Project Scope、版本过滤、权限、审计、Trace
                    │
             Knowledge Application Layer
       ┌──────────┬──────────┬──────────┐
       │ Case     │ Retrieval│ Capture  │
       │ Service  │ Service  │ Worker   │
       └──────────┴──────────┴──────────┘
          │           │           │
     Casebook      FTS/Vector   Provider
     Git files     indexes      adapters
          │           │           │
     Evidence Ledger / Relation Store
                    │
              Relay Execution Plane
```

### 3.1 Relay MCP 继续承担的职责

- 用户、MCP Token、Project 和 Server 权限；
- Project–Server–Environment–LIMS Instance 解析；
- SSH/Agent 远程执行；
- Job、Deployment、Audit 和回滚；
- SampleManager 的 SQL、Form、Assembly、Build、Cache、Restart、Playwright 工具；
- Knowledge Tool、Resource 和管理 UI 的统一入口。

### 3.2 新增 Knowledge Plane

建议在现有 TypeScript 项目内新增独立模块，而不是重写 Relay：

```text
src/knowledge/
  domain/          Case、Pattern、Playbook、Evidence、Relation 类型和 Schema
  repositories/    数据库、Git 文件和附件访问
  ingestion/       Markdown/YAML、日志、Job、Deployment 导入
  retrieval/       FTS、向量、混合检索、重排序
  extraction/      事实、案例、标签和关系抽取
  providers/       Embedding、Rerank、Inference、Redaction 接口
  policy/          权限、脱敏、晋级和自动化策略
  orchestration/   知识捕获和 SampleManager 诊断编排
  mcp/             MCP 工具和 Resource 注册
  web/             检索、审核、反馈和索引状态 API
```

现有 MCP 注册层位于单一入口文件。新增工具应按域拆分，例如：

```text
src/mcp/tools/knowledge.ts       Knowledge 工具和 Resource
src/mcp/tools/diagnostics.ts     诊断和影响分析工具
src/mcp/register-tools.ts        各域注册函数的统一编排
src/mcp/index.ts                 认证、依赖构造、Transport 和启动入口
```

可以渐进迁移现有工具，但 Knowledge 功能从第一版开始遵守按域注册规则。

## 4. 存储架构

第一阶段保持现有技术栈：TypeScript + Drizzle + SQLite，但必须区分控制平面和运行时状态的实际存储。当前项目的控制平面关系表主要由 Drizzle/SQLite 管理，而 Job、Deployment、Agent 等运行时状态仍有 JSON/JSONL 文件。Knowledge 模块不能继续扩大这种双源真相。

```text
data/app.db             Relay 控制平面
data/knowledge.db       Case、Evidence、Relation、审核和索引元数据
workspace/casebook/     Git 管理的 Markdown/YAML
workspace/evidence/     日志、报告、XML、源码快照、部署产物
workspace/indexes/      FTS 和向量索引的派生文件
```

不要把完整案例只放在 `context/*.jsonl`。现有 `context_record_fact` 和 `context_search` 保留为兼容接口，内部可逐步迁移为 `kind=fact` 的知识项。

### 4.1 Schema 和 Store 约束

- `knowledge.db` 使用独立 schema 和显式 migration 目录；不得新增不可追踪的内联 `ALTER TABLE`。
- migration 文件是 Knowledge DB 的唯一结构变更来源；生成、执行和版本号均需记录。
- Knowledge Store 必须支持 `dbPath`、`casebookRoot`、`evidenceRoot` 和时钟等依赖注入，禁止把数据库连接做成不可替换的模块级单例。
- 现有 Relay 控制平面 schema 不在本项目中一次性重构；但 Knowledge 模块不得复制用户、Project 和权限数据，而应通过稳定的 `project_id`/ACL 适配读取。

### 4.2 `context_*` 兼容迁移

当前 `context_search` 是按 `userId + project name` 定位 JSONL 文件并进行小写子串匹配。迁移到 `knowledge_facts` 时：

- 通过 `userId + project name` 查找现有 `projects.id`；
- 找不到对应 Project 时保留 `project_name_snapshot`，标记为 `unresolved`，不得强行归属；
- 第一版保留旧接口的默认行为，新增 `knowledge_search` 提供 FTS、向量和版本过滤；
- 后续如需切换检索实现，应提供显式模式参数或版本开关，避免存量调用方出现隐式语义变化；
- JSONL 原文件在迁移完成并验证前保留为可回滚来源。

### 4.3 最小数据表

```text
knowledge_documents
knowledge_chunks
knowledge_facts
knowledge_cases
knowledge_patterns
knowledge_playbooks
knowledge_evidence
knowledge_relations
knowledge_ingest_runs
knowledge_reviews
knowledge_feedback
knowledge_acl
knowledge_fts
```

关键字段应包括：

- `id`、`kind`、`title`、`body`、`status`；
- `project_id`、`customer_case_id`、`deployment_id`；
- `samplemanager_version`、`solution`、`module`、`environment`；
- `source_path`、`source_commit`、`source_locator`、`sha256`；
- `created_at`、`verified_at`、`expires_at`；
- `created_by`、`reviewed_by`、`confidence`；
- `embedding_model`、`embedding_dimensions`、`chunk_hash`。

### 4.4 Markdown/YAML 技术案例格式

```yaml
id: PT35-INC-20260901-001
title: 隐藏取样工具页的静态必填阻止普通 Instrument 保存
kind: case
status: verified
scope:
  solution: PT 3.5
  samplemanager: 21.1
  module: Instrument
symptoms:
  - Apply 无反应
  - OK 首次无效，第二次才关闭
root_cause:
  - Instrument.xml 中 SamplingHygieneStatus 静态 mandatory=true
  - 对非 SAMPLING_TOOL 隐藏页面仍参与校验
fix:
  - XML 默认 mandatory=false
  - Task 根据类别设置 IsMandatory
  - OnPreSave 中重新执行类别判断
evidence:
  - form: Instrument.xml
  - task: SamplingInstrumentTask.cs
  - deployment: deploy-1788277180718-bf37vg
verification:
  - build: 0 warnings, 0 errors
  - form_cache: FormsBin cleared
  - ui_smoke_test: passed
applicability:
  - PT 3.5 / SampleManager 21.1
tags:
  - form-validation
  - conditional-mandatory
  - instrument
```

案例正文中必须分别写出：事实、推断、验证结果和适用边界。

## 5. 自动知识生成

### 5.1 事件来源

当前 Relay 的 `writeAudit` 是审计写入，不等同于可订阅的领域事件机制。知识捕获链路必须先引入最小事件发射点；不建议长期依赖 tail `audit.jsonl` 作为唯一入口。

推荐第一版采用轻量 outbox：

```text
job-store / deployment-store
        ↓
emitDomainEvent()
        ↓
append-only event outbox
        ↓
Knowledge Capture Worker
        ↓
checkpoint + idempotent processing
```

最小事件应包含 `eventId`、`type`、`projectId`、`jobId`、`deploymentId`、`occurredAt` 和结构化 `payload`。第一版可以使用 Knowledge DB 表或受控 JSONL 实现，但必须支持重试、消费状态和幂等键。

知识捕获 Worker 从这些事件和产物中发现候选知识：

- Job 完成、失败、重试和取消；
- Deployment 成功、失败、回滚和恢复；
- Build、Form/Assembly 检查和 SQL 查询；
- FormsBin 清理、服务重启和日志读取；
- Playwright/UI smoke test 结果；
- 用户明确标记“值得记录”的经验；
- 同类错误或 Playbook 的重复出现。

### 5.2 自动生成管道

```text
领域事件 / 文件 / 日志 / 测试产物
              ↓
Observation + Evidence Ledger
              ↓
规则预处理、脱敏、去重
              ↓
模型生成 Case Candidate
              ↓
Schema 校验 + 证据一致性校验
              ↓
版本/项目/模块/权限分类
              ↓
FTS/Embedding 索引
              ↓
审核队列或自动标记
```

### 5.3 可自动化与必须受控的范围

| 能力 | 自动化建议 |
|---|---|
| 事件采集 | 全自动 |
| 文件哈希和证据登记 | 全自动 |
| 摘要、标题、标签、分类 | 自动生成，Schema 校验 |
| 相似案例去重 | 自动建议，保留原记录 |
| 版本和 Project 过滤 | 规则强制执行 |
| XML/C#/数据库关系抽取 | 优先确定性解析 |
| Case 草稿 | 自动生成 |
| Verified Case | 由部署/构建/测试证据判定，生产环境建议审核 |
| Pattern | 自动提议，至少多个案例或人工评审后批准 |
| Playbook | 必须版本化、审核、回归验证 |
| Skill 修改 | 只生成 Git diff/变更建议，禁止模型直接发布 |

结论：发现、抽取、组织和索引可以高度自动化；知识生效和行为改变必须有策略门禁。

### 5.4 自动化等级

```text
L0 只记录事件
L1 自动生成候选知识
L2 自动分类、去重和索引
L3 自动生成带证据的案例草稿
L4 自动批准 Pattern/Playbook/Skill
```

默认开启 L0～L3，默认关闭 L4。涉及 GMP、结构、权限、审计、生产部署或业务规则时必须人工确认。

## 6. RAG 检索设计

### 6.1 混合检索流程

```text
解析当前 Project / Environment / LIMS Instance
        ↓
权限和版本预过滤
        ↓
SQLite FTS5 关键词召回
        ↓
Embedding 语义召回
        ↓
合并、去重、版本匹配加权
        ↓
可选 Rerank
        ↓
返回案例、证据、适用边界和匹配原因
```

第一阶段使用 SQLite FTS5；数据量或并发显著增长后，再将向量索引迁移到 PostgreSQL + pgvector。迁移不改变 Casebook 和 Evidence 的事实源。

### 6.2 强制过滤维度

- 用户和 Project ACL；
- SampleManager 版本和 build；
- 行业解决方案版本，如 PT 3.5、EM 1.0；
- 模块；
- 环境；
- 状态；
- 证据完整性；
- 有效期和弃用状态。

### 6.3 MCP 工具

建议增加：

```text
knowledge_search
knowledge_get
knowledge_evidence_get
knowledge_relation_query
knowledge_playbook_get
knowledge_ingest
knowledge_reindex
knowledge_feedback
samplemanager_diagnose
samplemanager_impact_analysis
```

`knowledge_search` 返回 Case/Pattern/Playbook 的摘要、匹配分数、版本匹配、状态、证据引用和适用边界；完整正文通过 `knowledge_get` 或 Resource URI 按需读取。

推荐 Resource URI：

```text
knowledge://case/{id}
knowledge://pattern/{id}
knowledge://playbook/{id}
knowledge://evidence/{id}
```

## 7. Provider 与大模型关系

Provider 是知识处理能力的适配接口，不等于 Relay MCP 必须绑定某个大模型。

```ts
interface EmbeddingProvider {
  modelId: string;
  dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

interface RerankProvider {
  rerank(query: string, documents: string[]): Promise<number[]>;
}

interface InferenceProvider {
  generateStructured<T>(request: ModelRequest): Promise<T>;
}

interface RedactionProvider {
  redact(text: string): Promise<RedactionResult>;
}
```

至少支持：

- 本地模型；
- 企业内部模型网关；
- 云端模型 API；
- 可选的交互式 MCP Host Sampling。

Provider 配置应按组织、Project 或环境策略管理，API Key 通过安全配置注入，不能出现在案例正文、日志或 MCP 参数中。

### 7.1 三种模型调用模式

#### 模式 A：模型在 MCP Host

Codex/Claude 调用 `knowledge_search`，由 Host 自己总结和决定后续工具调用。Relay 不持有模型密钥，适合交互式问答。

#### 模式 B：Relay Knowledge Worker

任务结束后异步运行摘要、抽取、分类和 Embedding。适合无人值守的知识捕获和批量索引，是后台自动生成的推荐模式。

#### 模式 C：MCP Sampling

Relay 在交互式场景请求 Host 提供模型采样。它适合“根据刚才任务生成案例草稿”，但不能作为唯一后台管道，因为依赖当前客户端能力和用户授权。

推荐组合：模式 A 用于问答，模式 B 用于后台自动化。模式 C 仅作为实验性、可选的交互式补充，不得成为知识生成、索引或诊断的关键路径。

## 8. 确定性关系与影响分析

第一阶段使用关系表，不直接引入图数据库。

```text
MASTER_MENU --invokes--> TASK
TASK --implemented_by--> ASSEMBLY
FORM --registered_by--> FORM row
FORM --uses--> SERVER TASK
FORM --contains--> PAGE / CONTROL
CONTROL --binds_to--> ENTITY PROPERTY
DEPLOYMENT --installs--> ARTIFACT
ARTIFACT --evidences--> RELATION
INSTANCE --uses--> CACHE
```

每条关系必须记录：

- 来源文件、表、程序集或日志；
- 定位信息；
- SampleManager/解决方案版本；
- Environment；
- 确定性、置信度和验证状态；
- 提取时间和工具版本。

关系表跨项目影响分析变成高频需求后，再投影到 Neo4j 或其他图数据库。图数据库仍然是派生索引。

## 9. 诊断编排器

新增只读高级工具 `samplemanager_diagnose`，负责把知识检索和当前环境检查组合起来：

```text
问题描述
  ↓
检索 Playbook、Pattern 和历史 Case
  ↓
检查当前版本、Project 和 Environment
  ↓
执行 Form–Task–Menu–Assembly 合同检查
  ↓
读取日志、部署记录和缓存状态
  ↓
生成事实 / 证据 / 推断 / 未知 / 建议报告
```

真正的修改仍使用现有变更集、部署、备份、重启和回滚工具，并单独审计。

## 10. 安全、权限和数据治理

- Knowledge 查询必须复用 MCP Token 的 Project 和 Server scope。
- 客户、生产环境和 GMP 案例必须按 ACL 隔离。
- 自动脱敏密码、Token、连接字符串、个人信息和受控数据。
- 原始 Evidence 追加式保存，删除要保留审计记录。
- Evidence 使用 SHA-256 内容寻址并对重复附件去重；大型 DLL、日志、源码快照和部署产物必须配置 retention policy。
- 第一版允许手动清理，但清理前必须记录审计事件；生产/GMP 证据默认禁止自动删除。
- Case、Pattern、Playbook 必须有状态、作者、审核者和版本。
- 已弃用知识不能参与默认召回，但应可追溯。
- 模型输出不得绕过部署审批、结构变更流程或生产权限。
- 记录 `traceId`、`projectId`、`knowledgeQueryId`、`retrievalRunId`、`jobId` 和 `deploymentId`。

## 11. 分阶段实施计划

### 阶段 0：数据契约和边界

- 定义 Case、Pattern、Playbook、Evidence、Fact Schema；
- 定义版本、解决方案、模块、环境和状态字段；
- 定义证据引用、脱敏和 ACL 规则；
- 定义晋级门槛和审核角色。
- 确定 `knowledge.db` migration 目录、执行方式和回滚策略；
- 定义 `RelayDomainEvent`、outbox、重试、checkpoint 和幂等规则；
- 定义 Knowledge Store 的路径/连接注入和测试隔离策略；
- 明确 Skill 的审核发布位置；`docs/superpowers/` 仅保存计划和设计文档，不作为运行时 Skill 注册表。

### 阶段 1：自动采集和案例草稿

- 新增 `knowledge.db`；
- 在 Job Store、Deployment Store 等关键生命周期点增加最小领域事件发射点和 outbox；
- 从领域事件、`writeAudit`、Job Store、Deployment Store 和 SampleManager 工具采集事件；
- 生成 Observation、Evidence 和 Case Candidate；
- 将现有 JSONL facts 导入 `kind=fact`，保留可回滚副本。

### 阶段 2：关键词检索

- 实现 Markdown/YAML 导入和 Schema 校验；
- 建立 SQLite FTS5；
- 实现 `knowledge_search`、`knowledge_get`；
- 增加 Project、版本、模块和状态过滤；
- 建立真实问题黄金测试集。

### 阶段 3：确定性关系提取

- 解析 Form XML；
- 解析 `[SampleManagerTask]`、C# 工程和程序集元数据；
- 读取 FORM、MASTER_MENU、Entity Definition、FormsBin 和部署清单；
- 建立关系表和 `knowledge_relation_query`。

### 阶段 4：模型 Provider 和混合 RAG

- 实现 Embedding、Rerank、Inference、Redaction Provider；
- 通过异步 Worker 生成向量和案例草稿；
- 实现混合排序、模型版本记录和索引重建；
- 增加检索反馈和质量评估。

### 阶段 5：诊断编排和审核 UI

- 实现 `samplemanager_diagnose` 和 `samplemanager_impact_analysis`；
- 增加候选知识审核、证据对比、接受/拒绝和 Git diff；
- 增加 Pattern/Playbook 晋级流程；
- 增加人工反馈闭环；
- 复用现有 React/Vite/Tailwind 管理后台、Fastify routes 和 JWT 认证，不新建独立前端工程。

### 阶段 6：规模化和图投影

- 评估 PostgreSQL + pgvector；
- 评估对象存储和大附件管理；
- 将关系表投影到图数据库；
- 增加跨项目、跨版本影响分析和离线评估集。

## 12. 验收标准

第一版可交付的最低标准：

1. 一个真实开发任务可以自动产生 Observation、Evidence 和 Case Candidate。
2. 每个候选案例都能回溯到 Job、Deployment、文件或日志证据。
3. `knowledge_search` 能按 Project、SampleManager 版本、解决方案和模块过滤。
4. 关键词检索结果不依赖大模型也能正常工作。
5. 模型不可直接修改 Skill、Playbook 或生产配置。
6. `context_record_fact` 和 `context_search` 仍保持兼容。
7. Form–Task–Assembly 关系能够显示来源和验证状态。
8. 删除、弃用、审核、索引重建和回滚均有审计记录。
9. 诊断输出明确区分事实、证据、推断、未知和建议。
10. 在明确的基准环境下，10 万个 chunk、热缓存、Project/版本过滤的 SQLite FTS5 查询 P95 < 200ms。
11. Knowledge Store 测试可以注入临时 `dbPath`，并可独立验证 migration、ACL、幂等导入和索引重建。
12. Evidence 清理遵守 retention policy，重复内容可去重，生产/GMP 证据不会被自动删除。

## 13. 最终建议

Relay MCP 不需要变成一个绑定特定大模型的“全能 RAG 平台”。推荐架构是：

```text
Relay MCP
  = 权限、项目上下文、远程执行、部署、审计

Knowledge Plane
  = Casebook、Evidence、Pattern、Playbook、RAG、关系查询

Knowledge Worker
  = 自动采集、模型抽取、Embedding、索引和审核队列

SampleManager Tools
  = 对当前 Form、Task、Assembly、数据库、缓存和部署环境进行事实验证
```

最重要的产品原则是：

> 事件自动采集，模型自动提炼，规则自动验证，索引自动更新，知识晋级受控，Skill 通过评审发布。

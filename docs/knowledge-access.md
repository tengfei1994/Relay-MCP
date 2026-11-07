# Knowledge、Memory 与 MCP 使用说明

本文描述当前访问规则和迁移要求。运行时 `tools/list` 是工具参数和注解的权威来源。

## 访问范围

| 内容 | Web 用户 | MCP 令牌 |
|---|---|---|
| 已发布的产品和解决方案文档及 Chunk | 用户必须拥有“产品知识和通用 Memory”权限；不依赖 Project | 同用户权限；可以没有任何 Project 或 Server 范围 |
| 项目 Memory | 必须能访问该 Project；不依赖产品知识开关 | 用户和令牌均须能访问该 Project |
| 通用 Memory | 用户必须拥有“产品知识和通用 Memory”权限；不要求 Project | 同用户权限；可以没有 Project 范围 |
| Wiki | 公共页面遵循产品权限；项目页面及其项目来源遵循 Project 权限 | 不提供 Wiki MCP 工具或 Knowledge MCP Resource |

管理员身份用于管理和审核；它不会自动授予产品文档、通用 Memory 或整个 Project 的读取权。已有用户开关值保留；管理员创建和自行注册的新用户默认关闭，管理员可在用户管理中为自己或其他用户开启。权限和令牌范围变更会在后续请求中重新检查。

没有 Project 范围的令牌不能访问项目工具或项目 Memory。`projectId` 可传允许范围内的 Project ID 或名称；传入无权访问的 Project 会失败。带 `both` 的 Memory 搜索如果缺少通用权限，只返回有权访问的项目记录，并报告 `generalAccess: "denied"`；单独请求通用 Memory 会被拒绝。

Web 会话、MCP Access Token 与 Relay Agent Token 分别用于对应入口，不能互相替代。受 MCP Token 管辖的临时文件传输会在读取或上传时重新检查账户状态、项目权限及原 Token 范围。升级前生成且没有来源信息的短期传输链接会失效，需要重新创建。

## 五个 Knowledge 工具

| 工具 | 用途 |
|---|---|
| `knowledge_search` | `query` 必填；可选 `productVersion`、`solution`、`module`、`language`、`limit`。返回已发布产品文档的 Chunk、文档和片段 ID、来源及引用；不接受 Project 过滤。 |
| `knowledge_get` | 用 `documentId` 读取文档，或同时传 `chunkId` 读取属于该文档的一个片段。 |
| `memory_search` | 搜索管理员确认的 Memory；`query` 可为空。`scope` 为 `project`、`general` 或 `both`，支持 `projectId`、`type`、`limit`、`offset`。有默认 Project 时默认搜索该项目和通用 Memory，否则默认通用。 |
| `knowledge_confirmed_memory_get` | 按 `memoryId` 读取一条有权访问的已确认 Memory。 |
| `memory_capture` | 用 `action: "submit"` 提交候选，或用 `action: "status"` 查询提交状态。该工具有写入操作，不能审核或发布。 |

旧 Knowledge MCP 工具、`context_record_fact`、`context_search` 和 `knowledge://` Resource 均已移除，没有兼容模式。客户端应重新获取工具列表并迁移，不要继续调用旧名称。旧 Work Session、Candidate、Wiki、Evidence 和运维数据仍保留，相关操作使用网页或受控后台接口。

## 本地 Agent 提交候选

Agent 应先完成必要的调查和调试、与用户沟通，并自行判断经验是否值得复用。只提交整理后的内容；不要提交隐藏推理、无关对话、凭据或每次工具调用的原始记录。

以下是请求参数示例，其中 `projectId`、`evidenceRefs`、`sourceRefs`（Agent 提供的来源说明）和 `workSessionId` 按实际情况提供。`sourceRefs` 不是独立核验证据：

```json
{
  "action": "submit",
  "idempotencyKey": "experience-2026-001",
  "requestedScope": "project",
  "projectId": "42",
  "title": "连接重置后的恢复步骤",
  "memoryType": "Case",
  "statement": "重置连接后重新建立客户端会话，并检查连接状态。",
  "objective": "恢复实验室客户端连接",
  "outcome": "连接恢复",
  "applicability": "已验证的部署环境",
  "unknowns": ["其他产品版本是否适用"]
}
```

项目候选必须关联可访问的 Project；也可建议通用范围并保留来源 Project。没有外部证据也能提交，审核页面会明确标注，Agent 的陈述不等于独立验证。相同提交重试应复用同一个幂等标识；内容改变时必须使用新标识。提交返回候选 ID 和状态；`status` 使用该 ID，只允许提交者或管理员查看。要求补充后，使用新幂等标识提交修订内容。

管理员在 Memory → Submissions 查看新候选、历史 Candidate 和 Candidate Insight，编辑、确认范围并填写原因后才能将经验发布为正式 Memory，也可拒绝或要求补充。历史全局／组织 Memory 先进入范围复核，不会因迁移自动扩大可见范围。来源于项目的通用 Memory 应删除项目私有内容；其来源和 Evidence 仍按来源项目权限控制。服务器保留运行审计和必要观察记录，不因普通工具事件自动生成候选或调用模型。

## 文档分类与 Wiki

产品文档必须同时处于已发布状态并分类为 `product` 才能进入公共产品搜索或按 ID 读取。历史项目关联资料（包括仅记录了来源 Project 的资料）进入分类队列；未分类时不公开。管理员导入时必须选择产品／解决方案资料或项目专属资料；来源 Project 可用于追溯，不改变已确认公共产品资料的授权规则。Wiki 的来源不能扩大原文档的访问范围。

在分类队列中可分页预览待审核原文，预览会记入审计。此入口只用于该项分类审核，不授予整个来源 Project 的访问权。已分类文档不能通过该队列直接重新分类；托管引擎的原文必须能完成来源与内容校验才能预览。

分类队列中的 **View classification report** 展示待处理、产品和项目资料的数量，以及每项决定、原因、记录的审核人和时间；未记录审核人的历史项会明确标注。具备产品知识权限的管理员也可以分页读取 `/api/knowledge/product-classifications/report`，在受保护的位置保存各页作为发布记录。报告不包含服务器文件路径；报告反映当前状态，不能替代对真实资料的人工分类。

Wiki 新版本保存当时的来源范围并在查看、比较或回滚前重新核验。旧历史版本如缺少可核实的来源快照，将保留原始记录，但不会通过网页展示或回滚，直到其来源可被核实；当前页面仍按其现有来源权限访问。

本地后端从本地已发布 Chunk 检索；托管引擎以已发布、已核验的映射和 Chunk 为准，不在引擎不可用时静默回退到旧索引。无结果、权限错误和服务不可用应分别处理。

## 升级和回滚

1. 在非生产环境先备份应用数据库、Knowledge 数据库、Evidence、引擎数据及配置，包括现有 Provider 凭据加密密钥；确认备份可恢复。
2. 使用匹配版本启动服务，执行数据库迁移；保留用户授权值、Memory ID、历史审核和文档来源。重复启动不应重复迁移。旧 `context_*` 事实和旧候选不会自动成为已确认 Memory。
3. 在分类队列审核项目关联文档，在范围复核队列审核历史全局／组织 Memory。校验公共页面和项目页面的来源。
4. 使用不同用户及有／无项目范围的 MCP 令牌测试产品、通用 Memory、项目 Memory、Wiki、Evidence 和直接 ID；撤销权限后用已有登录和令牌再次验证。
5. 核对五个 Knowledge 工具、Agent 客户端、审核页面和运维监控，再按现有发布流程上线。回滚时恢复相互匹配的应用版本、数据库、Evidence、引擎数据和配置备份。

## 验证入口

在代码工作区运行 `npm test`。`tests/knowledge-access-v2.test.ts`、`tests/knowledge-access-http-mcp.test.ts` 覆盖新权限、审核规则和分类报告；`tests/knowledge-migration-rehearsal.test.ts` 使用合成数据演练 SQLite 备份、迁移、分类和恢复，Evidence、引擎和配置在此测试中是模拟文件。引擎自身的备份恢复由 `tests/knowledge-engine-runtime.test.ts` 单独覆盖。`scripts/knowledge-scope-contract-acceptance.ts` 与 `scripts/knowledge-mcp-fault-acceptance.ts` 使用隔离数据库和本机模拟服务验证 HTTP、MCP、过滤与故障恢复，不代表真实托管服务验收。

`tests/knowledge-v2-real-e2e.test.ts` 启动独立的本机 Web 与 MCP 服务，使用合成账号和资料验证普通调用、候选提交与幂等、管理员审核、检索、权限撤销及令牌删除。它不代表真实托管引擎或生产资料验收。

可在非生产环境运行 `node --import tsx scripts/knowledge-v2-smoke.ts --help` 查看只读冒烟检查的配置。提供非生产 MCP 地址、令牌文件和查询后，脚本检查五个工具、写操作注解、产品 Chunk 和 Memory 读取，只输出状态及数量；没有结果时会标明相应读取未被实际验证。分别使用无 Project 范围和有项目范围的令牌运行，并通过网页另行验证候选提交、审核与权限撤销。

历史的 `knowledge-engine-mcp-live.ts`、`knowledge-engine-e2e.ts`、`knowledge-mcp-real-acceptance.ts`、`knowledge-ops-real-acceptance.ts` 和 `knowledge-ops-summary-acceptance.mjs` 基于已移除的工具及旧搜索返回结构，现已阻止执行以避免误用；它们的历史报告仍作为当时版本的记录保留。上线前仍需在非生产环境使用新接口完成端到端验证，不能将历史报告当作本版本通过证明。

旧架构和场景文档中如与本文冲突，以本文和运行时行为为准。

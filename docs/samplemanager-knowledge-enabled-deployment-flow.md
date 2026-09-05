# Knowledge-enabled Relay MCP SampleManager LIMS 远程部署全流程

**文档版本**：v1.0  
**日期**：2026-09-02  
**用途**：为绘制系统架构图、部署时序图、泳道图和故障回退图提供统一流程描述。  
**适用范围**：Relay MCP 集成 Knowledge Plane 后，对 SampleManager LIMS、Pharma Template、Environmental Monitoring、Global Pharma 或其他解决方案工件进行远程开发、验证、部署和知识沉淀。

---

## 1. 一句话流程

~~~text
用户需求
  ↓
识别 Project / Server / Environment / LIMS Instance
  ↓
检索相关 Case / Pattern / Playbook
  ↓
读取并校验源代码、Form、结构、配置和部署清单
  ↓
建立 deploymentId，执行预检和风险门禁
  ↓
备份目标文件/配置/数据库记录
  ↓
按依赖顺序部署结构、配置、程序集、Form、Report
  ↓
清理缓存、重启必要服务
  ↓
执行 SampleManager 命令行、SQL、Report、UI Smoke Test
  ↓
采集日志、哈希、结果和审计证据
  ↓
成功：完成部署并生成 Case Candidate
失败：停止、收集证据、回滚或转人工处理
  ↓
Knowledge Worker 生成/更新案例、索引和关系
~~~

核心原则：

- Knowledge Plane 负责找知识、给出检查路径和沉淀证据；
- Relay MCP 负责权限、远程连接、Job、Deployment、审计和文件传输；
- SampleManager 工具负责结构、配置、Form、Task、Assembly、缓存和运行时验证；
- 模型不能绕过部署审批、备份、回滚和生产权限；
- “部署命令成功”不等于“SampleManager 功能成功”，必须完成目标运行时验证。

## 2. 架构图绘制建议

### 2.1 推荐泳道

画泳道图时建议使用以下泳道：

~~~text
User / MCP Host
Relay MCP Control Plane
Knowledge Plane
Knowledge Worker / Model Providers
Remote Transport
Windows Relay Agent 或 SSH Target
SampleManager Instance
Database / File System
Audit / Evidence Store
~~~

### 2.2 逻辑分层

~~~text
┌───────────────────────────────────────────────────────────────────┐
│ User / Codex / Claude / Web UI                                   │
└───────────────────────────────┬───────────────────────────────────┘
                                │ MCP / REST
┌───────────────────────────────▼───────────────────────────────────┐
│ Relay MCP                                                         │
│ Auth · Project Scope · Server Link · Job · Deployment · Audit     │
└───────────────┬───────────────────────────────┬───────────────────┘
                │                               │
                │ Knowledge tools               │ Execution tools
┌───────────────▼───────────────┐   ┌─────────▼─────────────────────┐
│ Knowledge Plane                │   │ SampleManager Execution Plane │
│ Case · Pattern · Playbook      │   │ SQL · Form · Assembly · Build │
│ Evidence · Relation · RAG      │   │ Deploy · Cache · Restart       │
└───────────────┬───────────────┘   └─────────┬─────────────────────┘
                │                             │
┌───────────────▼───────────────┐   ┌─────────▼─────────────────────┐
│ Casebook / knowledge.db       │   │ SSH / SFTP / Relay Agent       │
│ FTS5 / Vector / Relation      │   │ Windows or Linux target       │
└───────────────────────────────┘   └─────────┬─────────────────────┘
                                                │
                              ┌─────────────────▼────────────────────┐
                              │ SampleManager Instance                │
                              │ Exe · Forms · FormsBin · Assemblies   │
                              │ Database · Services · Logs            │
                              └────────────────────────────────────────┘
~~~

## 3. 参与对象和职责

| 对象 | 主要职责 |
|---|---|
| User / MCP Host | 提出需求、确认目标、批准高风险变更、执行人工验收 |
| Relay MCP Control Plane | 认证、Project/Server scope、环境选择、Job、Deployment、Audit |
| Knowledge Plane | 检索历史案例、生成检查建议、管理 Evidence/Case/Pattern/Playbook |
| Knowledge Worker | 从任务事件、日志和产物中生成 Case Candidate、标签、Embedding 和关系 |
| Model Provider | 结构化摘要、分类、Embedding、Rerank、脱敏；可插拔，不绑定唯一大模型 |
| Remote Transport | SSH/SFTP 或 Windows Relay Agent；负责远程命令、文件传输和结果回传 |
| SampleManager 工具层 | 版本发现、表结构、Entity Definition、convert_table、VGL、程序集、Form、缓存、服务和日志操作 |
| SampleManager Instance | 实际运行的 Exe、Form XML、FormsBin、程序集、数据库、服务和应用客户端 |
| Evidence Store | 保存文件哈希、日志、命令结果、测试结果、部署记录和证据引用 |

## 4. 前置输入

部署开始前必须明确：

~~~text
project
server / server link
environment
lims instance
SampleManager version and build
solution/template version
artifact source commit
deployment scope
operator and approval
~~~

### 4.1 版本边界

必须区分：

- Base SampleManager 版本；
- Pharma Template PT 版本；
- Environmental Monitoring 版本；
- Global Pharma Solution 版本；
- Process Management Solution 版本；
- 目标数据库类型；
- 目标实例和环境。

例如 PT 3.5 的部署包和补丁是 SampleManager 21.1 绑定的，不能直接推广到 SampleManager 21.3。版本不匹配时，流程应在预检阶段停止。

## 5. 端到端详细流程

以下每一步都包括：目的、主要工具、输入、输出和流程门禁。

### Step 0：接收部署请求

**目的**

把自然语言需求转换成可执行的部署任务，例如修改 Instrument Form、新增结构字段、更新 Task Assembly、加载 Master Menu/角色配置、部署 REPX 报表、清理 FormsBin 或执行 PT/EM 初始化 VGL。

**调用方式**

- MCP Host → knowledge_search（若用户已描述问题或历史背景）；
- MCP Host → list_projects；
- Relay Web UI → Project/Server/LIMS Instance 选择页面。

**输入**

用户需求、目标项目、目标环境、可选版本和模块。

**输出**

~~~text
deployment_request
  requestId
  project
  environment
  requestedScope
  requestedArtifacts
~~~

**门禁**

- 未选择 Project，停止；
- Project 没有关联 Server/LIMS Instance，停止；
- 目标环境为生产时，标记为高风险并要求审批。

### Step 1：解析有效目标上下文

**目的**

确定本次操作实际连接哪个服务器、实例、目录、数据库和环境，防止把文件部署到错误实例。

**主要工具**

- relay_route_check；
- project_server_links_list 或 relay_project_server_links_list；
- list_projects；
- 内部 selectProjectTarget；
- samplemanager_discover_build_tools；
- samplemanager_capabilities。

**检查内容**

~~~text
Project 是否允许
Server 是否在 MCP Token Allowed Servers 中
Environment 是否匹配
LIMS Instance 是否可用
远程路径和 Exe 路径是否存在
Forms、FormsBin、SolutionAssemblies、Data、Log 路径是否正确
SampleManager 版本、运行时类型和数据库配置
~~~

**输出**

EffectiveTarget，包括 projectId、serverId、environment、limsInstanceId、instanceRoot、exePath、formsPath、formsBinPath、assembliesPath、dataPath、logfilePath、database、version 和 solutionPack。

**门禁**

版本、实例或环境不明确时不得继续。所有后续工具必须使用同一个 EffectiveTarget，禁止每一步重新猜测目标。

### Step 2：检索案例、Pattern 和 Playbook

**目的**

在修改前获取相关历史经验、版本边界、常见陷阱、检查顺序和回滚方法。

**主要工具**

- knowledge_search；
- knowledge_get；
- knowledge_playbook_get；
- knowledge_relation_query；
- 兼容工具 context_search。

**典型查询**

~~~text
Form 保存无反应
Instrument Sampling Tool conditional mandatory
Server Task control contract
FormsBin stale layout
PT 3.5 SampleManager 21.1 table-loader deployment
CreateEntityDefinition convert_table custom assembly
~~~

**强制过滤**

Project/ACL、SampleManager version、solution version、module、environment、status = verified/approved。

**输出**

KnowledgeContext，包括 matchedCases、matchedPatterns、matchedPlaybooks、knownPitfalls、expectedArtifacts、requiredChecks、rollbackNotes 和 evidenceRefs。

**门禁**

- 没有完全匹配案例时可以继续，但必须标记为“无直接历史证据”；
- 只能把案例作为检查依据，不能直接当成当前环境事实；
- deprecated 或版本不匹配知识不能进入默认建议。

### Step 3：读取源代码和部署工件

**目的**

确认本次部署的真实源文件、依赖关系和变更范围，避免直接修改远程运行文件。

**主要工具**

- read_local_file；
- list_workspace_files；
- workspace_file_stat；
- read_remote_file；
- download_remote_file；
- samplemanager_create_deployment_manifest；
- Git diff/commit 检查；
- 本地 XML/CSV/YAML/JSON 解析器。

**典型工件**

~~~text
Form XML
FORM registration data
Master Menu / Role / Toolbar table-loader CSV
structure.txt 或 structure fragment
C# / .csproj / .sln
DLL / PDB / config
VGL .rpf / .lis
Report Designer .repx
Localization .resx
Resource icons
deployment manifest
~~~

**检查内容**

- 文件是否存在；
- 是否有重复键；
- XML/CSV/YAML 是否可解析；
- Form control Name 是否与 Task 代码一致；
- Form Server Task 是否匹配 SampleManagerTask 属性；
- 结构字段是否影响 Entity Definition；
- Task Assembly 是否引用正确的 SampleManager DLL 版本；
- REPX 是否使用目标 DevExpress 版本；
- 是否包含必要的菜单、角色、报表注册和权限行。

**输出**

DeploymentManifest，包括 manifestId、sourceCommit、artifacts、targetPaths、dependencies、hashes、structureChanges、loaderFiles、cacheActions、restartActions、smokeTests 和 rollbackPlan。

**门禁**

manifest 不完整、工件哈希缺失、版本不匹配或依赖未声明时不得部署。

### Step 4：执行只读预检

**目的**

在任何写入、结构变更、服务重启之前，确认目标环境可部署且风险可控。

**主要工具**

- samplemanager_capabilities；
- samplemanager_table_schema；
- samplemanager_validate_form_task_contract；
- samplemanager_inspect_assembly_type；
- samplemanager_sql_query；
- samplemanager_recent_errors；
- samplemanager_discover_build_tools；
- samplemanager_deployment_status；
- relay_unicode_check。

**典型检查**

~~~text
目标表是否存在、列/键/identity 是否匹配
Form registration 是否存在
Form XML 与现有 Task 是否匹配
Assembly 类型和 SampleManagerTask 名称是否存在
目标工具是否可用
Build Tool / MSBuild 是否存在
当前日志是否已有相关错误
远程命令和中文文件传输是否正常
~~~

**输出**

PreflightReport，包括 passedChecks、warnings、blockingErrors、targetEvidence 和 riskLevel。

**门禁**

- 阻断错误存在：停止；
- 仅警告：由策略决定是否需要人工批准；
- 生产/GMP 环境：默认要求人工批准后进入变更阶段。

### Step 5：创建 Deployment 和审计上下文

**目的**

为后续结构、文件、数据库、重启和验证操作建立统一的 deploymentId，让所有操作可以关联、查询和回滚。

**主要工具**

- samplemanager_deployment_start；
- Relay writeAudit；
- Job Store；
- Domain Event / Outbox；
- samplemanager_create_deployment_manifest。

**输出**

~~~text
DeploymentRun
  deploymentId
  requestId
  projectId
  serverId
  limsInstanceId
  environment
  manifestHash
  operator
  approval
  status = running
~~~

**事件**

deployment.started、manifest.created、preflight.completed。

**门禁**

没有 deploymentId 的变更操作不得继续。后续每个异步 Job、文件复制、命令、数据库变更和验证结果都要带上该 ID。

### Step 6：备份目标文件和配置

**目的**

在写入前保留可恢复状态，支持单文件恢复、部署回滚和差异分析。

**主要工具**

- samplemanager_deploy_file（内部先备份）；
- workspace_file_stat；
- download_remote_file；
- samplemanager_sql_query（记录关键配置）；
- samplemanager_sql_mutation 的 before snapshot；
- samplemanager_create_deployment_manifest。

**备份对象**

~~~text
Form XML
FormsBin / localized FormsBin
SolutionAssemblies DLL/PDB/config
Report .repx
VGL source/runtime files
Resource icons
structure source
table-loader target rows
affected database records
~~~

**输出**

BackupSet，包括 backupId、targetPath、originalSha256、backupPath 和 databaseBeforeSnapshot。

**门禁**

任何关键工件无法备份或无法重新生成时，生产部署应停止。备份文件和 SHA-256 必须写入 Evidence。

### Step 7：执行结构和 Entity Definition 变更

**目的**

把结构源文件转换为 SampleManager 可使用的实体定义和物理表结构。

**适用场景**

~~~text
新增字段
修改结构
新增表
COLLECTION 变化
Entity Property 变化
依赖 typed entity / generated entity class 的 Task
~~~

**主要工具**

- samplemanager_deploy_file：部署 structure source；
- samplemanager_create_entity_definition；
- samplemanager_convert_tables；
- samplemanager_table_schema；
- samplemanager_sql_query：只读验证；
- samplemanager_build_dotnet：结构导致 typed entities 变化时。

**推荐顺序**

~~~text
部署 structure.txt / controlled fragment
        ↓
CreateEntityDefinition.exe
        ↓
convert_table.exe（逐表执行）
        ↓
重新构建依赖 typed entities 的程序集
        ↓
查询表结构和 Entity Definition
~~~

**注意事项**

- 普通定制不得直接用 SQL 修改数据库 schema；
- 一张表一条 convert_table.exe 命令更容易定位失败；
- 删除字段、改类型、改主键或索引必须单独审批；
- 日期字段、定长字符串、identity 和系统元数据必须按目标 schema 写入。

**输出**

StructureChangeResult，包括 entityDefinitionResult、convertedTables、schemaAfterSnapshot 和 generatedDependencies。

**失败处理**

结构工具失败时停止后续 Form/Assembly 部署；检查 lis、命令输出和日志，必要时恢复 structure source 和数据库备份。

### Step 8：加载基础配置和注册数据

**目的**

把菜单、角色、Form/Report 注册、配置项、Phrase、Workflow、Toolbar 和其他初始化数据加载到 SampleManager。

**主要工具**

- samplemanager_table_loader；
- samplemanager_deploy_table_loader_package；
- samplemanager_run_command；
- samplemanager_sql_query；
- 必要时 samplemanager_apply_change_set。

**推荐方式**

~~~text
准备 table-loader CSV
        ↓
上传到远程 staging
        ↓
SHA-256 校验
        ↓
通过 SampleManagerCommand.exe
        -task VGL
        -report '$table_loader'
        ↓
验证目标表和关键行
~~~

**重要区别**

- table-loader CSV 必须使用 $table_loader；
- 不能把 table-loader CSV 送入 XML Entity Import 路径；
- PowerShell 中 $table_loader 必须使用单引号；
- overwrite 模式必须确认目标表和备份策略。

**典型注册项**

~~~text
FORM rows
MASTER_MENU
roles / security
toolbar / RMB
report registration
workflow/action/state/node
phrases
icons
solution configuration
~~~

**输出**

ConfigurationLoadResult，包括 filesLoaded、rowsBefore、rowsAfter、commandExitCode 和 loaderLog。

**门禁**

配置行未验证前，不应打开依赖这些行的 Form 或菜单。

### Step 9：构建和部署 Task Assembly

**目的**

部署自定义 Form Task、Menu Task、Background Task 或服务端程序集，使 Form、菜单和后台逻辑可以调用正确的代码。

**主要工具**

- samplemanager_discover_build_tools；
- samplemanager_build_dotnet；
- samplemanager_build_deploy_assembly；
- samplemanager_inspect_assembly_type；
- samplemanager_deploy_file；
- samplemanager_deployment_status。

**推荐顺序**

~~~text
发现目标 SampleManager DLL 和 MSBuild
        ↓
检查 .csproj/.sln 与目标版本
        ↓
构建 C# solution
        ↓
检查 warnings/errors
        ↓
检查输出 DLL/PDB/config SHA-256
        ↓
备份旧程序集
        ↓
部署到 <EXE>\SolutionAssemblies 或项目约定路径
        ↓
反射检查类型、Task 名称、依赖和版本
~~~

**必须验证**

- SampleManagerTask 名称稳定；
- Form Server Task 与程序集 Task 名称一致；
- Form control names 与 C# 代码契约一致；
- Entity Property、Collection 名称与当前 Entity Definition 一致；
- 构建引用的是目标 SampleManager 主/次版本 DLL；
- 非生产环境优先部署 PDB 以便日志定位。

**输出**

AssemblyDeploymentResult，包括 buildResult、warnings、errors、assemblyHash、typeInspection、backupPath 和 targetPath。

**失败处理**

构建失败不得部署；反射检查失败不得进入 Form 验证；程序集加载错误时恢复旧 DLL 并重启受影响进程。

### Step 10：部署 Form、Report、VGL、Resource 和其他文件

**目的**

把已经通过静态和构建检查的运行时文件复制到目标实例。

**主要工具**

- samplemanager_deploy_file；
- write_remote_file；
- upload_workspace_file；
- sync_workspace；
- download_remote_file；
- workspace_file_stat；
- samplemanager_deployment_status。

**典型目标路径**

~~~text
Form XML             <EXE>\Forms 或项目约定 Form 路径
Compiled Form Cache  <EXE>\FormsBin
Assemblies           <EXE>\SolutionAssemblies
REPX                 报表布局目录或项目约定目录
VGL                 Data / Report / Library 约定目录
Resource icons      <INSTANCE>\Resource\Icon
Localization         资源和本地化约定目录
~~~

**部署原则**

- Form XML 不是独立工件，必须与 FORM row、Task Assembly 和 Entity Definition 一起考虑；
- 覆盖标准 Form 时保留原生 Task 需要的控件；
- REPX 必须在目标 DevExpress 版本可加载；
- 中文或其他非 ASCII 文件通过远程通道传输时，必要时使用 UTF-8 Base64，并用 SHA-256 验证文件本体；
- 每个文件都要记录 source hash、target hash 和 backup path。

**输出**

ArtifactDeploymentResult，包括 artifact、sourceSha256、targetSha256、targetPath 和 backupPath。

### Step 11：清理 FormsBin、资源和相关缓存

**目的**

使客户端/服务器重新读取新的 Form、翻译、资源或其他缓存工件。

**主要工具**

- samplemanager_clear_form_cache；
- samplemanager_deploy_file；
- samplemanager_sql_query；
- 远程 PowerShell/SSH（仅用于项目允许的缓存操作）。

**Form 缓存规则**

~~~text
Form XML 变化
  ↓
清理对应 <FORM_NAME>.binform
  ↓
清理受影响的 Translation/<LANGUAGE>/<CULTURE> 缓存
  ↓
完全关闭并重新打开客户端
  ↓
验证新缓存时间晚于部署时间
~~~

**注意事项**

- 只清理实际变更的 Form；
- 不能只清基础缓存而遗漏语言缓存；
- 不能把“文件已复制”当成“客户端已刷新”；
- 资源图标、Web/Portal 和服务端缓存按目标模块单独处理。

**输出**

CacheClearResult，包括 clearedPaths、remainingMatches 和 clientRestartRequired。

### Step 12：重启必要服务或客户端

**目的**

让程序集、Entity Definition、Web/Portal 或配置变更在运行进程中生效。

**主要工具**

- samplemanager_restart_instance；
- restart_service；
- samplemanager_run_command；
- Relay Agent / SSH 远程服务控制；
- 人工关闭并重新打开 SampleManager Desktop。

**重启判断**

| 变更 | 通常动作 |
|---|---|
| Desktop-only Form | 清理 FormsBin，关闭并重新打开客户端 |
| Server-side Task Assembly | 重启相关服务、Task Host 或应用池 |
| Entity Definition/结构 | 按实例缓存策略重启或重新加载 |
| Web/Portal | 重启 IIS App Pool 或对应 Web 服务 |
| VGL/Report | 按报告运行上下文决定是否重启 |
| Resource/Localization | 关闭客户端并清理相关缓存 |

**门禁**

共享环境或生产环境重启前需要人工确认影响范围。只重启受影响服务，避免无必要的全实例重启。

### Step 13：执行静态、构建和离线验证

**目的**

在真实业务操作前确认部署文件和编译产物满足基本技术要求。

**主要工具**

- XML/CSV/YAML parser；
- samplemanager_inspect_assembly_type；
- samplemanager_validate_form_task_contract；
- samplemanager_table_schema；
- samplemanager_deployment_status；
- REPX 本地 DevExpress load test；
- Build logs / lis。

**验证层次**

~~~text
Static
  XML/CSV parse、duplicate key、file existence、hash

Build-time
  C# compile、reference resolution、generated entity compatibility

Offline runtime
  Form XML sanity、REPX load、assembly reflection、command dry run

Target runtime
  SampleManagerCommand、table-loader、SampleManager UI、report、log
~~~

**输出**

OfflineValidationReport，包括 staticChecks、buildChecks、offlineRuntimeChecks 和 unresolvedWarnings。

### Step 14：执行 SampleManager 目标运行时验证

**目的**

确认目标实例中的实际行为，而不是只确认文件和命令成功。

**主要工具**

- samplemanager_run_command；
- samplemanager_table_loader；
- samplemanager_sql_query；
- samplemanager_recent_errors；
- samplemanager_validate_form_task_contract；
- SampleManager Desktop UI；
- Playwright 工具：playwright_run_suite、playwright_run_status。

**典型 Smoke Test**

~~~text
打开目标 Form
确认 Menu 启动正确 Task
切换关键 Tab/Page
确认 Control 存在且绑定正确 Property
测试普通场景和条件分支
测试 Apply / OK / Save / Cancel
运行相关 VGL Report
运行 Report Designer 报表
验证新增字段、配置行、Phrase 和权限
验证缓存重新生成
检查新时间窗口内的错误日志
~~~

**SampleManager 特别要求**

- Form 文件存在不等于 Form 可运行；
- FORM row 存在不等于 Master Menu 调用了正确 Task；
- SQL 配置正确不等于客户端行为正确；
- UI 问题必须用新打开的客户端/新执行验证；
- 涉及 Plate、Batch、Sample、Test、Result、Lab Execution 数据血缘时，应执行实体完整性检查；
- 报表必须使用真实数据运行，不能只做 XML 解析。

**输出**

RuntimeValidationReport，包括 uiTests、commandTests、reportTests、dataChecks、recentErrors 和 screenshotsOrArtifacts。

### Step 15：成功提交或失败处理

**目的**

依据验证结果决定部署是否完成、是否需要回滚或转人工。

#### 成功条件

~~~text
所有必要工件 hash 匹配
结构和配置验证通过
程序集可加载
Form/Report/Task 实际运行
Smoke Test 通过
错误日志无新的阻断错误
缓存和服务状态正确
~~~

**主要工具**

- samplemanager_deployment_finish；
- samplemanager_deployment_status；
- writeAudit；
- knowledge_feedback。

**输出**

DeploymentSuccess，包括 deploymentId、finalStatus、artifacts、validations、logs 和 evidenceRefs。

#### 失败条件

~~~text
结构转换失败
配置加载失败
程序集加载失败
Form/Task 契约不一致
客户端行为异常
报表运行失败
新错误持续产生
~~~

**失败处理顺序**

~~~text
停止后续变更
        ↓
记录 deploymentId / jobId / 阶段
        ↓
采集 stdout/stderr、日志、哈希和状态
        ↓
判断是否可自动回滚
        ↓
恢复备份 / 反向变更
        ↓
必要时重启受影响服务
        ↓
再次执行最小健康检查
        ↓
deployment_finish(success/failure)
        ↓
生成失败 Case Candidate
~~~

**主要工具**

- samplemanager_restore_backup；
- samplemanager_deployment_finish；
- samplemanager_restart_instance；
- samplemanager_recent_errors；
- samplemanager_deployment_status。

自动回滚只适用于 manifest 中明确声明、备份存在且回滚步骤已验证的工件。结构破坏、数据库业务数据或未知运行状态不得盲目自动回滚。

### Step 16：采集部署证据并关闭任务

**目的**

形成完整、可审计、可复用的部署记录。

**主要工具**

- samplemanager_deployment_status；
- job_status / job_list；
- fetch_logs；
- workspace_file_stat；
- download_remote_file；
- samplemanager_recent_errors；
- writeAudit；
- Knowledge Capture Worker。

**必须保存**

~~~text
requestId
deploymentId
project / server / environment / instance
operator / approval
source commit
manifest hash
每个工件 source/target SHA-256
备份路径
结构变更结果
table-loader 结果
Build 输出
程序集检查结果
Form/Report/UI Smoke Test
服务重启记录
错误日志窗口
rollback status
manual checks
~~~

**关闭条件**

- 成功：Deployment 标记 succeeded；
- 失败但已回滚：标记 failed_rolled_back；
- 状态未知：标记 needs-review，不得声明部署完成；
- 缺少人工验收：标记 pending-validation。

## 6. 自动知识捕获流程

部署完成后，知识捕获不应依赖人工复制聊天内容，而应从 Deployment、Job、Audit 和 Evidence 自动生成候选知识。

~~~text
deployment.finished / deployment.failed
              ↓
Domain Event / Outbox
              ↓
Knowledge Capture Worker
              ↓
收集 manifest、命令、日志、哈希、测试和回滚状态
              ↓
脱敏、去重、内容寻址
              ↓
生成 Case Candidate
              ↓
关联 Form / Task / Assembly / Menu / Property / Cache
              ↓
Schema 校验和证据一致性校验
              ↓
写入 knowledge.db
              ↓
更新 FTS5 / 向量 / 关系索引
              ↓
审核队列
~~~

### 6.1 成功部署生成的知识

可自动提炼：

~~~text
部署对象和版本
部署顺序
成功的前置检查
需要清理的缓存
需要重启的服务
实际执行的 Smoke Test
工件依赖关系
可复用的 Playbook 步骤
~~~

### 6.2 失败部署生成的知识

可自动提炼：

~~~text
失败阶段
错误消息
相关工件
版本/环境
已尝试的修复
回滚方式
最终验证结果
不可适用的边界
~~~

### 6.3 知识可信度规则

~~~text
只有命令输出：observed
有文件/哈希证据：evidenced
有构建和目标运行时测试：verified
多个独立案例复用：pattern-candidate
人工审核通过：approved
~~~

模型可以生成摘要、标签和根因候选，但不能创建不存在的证据，也不能把推断写成已确认事实。

## 7. 失败分支和恢复图

### 7.1 通用失败处理

~~~text
任意步骤失败
      ↓
记录 deploymentId / jobId / 阶段
      ↓
停止后续写操作
      ↓
采集 stdout/stderr、日志、哈希和状态
      ↓
可回滚？
  ┌───┴────┐
  │        │
 是       否
  │        │
恢复备份   标记 needs-review
  │        │
重启受影响服务
      ↓
重新执行最小健康检查
      ↓
deployment_finish(success/failure)
      ↓
生成失败 Case Candidate
~~~

### 7.2 不应自动回滚的情形

- 结构删除、字段类型变化或主键/索引变化；
- 已写入业务数据且无法确定影响范围；
- 生产/GMP 变更缺少批准；
- 运行状态未知；
- 目标服务未能确认是否已加载新程序集；
- 备份缺失或哈希不一致；
- 回滚步骤本身没有经过验证。

## 8. 工具映射表

| 流程能力 | Relay MCP 工具 | 目的 |
|---|---|---|
| 路由和目标选择 | relay_route_check | 确认请求进入正确 Relay 和目标 |
| Project/Server 解析 | list_projects、project_server_links_list | 解析权限和环境 |
| LIMS 能力发现 | samplemanager_capabilities | 确认版本化能力包 |
| 任务开始 | samplemanager_deployment_start | 创建 deploymentId |
| 只读 Form 检查 | samplemanager_validate_form_task_contract | 校验 FORM/TASK/MENU/Form XML/FormsBin |
| 程序集检查 | samplemanager_inspect_assembly_type | 反射类型、方法、事件、依赖和版本 |
| 数据库结构检查 | samplemanager_table_schema | 查询列、键、identity、默认值 |
| 只读 SQL | samplemanager_sql_query | 查询当前数据和配置 |
| 结构生成 | samplemanager_create_entity_definition | 生成 Entity Definition |
| 结构转换 | samplemanager_convert_tables | 转换受影响表 |
| 配置加载 | samplemanager_table_loader | 通过 $table_loader 导入 CSV |
| 配置包部署 | samplemanager_deploy_table_loader_package | 分阶段上传、校验、加载和验证 |
| 构建工具发现 | samplemanager_discover_build_tools | 找到目标 MSBuild/Framework 工具 |
| .NET 构建 | samplemanager_build_dotnet | 构建 Task/服务程序集 |
| 程序集部署 | samplemanager_build_deploy_assembly | 构建、备份、部署、重启和回滚 |
| 文件部署 | samplemanager_deploy_file | 备份后复制单个工件 |
| 缓存清理 | samplemanager_clear_form_cache | 清理指定 Form 和翻译缓存 |
| 服务重启 | samplemanager_restart_instance | 重启实例必要服务 |
| 命令执行 | samplemanager_run_command | 运行 SampleManagerCommand.exe |
| 错误检索 | samplemanager_recent_errors | 查询时间窗口内错误证据 |
| 日志收集 | fetch_logs | 收集远程日志 |
| 部署状态 | samplemanager_deployment_status | 查询阶段、工件、哈希、备份和回滚 |
| 部署结束 | samplemanager_deployment_finish | 标记成功、失败或需人工处理 |
| 备份恢复 | samplemanager_restore_backup | 恢复明确目标文件 |
| 知识检索 | knowledge_search | 找案例、Pattern、Playbook |
| 知识详情 | knowledge_get、knowledge_evidence_get | 读取完整内容和证据 |
| 关系查询 | knowledge_relation_query | 查询 Form/Task/Assembly/Menu 影响关系 |
| 诊断编排 | samplemanager_diagnose | 知识检索加当前环境只读检查 |
| 影响分析 | samplemanager_impact_analysis | 计算对象依赖和变更范围 |
| 知识反馈 | knowledge_feedback | 记录案例是否有效、是否解决问题 |

## 9. 按工件类型的部署顺序

### 9.1 结构字段变化

~~~text
备份
  ↓
部署 structure source
  ↓
CreateEntityDefinition
  ↓
convert_table（逐表）
  ↓
重建 typed entity 依赖程序集
  ↓
部署 Assembly
  ↓
部署 Form/配置
  ↓
清理缓存/重启
  ↓
schema + UI + data smoke test
~~~

### 9.2 Form/Property Sheet 变化

~~~text
检查 Form XML、FORM row、Server Task、Control names
  ↓
检查/部署 Task Assembly
  ↓
部署 Form XML
  ↓
清理 FormsBin 和翻译缓存
  ↓
重开客户端
  ↓
验证 Page/Control/Property/Apply/OK/Save
~~~

### 9.3 Table-loader 配置变化

~~~text
检查 CSV schema 和目标表
  ↓
备份目标行
  ↓
上传 CSV
  ↓
$table_loader
  ↓
查询 before/after
  ↓
验证菜单、角色、Form/Report 注册
~~~

### 9.4 Report Designer REPX

~~~text
检查 DevExpress 版本、数据源、参数和字体
  ↓
本地 load test
  ↓
部署布局和注册行
  ↓
清理必要缓存/重启报告服务
  ↓
使用真实数据运行报告
~~~

### 9.5 自定义 .NET Task Assembly

~~~text
发现目标 DLL/MSBuild
  ↓
检查 SampleManager 版本
  ↓
构建
  ↓
反射检查类型和 Task 名称
  ↓
备份旧 DLL
  ↓
部署 DLL/PDB/config
  ↓
重启相关服务
  ↓
执行 Form/Menu/UI Smoke Test
~~~

## 10. 安全、权限和审计要求

### 10.1 权限

每个 Knowledge 和 Execution 工具都必须复用：

~~~text
MCP Token
  → Project scope
  → Server scope
  → Environment
  → LIMS Instance
  → Tool mutation policy
~~~

Knowledge 检索不能泄露调用者无权访问的客户、生产或 GMP 案例。

### 10.2 高风险操作

以下操作默认需要明确批准或更高权限：

- 生产数据库 mutation；
- structure 转换；
- 结构删除或类型修改；
- 服务重启；
- 生产/GMP Form 或 Task 部署；
- 权限、角色和审计配置变化；
- 自动回滚；
- 影响多个实例的批量部署。

### 10.3 审计关联

每条记录至少关联：

~~~text
traceId
requestId
projectId
serverId
limsInstanceId
jobId
deploymentId
knowledgeQueryId
retrievalRunId
artifactSha256
operator
approval
~~~

## 11. 画图时建议的关键节点

如果只画一张总流程图，建议保留以下 15 个节点：

~~~text
1. Request Intake
2. Target Context Resolution
3. Knowledge Retrieval
4. Source/Artifact Inspection
5. Read-only Preflight
6. Deployment Start
7. Backup
8. Structure / Entity Definition
9. Configuration / Table-loader
10. Build / Deploy Assembly
11. Deploy Form / Report / Resource
12. Clear Cache / Restart
13. Runtime Smoke Test
14. Success or Rollback
15. Evidence Capture / Knowledge Update
~~~

在图中单独画两条横向辅助链：

~~~text
Knowledge Side:
Casebook → RAG → Playbook → Diagnostic Guidance → Case Candidate

Execution Side:
Relay MCP → SSH/Agent → SampleManager Tools → Instance → Logs/Results
~~~

在“成功或回滚”节点后接：

~~~text
Deployment Evidence
  → Domain Event / Outbox
  → Knowledge Worker
  → Case / Pattern Candidate
  → Review Queue
  → FTS5 / Vector / Relation Index
~~~

## 12. 流程完成定义

一次 SampleManager 远程部署只有同时满足以下条件，才能对用户声明成功：

- 目标 Project、Server、Environment 和 LIMS Instance 已确认；
- 版本和解决方案边界已确认；
- 相关 Case/Pattern/Playbook 已检索或明确记录无匹配知识；
- manifest、依赖和 SHA-256 已记录；
- 目标文件和配置已备份；
- 结构、配置、Assembly、Form、Report 已按依赖顺序部署；
- FormsBin 和相关缓存已处理；
- 必要服务或客户端已重新加载；
- 目标 SampleManager UI、命令、报表和数据行为已验证；
- 新错误日志已检查；
- deploymentId 状态已关闭；
- Evidence 已保存；
- 成功或失败经验已提交 Knowledge Capture Worker。

> “文件已复制”只是部署过程中的一个中间状态；“命令退出码为 0”也不是业务成功的充分条件。最终完成必须以目标 SampleManager 运行时验证和完整证据链为准。


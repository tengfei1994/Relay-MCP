# Relay Reliability P0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add bounded job waiting, stable deployment correlation, deterministic SampleManager build context, and observable instance restart phases.

**Architecture:** Reuse the existing persisted job/deployment stores and `RemoteExecutionOptions` callbacks. Keep fast synchronous compatibility while adding explicit structured inputs and evidence; do not introduce a second queue or deployment store.

**Tech Stack:** TypeScript, MCP SDK, Node test runner, PowerShell, SampleManager instance metadata.

## Global Constraints

- Preserve existing MCP tool names and default behavior unless the approved requirement explicitly changes it.
- Remote mutations remain auditable and scoped to the selected project/environment/instance.
- Wait operations must return current state before the MCP tool timeout rather than throwing an ambiguous timeout.
- No new runtime dependency.

---

### Task 1: Public Job Wait

**Files:**
- Modify: `src/mcp/index.ts`
- Modify: `src/shared/tool-catalog.ts`
- Test: `tests/tool-catalog.test.ts`
- Test: `tests/job-store.test.ts`

**Interfaces:**
- Produces: `job_wait({ jobId, waitMs?, pollMs?, returnOnPhaseChange? })`
- Returns: the same execution snapshot as `job_status`, plus `wait` metadata.

- [ ] Write a failing catalog/behavior test for `job_wait`.
- [ ] Verify the focused test fails because the tool is absent.
- [ ] Extract one job snapshot helper and expose bounded polling.
- [ ] Verify focused tests pass.

### Task 2: Deployment ID Reuse

**Files:**
- Modify: `src/mcp/index.ts`
- Test: `tests/deployment-store.test.ts`

**Interfaces:**
- Consumes: optional `deploymentId` on `samplemanager_build_deploy_assembly`.
- Produces: validated reuse of the same deployment record and returned ID.

- [ ] Write a failing test for resolving an existing deployment versus creating one.
- [ ] Verify the test fails because assembly deployment always creates a record.
- [ ] Add a shared deployment resolver and update assembly deployment.
- [ ] Verify focused tests pass.

### Task 3: Build Preflight and Properties

**Files:**
- Modify: `src/shared/samplemanager-tools.ts`
- Modify: `src/mcp/index.ts`
- Test: `tests/samplemanager-tools.test.ts`

**Interfaces:**
- Adds: `instance`, `msbuildProperties`, `environmentVariables`, `preflightOnly` to build orchestration.
- Automatically sets: `<INSTANCE>_EXE` and `SAMPLEMANAGER_EXE` from `instancePaths(instance).exe`.
- Returns: project path, tool kind/path, instance root/exe, expected assembly path, and effective properties.

- [ ] Write failing tests for property injection and preflight output.
- [ ] Verify they fail with the current build script.
- [ ] Implement validated property/environment rendering for MSBuild and dotnet.
- [ ] Verify focused tests pass.

### Task 4: Observable Restart

**Files:**
- Modify: `src/shared/samplemanager-tools.ts`
- Test: `tests/samplemanager-tools.test.ts`

**Interfaces:**
- Produces job phases: `restart_preflight`, `stopping:<service>`, `terminating_instance_processes`, `starting:<service>`, `waiting:<service>`, `health_check`, `completed`.
- Returns per-service before/after status, elapsed time, failed services, and health state.

- [ ] Write a failing test for phase markers and bounded service waits.
- [ ] Verify the test fails with the current restart script.
- [ ] Implement progress markers and service-specific timeout handling.
- [ ] Verify focused tests pass.

### Task 5: Integration Verification

**Files:**
- Modify: `README.md`

- [ ] Update tool documentation and examples.
- [ ] Run `npm test` and confirm zero failures.
- [ ] Run `npm run build` and confirm exit code zero.
- [ ] Run `git diff --check` and review the final diff.

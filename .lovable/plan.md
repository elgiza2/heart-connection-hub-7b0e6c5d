# MEGSY — Autonomous Execution Agent (real, not simulated)

## What I found (inspection summary)

The project already contains most of a Manus-style engine, but it is **not connected to the chat**:

- `supabase/functions/_shared/agentkernel/` — a real durable kernel: planner + risk floor, ReAct executor (`run_code`, `web_search`, files, `mcp_call`, browser via browser-use), loop guard with 4-tier escalation, human-question parking, `agent_memory`, `agent_checkpoints`, per-step persistence.
- `long_runs` + `long_run_events` + `agent_plans` + `agent_questions` + `agent_checkpoints` + `agent_memory` tables = a working durable state machine.
- `agent-tick` edge function = a cron supervisor that advances runs with no browser open.
- **The gap:** every normal chat turn goes to a separate, opaque backend function (`chat-alibaba`, not in this repo) that has no plan/verify/recover/checkpoint/memory. `ThinkingTrace` gets only ephemeral stream events, hence the generic "Thinking…" behaviour.

So the work is **unification + real event streaming**, not building a new engine, and **zero UI redesign** is required.

## Scope of change

### Phase 1 — Real activity-event backbone
- Add a structured event taxonomy (`TASK_STARTED`, `PLANNING_STARTED`, `PLAN_UPDATED`, `TOOL_STARTED/PROGRESS/COMPLETED/FAILED`, `OBSERVATION_STARTED`, `RECOVERY_STARTED`, `REPLANNING_STARTED`, `VERIFICATION_*`, `WAITING_FOR_USER`, `TASK_RESUMED/CHECKPOINTED/COMPLETED/FAILED/CANCELLED`) emitted from the kernel at the exact moment each real operation happens.
- Migration: extend `long_run_events` with `event_type`, `task_id`, `step_id`, `tool`, `action`, `status`, `summary`, `progress`, `metadata` (nullable, additive — existing rows keep working). GRANTs + RLS scoped to the run owner.
- `summary` is generated from the real tool + real arguments (e.g. the actual URL, file path, test command), never from a fixed message list, never on a timer.

### Phase 2 — Chat is wired to the durable agent
- An objective router in the existing send path: goal-shaped requests ("fix this app", "connect this API", "open this site and finish setup", MCP tasks) start a `long_runs` task through the existing `long-run` function; short conversational turns keep the current fast chat path untouched.
- The existing `ThinkingTrace` + `ToolPart` badges are fed from a realtime subscription to `long_run_events` instead of the generic status. Same components, same styling, same animations — only the data source changes.
- Tool icons map to the real executing tool (browser / terminal-code / files / MCP / search / image) using the existing icon set.
- Reload / app close / return: the chat re-attaches to the live task and replays its persisted events, so nothing is lost.

### Phase 3 — Execution depth & self-recovery
- Failure classification (`TRANSIENT`, `RECOVERABLE`, `TOOL_FAILURE`, `LOGICAL`, `AUTHORIZATION`, `HUMAN_REQUIRED`, `UNSAFE`, `TERMINAL`) with bounded retry+backoff for transient, diagnose + strategy switch for recoverable, and a real blocker report only for terminal.
- Strategy diversification driven by the existing loop guard: after a repeated identical action, force a different selector / keyboard path / different tool / API-or-MCP instead of browser / checkpoint rollback / replan.
- Mandatory verification gate before `finish` on the agentic path (currently only the browser path critiques): run the checks that fit the objective (build/typecheck/tests, page state, API response, file existence) and re-plan on failure. No "done" without a passed verification event.

### Phase 4 — Tools, memory, supervisor
- The kernel can call registry tools (`agent_tools_registry` → `anything-api`) in addition to its hardcoded set, so MCP, integrations and app tools live in one execution layer.
- Memory: relevant-only retrieval before planning, durable-learning extraction after completion, with a hard secret filter (no passwords/tokens/credentials ever stored).
- Supervisor hardening in `agent-tick`: heartbeat/stall detection, restart-from-latest-checkpoint, retry accounting, and surfacing paused/blocked tasks. Also covers `computer_tasks` so no agent surface can silently disappear.

### Phase 5 — Verification of this work
End-to-end run on mobile viewport with the test account: give a real multi-step objective, confirm the status text changes with each real operation, tool icons match the real tool, thinking panel opens and shows real reasoning, task survives a page reload, a forced tool failure triggers recovery rather than termination, and completion only follows a passed verification.

## Technical notes
- Backend-first: the agent runtime is the source of truth; the frontend renders events and never invents state.
- All external page/file/tool output is treated as untrusted data; system instructions cannot be overridden by page content.
- Auth, RLS, workspace isolation, tool permissions, rate/resource limits and credit accounting stay as they are; no billing state is modified.
- The test account is used only for read-safe UI verification; the password never enters logs, memory, UI or reports.

## Not doing
No UI/UX redesign, no new dashboard or task panel, no new design system, no fake progress, no rotating placeholder statuses.

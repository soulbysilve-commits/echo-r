# Veritas Forge — Public Facts Registry

This is the single source of truth for every public marketing claim about
Veritas Forge products. No content may claim a capability is "available now"
/ "shipped" / "released" unless it cites a `FACT-*` id here with
`STATUS: VERIFIED` and `PUBLIC_SAFE: true`. The marketing operator's policy
gate (`tools/marketing/lib/policy.mjs`) enforces this mechanically.

Facts were compiled 2026-09-13 via read-only audits of the four canonical
repositories (ECHODiscord版 / ECHO Agent, ECHOapp, Noemora_mod_core,
echo-r). Audits were deliberately conservative: a capability is only
`VERIFIED` when there is implementation code **and** passing test/runtime
evidence, not just a function or a doc that describes it. Re-verify any fact
older than ~30 days before reusing it, since these are fast-moving repos.

STATUS values: `VERIFIED | PARTIAL | EXPERIMENTAL | PLANNED | FAILED | DEPRECATED`.

---

## FACT-001
PRODUCT: ECHO Agent
STATUS: VERIFIED
CLAIM: ECHO Agent's verifier can detect and reject a claimed task success when there is no supporting evidence, rather than trusting a self-reported result.
SOURCE_REPOSITORY: ECHODiscord版
SOURCE_PATH: echo_agent_verifier_v1.py
SOURCE_EVIDENCE: test_echo_agent_verifier_v2.py::test_fake_success_with_no_evidence_and_no_reviewer_fails_closed and ~184 related verifier tests pass.
VERIFIED_AT: 2026-09-13
PUBLIC_SAFE: true
NOTES: Verifier module is currently untracked in git (uncommitted) as of the audit date — re-confirm it has landed on a real branch before citing this as a shipped guarantee.

## FACT-002
PRODUCT: ECHO Agent
STATUS: PARTIAL
CLAIM: ECHO Agent can checkpoint an in-progress task and, after a fresh process restart, detect the incomplete step and resume/reconcile it rather than blindly re-running or losing it.
SOURCE_REPOSITORY: ECHODiscord版
SOURCE_PATH: state_wal.py, echo_agent_runtime_v1.py
SOURCE_EVIDENCE: test_echo_agent_core_v1.py::test_restart_detects_durable_attempt_window and test_echo_agent_runtime_v1.py::test_read_only_task_executes_and_survives_restart pass, using a freshly-instantiated runtime object to simulate restart.
VERIFIED_AT: 2026-09-13
PUBLIC_SAFE: true
NOTES: Proven via simulated-crash unit tests (new object, same on-disk root), not a real killed-process integration test. Say "checkpoint and resume" — do not claim it has been demonstrated across an actual OS-level process kill in production.

## FACT-003
PRODUCT: ECHO Agent
STATUS: VERIFIED
CLAIM: ECHO Agent enforces permission boundaries on actions (e.g. destructive operations require approval, exec is disabled without an allowlist) and fails closed by default.
SOURCE_REPOSITORY: ECHODiscord版
SOURCE_PATH: echo_agent_runtime_v1.py (AgentPermissionGate), echo_agent_continuity_permission_v1.py
SOURCE_EVIDENCE: test_echo_agent_core_v1.py::test_destructive_delete_requires_approval, ::test_exec_is_disabled_without_allowlist pass.
VERIFIED_AT: 2026-09-13
PUBLIC_SAFE: true
NOTES: Continuity-permission overlay module is untracked in git as of audit date.

## FACT-004
PRODUCT: ECHO Agent
STATUS: VERIFIED
CLAIM: ECHO Agent can run independent steps of a task in parallel via a worker pool and delegate work to child subagents.
SOURCE_REPOSITORY: ECHODiscord版
SOURCE_PATH: echo_agent_worker_pool_v1.py
SOURCE_EVIDENCE: test_echo_agent_worker_pool_v1.py, test_echo_agent_delegation_lineage_v1.py pass.
VERIFIED_AT: 2026-09-13
PUBLIC_SAFE: true
NOTES: Concurrency is thread-based (ThreadPoolExecutor) within one process, not distributed multi-process/multi-machine agents. Module untracked in git as of audit date.

## FACT-005
PRODUCT: ECHO Agent
STATUS: VERIFIED
CLAIM: ECHO Agent plans multi-step tasks as a dependency graph (DAG) with cycle detection and a structured failure taxonomy, not just a flat step list.
SOURCE_REPOSITORY: ECHODiscord版
SOURCE_PATH: echo_agent_task_graph_v1.py
SOURCE_EVIDENCE: test_echo_agent_task_graph_v1.py passes.
VERIFIED_AT: 2026-09-13
PUBLIC_SAFE: true
NOTES: Coexists with an older flat planner; not every code path uses the DAG planner yet.

## FACT-006
PRODUCT: ECHO Agent
STATUS: PARTIAL
CLAIM: ECHO Agent has a standalone content/action policy engine ("Soul Protocol") that ranks source trust and can allow, bound, require approval for, quarantine, or deny an action/memory admission.
SOURCE_REPOSITORY: ECHODiscord版
SOURCE_PATH: soul_protocol_v1.py
SOURCE_EVIDENCE: test_soul_protocol_v1.py, test_soul_protocol_product_policy_runtime_v1.py pass.
VERIFIED_AT: 2026-09-13
PUBLIC_SAFE: true
NOTES: Verified as a standalone, tested policy engine. Not confirmed that every subsystem actually consults it end-to-end — do not claim it is universally wired in yet.

## FACT-007
PRODUCT: ECHO Agent
STATUS: PARTIAL
CLAIM: ECHO Agent can derive candidate reusable "skills" from its own task experience, holding them at low confidence until they recur, and only promotes a skill to active use after passing staged schema/functional/safety/regression checks — never auto-promoted on first occurrence.
SOURCE_REPOSITORY: ECHODiscord版
SOURCE_PATH: echo_agent_skill_engine_v1.py, echo_agent_learning_reviewer_v1.py, echo_agent_skill_promotion_v1.py
SOURCE_EVIDENCE: 48 related unit tests pass; module's own docstring self-labels as "Tier 2 -- lighter test coverage."
VERIFIED_AT: 2026-09-13
PUBLIC_SAFE: true
NOTES: Tested only against synthetic trace objects, not observed running against live production task traces. Phrase publicly as "in development" / "early" procedural learning, not a finished feature.

## FACT-008
PRODUCT: ECHO Agent
STATUS: PARTIAL
CLAIM: ECHO Agent's persisted identity records (commitments, autobiography, continuity state) contain no reference to which model/planner produced them, and survive being loaded by a runtime instantiated with a different planner function.
SOURCE_REPOSITORY: ECHODiscord版
SOURCE_PATH: echo_agent_model_migration_proof_v1.py
SOURCE_EVIDENCE: test_echo_agent_persistent_identity_e2e_v1.py passes, swapping a `model_planner` callable (e.g. a lambda returning "A" vs "B").
VERIFIED_AT: 2026-09-13
PUBLIC_SAFE: true
NOTES: IMPORTANT MARKETING CONSTRAINT — this proves state survives swapping a planner *function*, explicitly with "no real multi-provider API calls." Do NOT phrase this as "ECHO's identity survives switching to a different AI model/provider" without that qualifier; that claim is not yet demonstrated.

## FACT-009
PRODUCT: ECHO Agent
STATUS: VERIFIED
CLAIM: ECHO Agent gates sensitive actions based on an identity-continuity signal that can be WARN (require approval on actions the base gate would otherwise auto-allow) or FAIL (deny all but read-only), and this signal is always recomputed from on-disk evidence rather than trusted when self-reported.
SOURCE_REPOSITORY: ECHODiscord版
SOURCE_PATH: echo_agent_continuity_permission_v1.py, identity_continuity_evolution_v1.py
SOURCE_EVIDENCE: test_echo_agent_continuity_permission_v1.py passes, including a spoofed-continuity-claim test.
VERIFIED_AT: 2026-09-13
PUBLIC_SAFE: true
NOTES: Strong, differentiated claim — code and tests are explicit about the security invariant that an LLM cannot assert its own continuity state.

## FACT-010
PRODUCT: ECHO Agent
STATUS: VERIFIED
CLAIM: ECHO Agent has durable, hash-verified write-ahead-log storage for state, a classified write ledger, and hybrid lexical+embedding memory search.
SOURCE_REPOSITORY: ECHODiscord版
SOURCE_PATH: state_wal.py, write_ledger.py, memory_manager.py
SOURCE_EVIDENCE: this is the oldest and only fully git-committed layer of the stack; broad existing test coverage.
VERIFIED_AT: 2026-09-13
PUBLIC_SAFE: true
NOTES: The most mature, safely-citable layer of ECHO Agent's persistence story.

## FACT-011
PRODUCT: ECHO App
STATUS: VERIFIED
CLAIM: ECHO App's backend can save and retrieve long-term memories using a hybrid of lexical matching and embedding similarity.
SOURCE_REPOSITORY: ECHOapp
SOURCE_PATH: backend/app/core/runtime_v1/memory_manager.py
SOURCE_EVIDENCE: test_memory_runtime_context_contract.py and related tests pass.
VERIFIED_AT: 2026-09-13
PUBLIC_SAFE: true
NOTES: Backend logic only — device-side (iOS/Swift) memory consolidation is PARTIAL; could not execute Swift tests in this environment.

## FACT-012
PRODUCT: ECHO App
STATUS: VERIFIED
CLAIM: ECHO App tracks a numeric relationship state (trust, affection, guardedness, respect, stability) between user and AI that persists and updates over time with clamped, inertia-based changes.
SOURCE_REPOSITORY: ECHOapp
SOURCE_PATH: backend/app/core/runtime_v1/relational_state.py
SOURCE_EVIDENCE: WAL-audited load/save/apply_impacts logic with passing tests.
VERIFIED_AT: 2026-09-13
PUBLIC_SAFE: true
NOTES: Backend-side; no dedicated typed relationship model confirmed on the iOS client (handled as a generic dict field there).

## FACT-013
PRODUCT: ECHO App
STATUS: PARTIAL
CLAIM: ECHO App conversations can pick up context from prior sessions.
SOURCE_REPOSITORY: ECHOapp
SOURCE_PATH: backend/app/api/models.py (ContinuityContext), InMemoryConversationStore.swift
SOURCE_EVIDENCE: test_conversation_store.py, test_conversation_transfer.py pass; but test_ios_restart_multi_year_continuity_e2e_v0_1.py::test_context_is_rebuilt_from_canonical_selected_evidence FAILED as of 2026-09-13.
VERIFIED_AT: 2026-09-13
PUBLIC_SAFE: true
NOTES: Do not claim long-horizon ("multi-year") continuity is fully working — the specific test for that scenario is currently failing.

## FACT-014
PRODUCT: ECHO App
STATUS: PARTIAL
CLAIM: ECHO App assembles model context (memories, beliefs, conversation turns) through a dedicated, bounded, deterministically-ranked context assembler rather than dumping raw history into the prompt.
SOURCE_REPOSITORY: ECHOapp
SOURCE_PATH: backend/app/services/context_assembler.py
SOURCE_EVIDENCE: test_context_assembler.py passes, but 7 related iOS contract tests (bounded-relevant-context-selection, continuous-conversation-context-assembly) were FAILING as of 2026-09-13 due to Swift source having drifted from what the contract tests expect.
VERIFIED_AT: 2026-09-13
PUBLIC_SAFE: true
NOTES: The backend concept is real and tested; the client-side implementation is currently regressed relative to its own contract tests. Do not market this as end-to-end working until the regression is fixed and re-verified.

## FACT-015
PRODUCT: ECHO App
STATUS: PARTIAL
CLAIM: ECHO App's backend can talk to different LLM providers behind a common interface (mock or any OpenAI-compatible endpoint) without changing its context-assembly logic.
SOURCE_REPOSITORY: ECHOapp
SOURCE_PATH: backend/app/providers/interfaces.py, factory.py
SOURCE_EVIDENCE: test_chat_provider_factory.py, test_openai_compatible_provider.py pass.
VERIFIED_AT: 2026-09-13
PUBLIC_SAFE: true
NOTES: Architecturally plausible that identity/memory/relationship persist across a live provider swap, but no test directly demonstrates swapping providers mid-conversation and confirming continuity. Do not claim this as demonstrated model-swap continuity.

## FACT-016
PRODUCT: ECHO-R
STATUS: PLANNED
CLAIM: "ECHO-R governance" (formal authenticity/authority proofs, delegation lineage, revocation, etc.) is a specification and gap-analysis effort, not working code.
SOURCE_REPOSITORY: ECHOapp
SOURCE_PATH: docs/echo-r/ECHO-R_V1_CONFORMANCE_MATRIX.md, ECHO-R_V1_IMPLEMENTATION_DELTA.md
SOURCE_EVIDENCE: Conformance matrix marks the large majority of ~50 requirements MISSING, none complete; implementation-delta doc explicitly states it "does not authorize a parallel ECHO-R subsystem."
VERIFIED_AT: 2026-09-13
PUBLIC_SAFE: true
NOTES: MARKETING CONSTRAINT — do not describe ECHO-R governance as implemented anywhere in the current product family. It is a roadmap/spec artifact today.

## FACT-017
PRODUCT: ECHO App
STATUS: PARTIAL
CLAIM: ECHO App's backend test suite passes the large majority of its tests (907/937 as of 2026-09-13); the 30 failures cluster in iOS/Swift "contract" checks that have drifted from current Swift source, and this Python suite is not currently gated by CI.
SOURCE_REPOSITORY: ECHOapp
SOURCE_PATH: backend/tests
SOURCE_EVIDENCE: pytest run, 2026-09-13; .github workflow inspection found no CI job running backend/tests.
VERIFIED_AT: 2026-09-13
PUBLIC_SAFE: true
NOTES: Useful for an honest "build in public" test-coverage post; not itself a customer-facing feature claim.

## FACT-018
PRODUCT: Noemora
STATUS: PARTIAL
CLAIM: Noemora's "First Seven" are seven named, persistent resident entities with durably checkpointed state across 109 simulation ticks.
SOURCE_REPOSITORY: Noemora_mod_core
SOURCE_PATH: core/sbe_life_loop_v1/, docs/NOEMORA_COMPLETION_STATUS.md
SOURCE_EVIDENCE: project's own internal audit: "First Seven | PASS | 7/7, real, durable across 109 ticks."
VERIFIED_AT: 2026-09-13
PUBLIC_SAFE: true
NOTES: MARKETING CONSTRAINT — each resident's decision-making is a hand-coded deterministic baseline policy, not live model reasoning. Do not describe them as "AI characters deciding for themselves."

## FACT-019
PRODUCT: Noemora
STATUS: PARTIAL
CLAIM: Noemora runs an unattended simulation tick loop with checkpoint/journal/receipt durability and crash-recovery, without a human driving each individual action.
SOURCE_REPOSITORY: Noemora_mod_core
SOURCE_PATH: core/sbe_life_loop_v1/
SOURCE_EVIDENCE: project's own audit describes a bounded 10-cycle production run, 7/7 residents committed every cycle, 0 open transactions, 0 model calls, 0 Luanti engine writes; live LLM calls are disabled by default (SBE_KILL_SWITCH=true).
VERIFIED_AT: 2026-09-13
PUBLIC_SAFE: true
NOTES: Frame as "durable autonomous execution infrastructure," not as "autonomous AI decision-making" — no live model is in the loop in current production runs.

## FACT-020
PRODUCT: Noemora
STATUS: FAILED
CLAIM: Autonomous residents acting inside the Luanti voxel world end-to-end (not just in isolated capability tests).
SOURCE_REPOSITORY: Noemora_mod_core
SOURCE_PATH: docs/NOEMORA_COMPLETION_STATUS.md
SOURCE_EVIDENCE: project's own definition-of-done table marks "Luanti world integration: FAIL" — capability layer is correct in isolation, but autonomous policy targets a different coordinate domain than Luanti's capability zones, so real autonomous runs produce zero organic engine mutations.
VERIFIED_AT: 2026-09-13
PUBLIC_SAFE: true
NOTES: Candidate for a "failure as marketing" post (mandate section 20) once framed constructively — the underlying capability layer and durability work are real; this is a coordination bug, not a fabricated capability. Contains no secrets/exploits.

## FACT-021
PRODUCT: Noemora
STATUS: VERIFIED
CLAIM: Noemora has a working local Godot viewer that renders residents as colored dots with mood-indicating rings from local JSON state.
SOURCE_REPOSITORY: Noemora_mod_core
SOURCE_PATH: godot_underworld_viewer/scripts/world_controller.gd, npc_dot.gd
SOURCE_EVIDENCE: real GDScript with a working project.godot; script's own header explicitly documents scope.
VERIFIED_AT: 2026-09-13
PUBLIC_SAFE: true
NOTES: MARKETING CONSTRAINT — this is a display-only 2D local visualizer ("no AI pathfinding, no model call, no network, no runtime persistence" per the code's own comment), not an immersive 3D window into a live world. Do not oversell as more than it is.

## FACT-022
PRODUCT: Noemora
STATUS: PLANNED
CLAIM: A recorded, reproducible, end-to-end demo of Noemora does not yet exist, despite demo-release packaging scaffolding.
SOURCE_REPOSITORY: Noemora_mod_core
SOURCE_PATH: public_demo/noemora_replay_timeline_v21000/
SOURCE_EVIDENCE: extensive README/QUICKSTART/DEMO_SUMMARY/SAFE_WORDING_GUIDE scaffolding, but zero captured screenshots/recordings found repo-wide; multiple "PUBLIC_POST_PACK" files explicitly marked "Status: PREPARED / Mode: draft only / not posted."
VERIFIED_AT: 2026-09-13
PUBLIC_SAFE: true
NOTES: Produce and verify an actual demo recording before any public Noemora demo claim.

## FACT-023
PRODUCT: ECHO Agent (commerce)
STATUS: PARTIAL
CLAIM: The official website has an in-progress checkout, license/entitlement, and encrypted-artifact download fulfillment flow for ECHO Agent (Stripe checkout, order-status polling, download tokens, webhook handling).
SOURCE_REPOSITORY: echo-r
SOURCE_PATH: app/api/echo-agent-checkout/, app/api/echo-agent-download/, app/api/stripe-webhook/, lib/stripe.ts, lib/entitlement.ts, lib/downloadToken.ts, docs/STRIPE_SETUP.md, docs/PAYMENT_OPERATIONS.md
SOURCE_EVIDENCE: files exist with dedicated test scripts (scripts/test-echo-agent-crypto.mjs, test-echo-agent-download-auth.mjs, test-echo-agent-fulfillment.mjs); as of 2026-09-13 these files are uncommitted/untracked in the main worktree, i.e. actively in development.
VERIFIED_AT: 2026-09-13
PUBLIC_SAFE: true
NOTES: MARKETING + SAFETY CONSTRAINT — do not publish "buy ECHO Agent now" / availability marketing until a human has (a) verified this flow end-to-end, (b) committed it, and (c) deliberately confirmed STRIPE_SALES_LIVE_ENABLED. This is a HUMAN_APPROVAL_REQUIRED boundary (production sales activation), not something the marketing operator may flip on its own.

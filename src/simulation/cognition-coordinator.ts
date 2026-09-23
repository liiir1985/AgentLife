import type { RuntimeConfig } from "../config/config-builder.js";
import type { CognitionModelPort } from "../agent/cognition-agent.js";
import {
  actionUtteranceField,
  cognitionPrompt,
  cognitionSettings,
  itemDescription,
  itemLabel,
  observableEvents,
} from "./config-view.js";
import type { CognitionService } from "./cognition-service.js";
import type {
  ActionPlan,
  ActionStep,
  CognitionDemand,
  CognitionInput,
  CognitionParticipant,
  CognitionRound,
  CognitionState,
  CognitiveDecision,
  IdleCommitment,
  Observation,
  WorkingMemoryEntry,
} from "./types.js";

/**
 * The global cognition barrier.
 *
 * One round collects every entity that owes a decision at this tick, hands each of
 * them only what Working Memory admitted, validates what comes back against that
 * material, and releases exactly one batch of plans in a stable order. A model
 * answer never reaches simulated state directly: an unknown observation
 * reference, an action the body may not run, an over-long plan or an unbounded
 * wait is refused and asked for again, and only what the entity itself confirmed
 * using is acknowledged as consumed.
 */

export interface ParticipantSeed {
  readonly characterId: string;
  readonly control: "cognition" | "user";
}

export interface RoundInput {
  readonly roundId: string;
  readonly tick: number;
  readonly stateVersion: string;
  readonly demands: readonly CognitionDemand[];
  readonly participants: readonly ParticipantSeed[];
  /** Observations admitted into Working Memory in this tick, per participant. */
  readonly admitted: Readonly<Record<string, readonly Observation[]>>;
  /** Everything Working Memory currently offers one participant. */
  readonly entries: Readonly<Record<string, readonly WorkingMemoryEntry[]>>;
  /** Short factual frame per participant: where it is and what it is doing. */
  readonly situations: Readonly<Record<string, string>>;
  /** The cognition state this round was opened against. */
  readonly cognition: CognitionState;
}

export interface RoundResolution {
  readonly round: CognitionRound;
  /** AI decisions in entity identity order. */
  readonly decisions: readonly CognitiveDecision[];
  /** Every plan of the round, ordered by entity and then by plan identity. */
  readonly plans: readonly ActionPlan[];
  /** Observation references each participant confirmed using, by entity. */
  readonly consumptions: Readonly<Record<string, readonly string[]>>;
}

export type DecisionResult =
  { readonly ok: true; readonly message: string } | { readonly ok: false; readonly message: string };

interface OpenRound {
  readonly input: RoundInput;
  participants: CognitionParticipant[];
  readonly decisions: Map<string, CognitiveDecision>;
  readonly plans: ActionPlan[];
  readonly consumptions: Map<string, readonly string[]>;
  readonly notes: string[];
  failure: string | null;
  running: boolean;
}

function participantOf(seed: ParticipantSeed, detail: string): CognitionParticipant {
  return Object.freeze({
    characterId: seed.characterId,
    control: seed.control,
    state: "waiting" as const,
    requestId: null,
    attempts: 0,
    detail,
  });
}

export class CognitionCoordinator {
  private open: OpenRound | undefined;

  constructor(
    private readonly config: RuntimeConfig,
    private readonly cognition: CognitionService,
    private readonly models: CognitionModelPort,
  ) {}

  current(): CognitionRound | undefined {
    return this.open === undefined ? undefined : this.roundOf(this.open);
  }

  isOpen(): boolean {
    return this.open !== undefined;
  }

  openRound(input: RoundInput): CognitionRound {
    if (this.open !== undefined) throw new Error(`cognition round ${this.open.input.roundId} is still open`);
    this.open = {
      input,
      participants: input.participants.map((seed) => participantOf(seed, "waiting for its decision")),
      decisions: new Map(),
      plans: [],
      consumptions: new Map(),
      notes: [],
      failure: null,
      running: false,
    };
    return this.roundOf(this.open);
  }

  private roundOf(open: OpenRound): CognitionRound {
    const settled = open.participants.every(
      (participant) => participant.state !== "waiting" && participant.state !== "requested",
    );
    return Object.freeze({
      roundId: open.input.roundId,
      tick: open.input.tick,
      stateVersion: open.input.stateVersion,
      participants: Object.freeze(
        [...open.participants].sort((left, right) => left.characterId.localeCompare(right.characterId)),
      ),
      demands: Object.freeze([...open.input.demands]),
      decisions: Object.freeze(
        Object.fromEntries([...open.decisions.entries()].sort(([left], [right]) => left.localeCompare(right))),
      ),
      plans: Object.freeze(
        [...open.plans].sort(
          (left, right) => left.entityId.localeCompare(right.entityId) || left.planId.localeCompare(right.planId),
        ),
      ),
      status: open.failure !== null ? "failed" : settled ? "resolved" : "open",
      failure: open.failure,
    });
  }

  private update(characterId: string, change: Partial<CognitionParticipant>): void {
    if (this.open === undefined) return;
    this.open.participants = this.open.participants.map((participant) =>
      participant.characterId === characterId ? Object.freeze({ ...participant, ...change }) : participant,
    );
  }

  /** Runs every AI participant that still owes a decision; the player waits for its own input. */
  async resolveAiParticipants(): Promise<CognitionRound> {
    const open = this.open;
    if (open === undefined) throw new Error("no cognition round is open");
    const roundId = open.input.roundId;
    if (open.running) return this.roundOf(open);
    open.running = true;
    try {
      for (const participant of [...open.participants].sort((left, right) =>
        left.characterId.localeCompare(right.characterId),
      )) {
        if (participant.control !== "cognition" || participant.state !== "waiting") continue;
        await this.resolveOne(roundId, participant.characterId);
        // A load or a new round may have replaced this one while the model answered.
        if (this.open === undefined || this.open.input.roundId !== roundId) return this.roundOf(open);
      }
    } finally {
      if (this.open !== undefined) this.open.running = false;
    }
    return this.roundOf(this.open ?? open);
  }

  private async resolveOne(roundId: string, characterId: string): Promise<void> {
    const settings = cognitionSettings(this.config);
    const open = this.open;
    if (settings === undefined || open === undefined) return;
    let rejection: string | null = null;
    for (let attempt = 1; attempt <= settings.maxAttempts; attempt += 1) {
      if (this.open === undefined || this.open.input.roundId !== roundId) return;
      const requestId = `${roundId}/${characterId}/attempt-${attempt}`;
      this.update(characterId, { state: "requested", requestId, attempts: attempt, detail: `attempt ${attempt}` });
      const result = await this.models.request(this.inputFor(open, characterId, requestId, attempt, rejection));
      if (this.open === undefined || this.open.input.roundId !== roundId) return;
      if (result.status === "decided" && result.decision !== null) {
        const checked = this.validate(open, characterId, result.decision);
        if (checked.ok) {
          open.decisions.set(characterId, checked.decision);
          open.plans.push(...this.plansOf(open, checked.decision));
          open.consumptions.set(characterId, checked.decision.consumedObservations);
          open.notes.push(`${characterId} decided at attempt ${attempt}: ${this.summaryOf(checked.decision)}`);
          this.update(characterId, { state: "decided", detail: this.summaryOf(checked.decision) });
          return;
        }
        rejection = checked.reason;
        open.notes.push(`${characterId} attempt ${attempt} refused: ${rejection}`);
        this.update(characterId, { state: "waiting", detail: rejection });
        continue;
      }
      rejection = result.detail;
      open.notes.push(`${characterId} attempt ${attempt} ${result.status}: ${result.detail}`);
      this.update(characterId, { state: "waiting", detail: rejection });
    }
    open.failure = `${characterId} submitted no usable decision: ${rejection ?? "no attempt was made"}`;
    this.update(characterId, { state: "failed", detail: open.failure });
  }

  private summaryOf(decision: CognitiveDecision): string {
    const parts: string[] = [];
    if (decision.speech !== null) parts.push("speaks");
    if (decision.steps.length > 0) parts.push(`${decision.steps.length} step(s)`);
    if (decision.idle !== null) parts.push(`waits (${decision.idle.kind} until ${decision.idle.untilTick})`);
    return parts.length === 0 ? "decided nothing" : parts.join(", ");
  }

  /** Builds one request from the admitted material and the entity's own state. */
  private inputFor(
    open: OpenRound,
    characterId: string,
    requestId: string,
    attempt: number,
    rejection: string | null,
  ): CognitionInput {
    const settings = cognitionSettings(this.config);
    const record = this.cognition.record(open.input.cognition, characterId);
    return Object.freeze({
      characterId,
      requestId,
      roundId: open.input.roundId,
      tick: open.input.tick,
      stateVersion: open.input.stateVersion,
      systemPrompt: cognitionPrompt(this.config) ?? "",
      situation: open.input.situations[characterId] ?? "",
      attention: Object.freeze([...(record?.attention ?? [])]),
      idle: record?.idle ?? null,
      observations: Object.freeze(
        (open.input.entries[characterId] ?? [])
          .filter((entry) => entry.kind === "observation")
          .map((entry) => ({
            observationId: entry.sourceId,
            reference: entry.reference,
            text: entry.text,
            role: entry.role,
          })),
      ),
      intentions: Object.freeze(
        (record?.intentions ?? [])
          .filter((intention) => intention.status === "active" || intention.status === "paused")
          .map((intention) => ({
            intentionId: intention.intentionId,
            content: intention.content,
            status: intention.status,
          })),
      ),
      actions: Object.freeze(
        (settings?.allowedActions ?? []).map((action) => ({
          action,
          name: itemLabel(this.config, action),
          description: itemDescription(this.config, action),
        })),
      ),
      maxSteps: settings?.maxPlanSteps ?? 1,
      idleWaitLimitTicks: settings?.idleWaitLimitTicks ?? 1,
      attempt,
      rejection,
      timeoutMs: (settings?.requestTimeoutSeconds ?? 60) * 1_000,
    });
  }

  /** The utterance action among the allowed actions, with the field its text is read from. */
  private speechAction(): { readonly action: string; readonly field: string } | undefined {
    for (const action of cognitionSettings(this.config)?.allowedActions ?? []) {
      const field = actionUtteranceField(this.config, action);
      if (field !== null) return { action, field };
    }
    return undefined;
  }

  /** Turns one validated decision into the body plans of this round. */
  private plansOf(open: OpenRound, decision: CognitiveDecision): readonly ActionPlan[] {
    const entries = open.input.entries[decision.characterId] ?? [];
    const anchorOf = (reference: string): string | undefined =>
      entries.find((candidate) => candidate.reference === reference)?.anchor ?? undefined;
    const steps: ActionStep[] = [];
    const speech = this.speechAction();
    if (decision.speech !== null && speech !== undefined)
      steps.push(Object.freeze({ action: speech.action, inputs: Object.freeze({ [speech.field]: decision.speech }) }));
    for (const step of decision.steps) {
      const target = step.target === undefined ? undefined : anchorOf(step.target);
      const destination = step.destination === undefined ? undefined : anchorOf(step.destination);
      steps.push(
        Object.freeze({
          action: step.action,
          ...(target === undefined ? {} : { target }),
          ...(destination === undefined ? {} : { destination }),
          ...(step.inputs === undefined ? {} : { inputs: step.inputs }),
        }),
      );
    }
    if (steps.length === 0) return [];
    return [
      Object.freeze({
        planId: `${decision.characterId}/tick-${open.input.tick}/cognition`,
        entityId: decision.characterId,
        source: "cognition" as const,
        formedVersion: open.input.stateVersion,
        conflict: "queue" as const,
        steps: Object.freeze(steps),
      }),
    ];
  }

  /** Refuses anything the entity could not have justified from what it was given. */
  private validate(
    open: OpenRound,
    characterId: string,
    draft: CognitiveDecision,
  ): { readonly ok: true; readonly decision: CognitiveDecision } | { readonly ok: false; readonly reason: string } {
    const settings = cognitionSettings(this.config);
    if (settings === undefined) return { ok: false, reason: "cognition is not configured" };
    const entries = open.input.entries[characterId] ?? [];
    const references = new Set(
      entries.map((entry) => entry.reference).filter((reference): reference is string => reference !== null),
    );
    for (const reference of draft.attention)
      if (reference === "" || !references.has(reference))
        return { ok: false, reason: `attention names ${reference}, which was never admitted` };
    for (const reference of draft.consumedObservations)
      if (reference === "" || !references.has(reference))
        return { ok: false, reason: `consumption names ${reference}, which was never admitted` };
    const held = new Set(
      (this.cognition.record(open.input.cognition, characterId)?.intentions ?? []).map(
        (intention) => intention.intentionId,
      ),
    );
    for (const intentionId of draft.consideredIntentions)
      if (!held.has(intentionId)) return { ok: false, reason: `considered intention ${intentionId} is not held` };
    const creations = draft.intentionChanges.filter((change) => change.intentionId === null).length;
    if (creations > Math.max(1, settings.intentionReservation))
      return { ok: false, reason: `the decision creates ${creations} intentions at once` };
    for (const change of draft.intentionChanges) {
      if (change.intentionId !== null && !held.has(change.intentionId))
        return { ok: false, reason: `intention ${change.intentionId} is not held` };
      if (change.content.trim() === "") return { ok: false, reason: "an intention change carries no content" };
    }
    if (draft.speech !== null && this.speechAction() === undefined)
      return { ok: false, reason: "the decision speaks, but no allowed action declares an utterance" };
    const carried = draft.steps.length + (draft.speech === null ? 0 : 1);
    if (carried > settings.maxPlanSteps)
      return { ok: false, reason: `the plan carries ${carried} steps, the bound is ${settings.maxPlanSteps}` };
    for (const step of draft.steps) {
      if (!settings.allowedActions.includes(step.action))
        return { ok: false, reason: `action ${step.action} is not allowed for this entity` };
      for (const reference of [step.target, step.destination]) {
        if (reference === undefined) continue;
        if (!references.has(reference))
          return { ok: false, reason: `${step.action} names ${reference}, which was never admitted` };
      }
    }
    if (draft.steps.length > 0 && draft.idle !== null)
      return { ok: false, reason: "a decision with a plan must not also declare an idle commitment" };
    if (draft.steps.length === 0 && draft.speech === null) {
      if (draft.idle === null) return { ok: false, reason: "the decision neither acts nor commits to a bounded wait" };
      const idle = this.checkIdle(open.input.tick, draft.idle, settings.idleWaitLimitTicks);
      if (!idle.ok) return idle;
    }
    return {
      ok: true,
      decision: Object.freeze({
        ...draft,
        characterId,
        attention: Object.freeze([...draft.attention]),
        questions: Object.freeze([...draft.questions]),
        intentionChanges: Object.freeze([...draft.intentionChanges]),
        steps: Object.freeze(draft.steps.map((step) => Object.freeze({ ...step }))),
        consumedObservations: Object.freeze([...draft.consumedObservations]),
        consideredIntentions: Object.freeze([...draft.consideredIntentions]),
      }),
    };
  }

  /** An idle commitment is only legal when its wait is bounded and its cause verifiable. */
  private checkIdle(
    tick: number,
    idle: IdleCommitment,
    waitLimit: number,
  ): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
    if (idle.detail.trim() === "")
      return { ok: false, reason: "the idle commitment says nothing about what it waits for" };
    if (idle.kind === "external-event") {
      if (idle.event === null || idle.event.trim() === "")
        return { ok: false, reason: "waiting for an external event without naming a verifiable one" };
      if (!observableEvents(this.config).includes(idle.event))
        return { ok: false, reason: `${idle.event} is not an event anything can observe` };
    }
    if (idle.untilTick <= tick)
      return {
        ok: false,
        reason: `the wait ends before it starts (from tick ${tick}, waitTicks must be greater than 0)`,
      };
    if (idle.untilTick - tick > waitLimit)
      return { ok: false, reason: `the wait runs ${idle.untilTick - tick} ticks, the bound is ${waitLimit}` };
    if (idle.reviewTick <= tick || idle.reviewTick > idle.untilTick)
      return {
        ok: false,
        reason:
          "the re-review moment lies outside the wait (reviewInTicks must be greater than 0 and at most waitTicks)",
      };
    return { ok: true };
  }

  /** Adds the plan the player chose while the barrier was open. */
  submitPlayerPlan(
    seed: ParticipantSeed,
    plan: ActionPlan,
    consumedReferences: readonly string[],
    allowedAnchors: readonly string[],
  ): DecisionResult {
    const open = this.open;
    if (open === undefined) return { ok: false, message: "当前没有等待决定的认知轮次" };
    const existing = open.input.participants.find((participant) => participant.characterId === seed.characterId);
    if (existing !== undefined && existing.control !== seed.control)
      return { ok: false, message: "该角色在本轮中的控制来源不同" };
    const participant = open.participants.find((candidate) => candidate.characterId === seed.characterId);
    if (participant !== undefined && participant.state !== "waiting")
      return { ok: false, message: "本轮你已经提交过决定" };
    const approved = new Set(allowedAnchors);
    for (const step of plan.steps)
      for (const anchor of [step.target, step.destination])
        if (anchor !== undefined && !approved.has(anchor)) return { ok: false, message: "该对象不在你当前的观察中" };
    const references = new Set(open.input.entries[plan.entityId]?.map((entry) => entry.reference) ?? []);
    // The player acts on what it perceives, which can be wider than what Working
    // Memory admitted; a confirmation only ever releases what was actually admitted.
    const confirmed = [...new Set(consumedReferences)].filter((reference) => references.has(reference));
    if (participant === undefined) open.participants.push(participantOf(seed, "joined while the barrier was open"));
    open.plans.push(plan);
    open.consumptions.set(plan.entityId, Object.freeze(confirmed));
    this.update(plan.entityId, { state: "decided", detail: `player command ${plan.planId}` });
    open.notes.push(`${plan.entityId} joined the round with ${plan.steps.length} step(s)`);
    return { ok: true, message: "已加入本轮统一交接" };
  }

  /** The player declines to act in this round; its existing actions are untouched. */
  skipPlayer(seed: ParticipantSeed): DecisionResult {
    const open = this.open;
    if (open === undefined) return { ok: false, message: "当前没有等待决定的认知轮次" };
    const existing = open.input.participants.find((participant) => participant.characterId === seed.characterId);
    if (existing !== undefined && existing.control !== seed.control)
      return { ok: false, message: "该角色在本轮中的控制来源不同" };
    const participant = open.participants.find((candidate) => candidate.characterId === seed.characterId);
    if (participant === undefined) open.participants.push(participantOf(seed, "skipped while the barrier was open"));
    this.update(seed.characterId, { state: "skipped", detail: "player skipped" });
    open.notes.push(`${seed.characterId} skipped this round`);
    return { ok: true, message: "本轮不提交新计划" };
  }

  /** The batch handoff, or `null` while somebody still owes a decision. */
  resolution(): RoundResolution | null {
    const open = this.open;
    if (open === undefined) return null;
    if (open.participants.some((participant) => participant.state === "waiting" || participant.state === "requested"))
      return null;
    return Object.freeze({
      round: this.roundOf(open),
      decisions: Object.freeze(
        [...open.decisions.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([, decision]) => decision),
      ),
      plans: Object.freeze(
        [...open.plans].sort(
          (left, right) => left.entityId.localeCompare(right.entityId) || left.planId.localeCompare(right.planId),
        ),
      ),
      consumptions: Object.freeze(
        Object.fromEntries([...open.consumptions.entries()].sort(([left], [right]) => left.localeCompare(right))),
      ),
    });
  }

  notes(): readonly string[] {
    return Object.freeze([...(this.open?.notes ?? [])]);
  }

  /** Closes the round; the runtime has published the tick or stopped on its failure. */
  close(failure: string | null = null): CognitionRound | undefined {
    const open = this.open;
    if (open === undefined) return undefined;
    if (failure !== null) open.failure = failure;
    const round = this.roundOf(open);
    for (const participant of open.participants)
      if (participant.requestId !== null && participant.state === "requested")
        this.models.cancel(participant.requestId);
    this.open = undefined;
    return round;
  }

  /** Cancels every in-flight request; a loaded timeline keeps nothing from the old one. */
  cancelAll(): void {
    const open = this.open;
    if (open === undefined) return;
    for (const participant of open.participants)
      if (participant.requestId !== null) this.models.cancel(participant.requestId);
    this.open = undefined;
  }
}

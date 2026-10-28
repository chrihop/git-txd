import { EventEmitter } from "node:events";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { configSchema, type Config, queueAllowance } from "./config.js";
import {
  digestRequest,
  type Health,
  isTerminal,
  type Job,
  type StoredRequest,
  sanitizedError,
  requestSchema,
  TxdError,
  validatePathSyntax,
} from "./model.js";
import { Repository } from "./repository.js";
import { Store } from "./store.js";

/** One durable scheduler and Git worker for one canonical worktree. */
export class Coordinator {
  readonly events = new EventEmitter();
  health: Health = "RECOVERING";
  pauseReason: string | null = null;
  activeId: string | null = null;
  private draining: Promise<void> | undefined;
  private closed = false;
  private closing: Promise<void> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private nextArchiveAt = 0;

  private constructor(
    readonly config: Config,
    readonly repository: Repository,
    readonly store: Store,
  ) {
    this.events.setMaxListeners(0);
  }

  static async open(input: unknown): Promise<Coordinator> {
    const config = configSchema.parse(input);
    const repository = await Repository.open(config);
    let store: Store;
    try {
      store = new Store(join(repository.stateDir, "ledger.sqlite"));
    } catch (error) {
      repository.close();
      throw error;
    }
    const coordinator = new Coordinator(repository.config, repository, store);
    try {
      const binding = JSON.stringify({
        repository: repository.identity,
        branch: config.branch,
        remote: config.remote,
      });
      const previous = store.meta("binding");
      if (previous && previous !== binding)
        throw new TxdError(
          "CONFIG_CONFLICT",
          "The ledger is bound to another branch or remote.",
        );
      store.setMeta("binding", binding);
      await coordinator.recover();
      coordinator.timer = setInterval(() => {
        coordinator.expire();
        coordinator.archiveHistory();
        coordinator.kick();
      }, 100);
      coordinator.timer.unref();
      coordinator.kick();
      return coordinator;
    } catch (error) {
      store.close();
      repository.close();
      throw error;
    }
  }

  async commitAndPush(
    input: unknown,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const request: StoredRequest = requestSchema.parse(input);
    validatePathSyntax(request.files);
    const identity = `${this.repository.identity}:${this.config.branch}:${this.config.remote}`;
    const digest = digestRequest(request, identity);
    const existing = this.store.get(request.request_id);
    if (existing) {
      this.checkDigest(existing, digest);
      this.store.event(request.request_id, "DUPLICATE_REQUEST");
      return this.wait(
        request.request_id,
        request.wait_timeout_seconds,
        signal,
      );
    }
    if (
      request.author &&
      !this.config.allowedAuthors.some(
        (author) =>
          author.name === request.author!.name &&
          author.email === request.author!.email,
      )
    ) {
      throw new TxdError(
        "AUTHOR_NOT_ALLOWED",
        "The requested author is not allowlisted by the daemon.",
      );
    }
    this.assertAccepting();
    request.snapshot_sizes = await this.repository.validateFiles(request.files);
    // Validation yields; another client may have accepted this ID in the meantime.
    const raced = this.store.get(request.request_id);
    if (raced) {
      this.checkDigest(raced, digest);
      return this.wait(
        request.request_id,
        request.wait_timeout_seconds,
        signal,
      );
    }
    this.assertAccepting();
    const outstanding = this.store
      .jobs()
      .filter((job) => !isTerminal(job.status));
    const pending = outstanding.filter((job) => job.status === "QUEUED");
    const agent = request.metadata?.agent_id ?? "anonymous";
    const agentPending = pending.filter(
      (job) =>
        (JSON.parse(job.payload_json) as StoredRequest).metadata?.agent_id ===
          agent ||
        (agent === "anonymous" &&
          !(JSON.parse(job.payload_json) as StoredRequest).metadata?.agent_id),
    );
    if (
      pending.length >= this.config.maxPending ||
      agentPending.length >= this.config.maxPendingPerAgent
    ) {
      throw new TxdError(
        "QUEUE_FULL",
        "Queue capacity reached; this request was not accepted.",
      );
    }
    this.store.insert(
      request,
      digest,
      Date.now() + queueAllowance(outstanding.length, this.config),
    );
    this.kick();
    return this.wait(request.request_id, request.wait_timeout_seconds, signal);
  }

  status(id: string): Record<string, unknown> {
    this.expire();
    const job = this.store.get(id);
    if (!job) throw new TxdError("NOT_FOUND", "Unknown transaction ID.");
    return this.result(job);
  }

  queue(): Record<string, unknown> {
    this.expire();
    const jobs = this.store.jobs();
    const pending = jobs.filter((job) => job.status === "QUEUED");
    const active = jobs.find(
      (job) => !isTerminal(job.status) && job.status !== "QUEUED",
    );
    const ahead = pending.length + Number(Boolean(active));
    const counts = this.store.eventCounts();
    return {
      repository_state: this.health,
      pause_reason: this.pauseReason,
      active: active
        ? { request_id: active.request_id, stage: active.status }
        : null,
      pending_count: pending.length,
      ahead_if_submitted: ahead,
      estimated_wait_sec: (ahead * this.config.slotMs) / 1000,
      oldest_wait_ms: pending[0] ? Date.now() - pending[0].accepted_at_ms : 0,
      last_confirmed_remote_sha: this.store.meta("confirmed_remote") ?? null,
      last_local_transaction_sha: this.store.meta("last_local_commit") ?? null,
      event_counts: counts,
      archival_error: this.store.meta("archival_error") ?? null,
      pending: pending.map((job, index) => ({
        request_id: job.request_id,
        enqueue_seq: job.enqueue_seq,
        ahead: index + Number(Boolean(active)),
        queue_deadline_ms: job.queue_deadline_ms,
      })),
    };
  }

  cancel(id: string): Record<string, unknown> {
    const job = this.store.get(id);
    if (!job) throw new TxdError("NOT_FOUND", "Unknown transaction ID.");
    if (job.status === "QUEUED" && job.started_at_ms === null)
      this.transition(id, "CANCELLED_QUEUED", { finished_at_ms: Date.now() });
    return this.status(id);
  }

  async wait(
    id: string,
    seconds?: number | null,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const job = this.store.get(id);
    if (!job) throw new TxdError("NOT_FOUND", "Unknown transaction ID.");
    const allowance =
      seconds == null
        ? Math.max(0, job.queue_deadline_ms - Date.now()) +
          2 * this.config.gitTimeoutMs +
          (this.config.pushRetries + 1) *
            (this.config.pushTimeoutMs + this.config.reconciliationTimeoutMs) +
          15000
        : seconds * 1000;
    const deadline = Date.now() + Math.min(allowance, 3600000);
    while (true) {
      const current = this.store.get(id)!;
      if (isTerminal(current.status) || this.health === "PAUSED" || this.closed)
        return this.result(current);
      if (signal?.aborted || Date.now() >= deadline)
        return this.result(current, true);
      await this.changed(id, Math.min(deadline - Date.now(), 1000), signal);
    }
  }

  close(): Promise<void> {
    this.closing ??= this.shutdown();
    return this.closing;
  }

  private async shutdown(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    for (const job of this.store.jobs())
      this.events.emit(`job:${job.request_id}`);
    await this.draining;
    try {
      this.store.close();
    } finally {
      this.repository.close();
    }
  }

  private assertAccepting(): void {
    if (
      this.closed ||
      this.health === "PAUSED" ||
      this.health === "RECOVERING"
    ) {
      throw new TxdError(
        "REPOSITORY_PAUSED",
        this.pauseReason ?? "Repository is not ready to accept writes.",
      );
    }
  }

  private checkDigest(job: Job, digest: string): void {
    if (job.request_digest !== digest)
      throw new TxdError(
        "REQUEST_ID_CONFLICT",
        "Request ID already belongs to a different logical payload.",
      );
  }

  private result(job: Job, waitingEnded = false): Record<string, unknown> {
    return {
      request_id: job.request_id,
      status: waitingEnded ? "IN_PROGRESS" : job.status,
      durable_state: job.status,
      enqueue_seq: job.enqueue_seq,
      commit_sha: job.commit_sha,
      remote: this.config.remote,
      branch: this.config.branch,
      pushed: job.status === "SUCCEEDED",
      repository_state: this.health,
      pause_reason: this.pauseReason,
      accepted_at_ms: job.accepted_at_ms,
      queue_deadline_ms: job.queue_deadline_ms,
      started_at_ms: job.started_at_ms,
      finished_at_ms: job.finished_at_ms,
      queue_wait_ms:
        job.started_at_ms === null
          ? null
          : job.started_at_ms - job.accepted_at_ms,
      execution_ms:
        job.finished_at_ms === null || job.started_at_ms === null
          ? null
          : job.finished_at_ms - job.started_at_ms,
      remote_tip_sha: job.remote_tip_sha,
      error_code: job.last_error_code,
      error_message: job.last_error_message,
      stage_timings: this.store.stageTimings(job.request_id),
    };
  }

  /** Run bounded cold-history maintenance only between Git transactions. */
  archiveHistory(now = Date.now()): void {
    if (
      this.closed ||
      this.health !== "READY" ||
      this.draining ||
      this.activeId ||
      now < this.nextArchiveAt ||
      this.store.jobs().some((job) => !isTerminal(job.status))
    )
      return;
    this.nextArchiveAt = now + 3600000;
    try {
      const result = this.store.archive(
        now - this.config.ledgerRetentionDays * 86400000,
        this.config.ledgerArchiveBatchSize,
      );
      this.store.setMeta("archival_error", "");
      if (result.archived || result.deferred)
        this.events.emit("diagnostic", {
          event: "LEDGER_ARCHIVAL",
          ...result,
          at_ms: now,
        });
    } catch {
      this.store.setMeta(
        "archival_error",
        "ARCHIVAL_FAILED: original ledger history retained; inspect archive storage.",
      );
      this.events.emit("diagnostic", {
        event: "LEDGER_ARCHIVAL_FAILED",
        at_ms: now,
      });
    }
  }

  private changed(id: string, ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.events.off(`job:${id}`, done);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.events.once(`job:${id}`, done);
      signal?.addEventListener("abort", done, { once: true });
      if (signal?.aborted) done();
    });
  }

  private transition(
    id: string,
    status: Job["status"],
    fields: Parameters<Store["update"]>[2] = {},
  ): Job {
    const job = this.store.update(id, status, fields);
    this.events.emit("transition", {
      event: "TRANSACTION_STATE",
      request_id: id,
      state: status,
      at_ms: Date.now(),
    });
    this.events.emit(`job:${id}`);
    return job;
  }

  private pause(error: unknown, id?: string): void {
    const safe =
      error instanceof TxdError
        ? error
        : new TxdError(
            "INTERNAL_ERROR",
            "Unexpected coordinator error; inspect durable state before resuming.",
          );
    this.health = "PAUSED";
    this.pauseReason = `${safe.code}: ${safe.message}`;
    this.store.setMeta("pause_reason", this.pauseReason);
    if (id)
      this.transition(id, "RECONCILIATION_REQUIRED", {
        last_error_code: safe.code,
        last_error_message: safe.message,
      });
    for (const job of this.store.jobs())
      this.events.emit(`job:${job.request_id}`);
  }

  private expire(): void {
    if (this.closed) return;
    for (const job of this.store.jobs()) {
      if (
        job.status === "QUEUED" &&
        job.started_at_ms === null &&
        job.queue_deadline_ms <= Date.now()
      ) {
        this.transition(job.request_id, "QUEUE_EXPIRED", {
          finished_at_ms: Date.now(),
        });
      }
    }
  }

  private kick(): void {
    if (
      this.draining ||
      this.closed ||
      !["READY", "BUSY"].includes(this.health)
    )
      return;
    this.draining = this.drain()
      .catch((error: unknown) => this.pause(error, this.activeId ?? undefined))
      .finally(() => {
        this.draining = undefined;
        if (
          !this.closed &&
          this.health === "READY" &&
          this.store.jobs().some((job) => job.status === "QUEUED")
        )
          this.kick();
      });
  }

  private async drain(): Promise<void> {
    while (!this.closed && this.health !== "PAUSED") {
      this.expire();
      const job = this.store
        .jobs()
        .find((candidate) => candidate.status === "QUEUED");
      if (!job) {
        this.health = "READY";
        return;
      }
      this.activeId = job.request_id;
      this.health = "BUSY";
      // Claim synchronously before yielding so deadlines/cancellation cannot race Git execution.
      this.transition(job.request_id, "RUNNING_PRECOMMIT", {
        started_at_ms: job.started_at_ms ?? Date.now(),
      });
      await this.execute(this.store.get(job.request_id)!);
      this.activeId = null;
    }
  }

  private async execute(job: Job): Promise<void> {
    const request = JSON.parse(job.payload_json) as StoredRequest;
    const validationStart = Date.now();
    let parent: string;
    try {
      parent = await this.repository.assertBoundary(
        this.store.meta("expected_head"),
      );
      const remote = await this.repository.remoteTip();
      if (remote !== parent)
        throw new TxdError(
          "REMOTE_CHANGED",
          "Remote target differs from the confirmed local base.",
        );
      this.transition(job.request_id, "RUNNING_PRECOMMIT", {
        expected_parent: parent,
        remote_tip_sha: remote,
      });
    } catch (error) {
      this.pause(error, job.request_id);
      return;
    }
    let stage = "validate_files";
    try {
      const sizes = await this.repository.validateFiles(request.files);
      if (
        request.snapshot_sizes &&
        request.files.some(
          (file) =>
            file.operation !== "delete" &&
            request.snapshot_sizes![file.path] !== sizes[file.path],
        )
      )
        throw new TxdError(
          "SNAPSHOT_CHANGED",
          "Working snapshot size differs from admission.",
        );
      request.snapshot_sizes ??= sizes;
      this.timing(job.request_id, "validation", validationStart);
      const stageStart = Date.now();
      stage = "stage";
      await this.repository.stage(request.files);
      this.timing(job.request_id, "stage", stageStart);
      this.store.event(job.request_id, "STAGED");
      stage = "assert_subset";
      await this.repository.assertSubset(request.files);
      stage = "staged_paths";
      if (!(await this.repository.stagedPaths()).length) {
        this.transition(job.request_id, "NO_CHANGES", {
          finished_at_ms: Date.now(),
        });
        return;
      }
      const commitStart = Date.now();
      stage = "commit_snapshot";
      await this.repository.commit(request);
      this.timing(job.request_id, "commit", commitStart);
    } catch (error) {
      await this.handlePrecommitError(job, parent, request, error, stage);
      return;
    }
    await this.recordCommit(job, parent, request);
  }

  private async handlePrecommitError(
    job: Job,
    parent: string,
    request: StoredRequest,
    error: unknown,
    stage = "unknown",
  ): Promise<void> {
    try {
      this.store.event(
        job.request_id,
        "PRECOMMIT_DIAGNOSTIC",
        sanitizedError(error, stage),
      );
      if (
        error instanceof TxdError &&
        ["GIT_TERMINATION_FAILED", "GIT_CUSTODY_UNCONFIRMED"].includes(
          error.code,
        )
      ) {
        this.pause(error, job.request_id);
        return;
      }
      const head = await this.repository.head();
      if (head !== parent) {
        await this.recordCommit(job, parent, request);
        return;
      }
      await this.repository.cleanRequestIndex(request.files, parent);
      const safe =
        error instanceof TxdError
          ? error
          : new TxdError(
              "PRECOMMIT_ERROR",
              "Commit failed before creating local history.",
            );
      this.transition(job.request_id, "PRECOMMIT_FAILED", {
        finished_at_ms: Date.now(),
        last_error_code: safe.code,
        last_error_message: safe.message,
      });
    } catch (cleanupError) {
      this.pause(cleanupError, job.request_id);
    }
  }

  private async recordCommit(
    job: Job,
    parent: string,
    request: StoredRequest,
  ): Promise<void> {
    const sha = await this.repository.head();
    // Persist SHA immediately, before validation/network actions.
    this.transition(job.request_id, "LOCAL_COMMITTED", { commit_sha: sha });
    this.store.setMeta("last_local_commit", sha);
    try {
      await this.repository.verifyCommit(sha, parent, request);
      await this.repository.assertBoundary(sha);
      this.store.setMeta("expected_head", sha);
      await this.reconcile(this.store.get(job.request_id)!);
    } catch (error) {
      this.pause(error, job.request_id);
    }
  }

  private async reconcile(job: Job): Promise<void> {
    const sha = job.commit_sha!;
    this.transition(job.request_id, "RECONCILING");
    for (let attempt = 0; attempt <= this.config.pushRetries; attempt++) {
      const inspectStart = Date.now();
      const tip = await this.repository.remoteTip();
      this.timing(job.request_id, "reconciliation", inspectStart);
      this.transition(job.request_id, "RECONCILING", { remote_tip_sha: tip });
      if (tip === sha) {
        this.store.setMeta("expected_head", sha);
        this.store.setMeta("confirmed_remote", tip);
        this.transition(job.request_id, "SUCCEEDED", {
          finished_at_ms: Date.now(),
          last_error_code: null,
          last_error_message: null,
        });
        return;
      }
      if (!tip)
        throw new TxdError(
          "REMOTE_MISSING",
          "Configured remote branch disappeared.",
        );
      if (
        tip !== job.expected_parent ||
        tip !== this.store.meta("confirmed_remote")
      ) {
        await this.repository.fetchRemoteTip(tip);
        if (await this.repository.isAncestor(sha, tip)) {
          this.store.setMeta("confirmed_remote", tip);
          this.transition(job.request_id, "SUCCEEDED", {
            finished_at_ms: Date.now(),
          });
          this.pause(
            new TxdError(
              "EXTERNAL_REMOTE_ADVANCE",
              "Publication confirmed, but an external writer advanced the remote. Align history before restarting.",
            ),
          );
          return;
        }
        throw new TxdError(
          "REMOTE_DIVERGED",
          "Remote history changed; preserve the local commit and resolve in a maintenance window.",
        );
      }
      if (attempt > 0) {
        this.store.event(job.request_id, "PUSH_RETRY");
        await delay(Math.min(1000, attempt * 100));
      }
      this.transition(job.request_id, "PUSHING");
      const pushStart = Date.now();
      try {
        await this.repository.push(sha);
      } catch (error) {
        if (
          error instanceof TxdError &&
          ["GIT_TERMINATION_FAILED", "GIT_CUSTODY_UNCONFIRMED"].includes(
            error.code,
          )
        ) {
          this.store.event(
            job.request_id,
            "CUSTODY_DIAGNOSTIC",
            sanitizedError(error, "push"),
          );
          this.pause(error, job.request_id);
          return;
        }
        this.transition(job.request_id, "PUSH_PENDING", {
          last_error_code: "PUSH_UNCONFIRMED",
          last_error_message:
            "Local commit preserved; publication requires remote inspection.",
        });
      } finally {
        this.timing(job.request_id, "push", pushStart);
      }
      // A zero exit is also confirmed by a read, rather than treated as rollback on timeout.
      const observed = await this.repository.remoteTip();
      if (observed === sha) {
        this.store.setMeta("expected_head", sha);
        this.store.setMeta("confirmed_remote", sha);
        this.transition(job.request_id, "SUCCEEDED", {
          remote_tip_sha: sha,
          finished_at_ms: Date.now(),
          last_error_code: null,
          last_error_message: null,
        });
        return;
      }
      if (observed && observed !== tip) {
        await this.repository.fetchRemoteTip(observed);
        if (await this.repository.isAncestor(sha, observed)) {
          this.store.setMeta("confirmed_remote", observed);
          this.transition(job.request_id, "SUCCEEDED", {
            remote_tip_sha: observed,
            finished_at_ms: Date.now(),
            last_error_code: null,
            last_error_message: null,
          });
          this.pause(
            new TxdError(
              "EXTERNAL_REMOTE_ADVANCE",
              "Publication confirmed, but an external writer advanced the remote. Align history before restarting.",
            ),
          );
          return;
        }
        throw new TxdError(
          "REMOTE_DIVERGED",
          "Remote target changed during push; publication is unresolved.",
        );
      }
    }
    throw new TxdError(
      "PUSH_UNCONFIRMED",
      "Push retries exhausted. Local commit is preserved; later commits are blocked.",
    );
  }

  private async recover(): Promise<void> {
    try {
      const unfinished = this.store
        .jobs()
        .filter((job) => !isTerminal(job.status) && job.status !== "QUEUED");
      if (unfinished.length > 1)
        throw new TxdError(
          "LEDGER_AMBIGUOUS",
          "More than one unfinished Git transaction exists.",
        );
      const job = unfinished[0];
      if (this.config.acceptAlignedHead)
        await this.acceptOperatorAlignment(job);
      const recoverable = this.store
        .jobs()
        .find(
          (candidate) =>
            !isTerminal(candidate.status) && candidate.status !== "QUEUED",
        );
      if (recoverable) {
        const job = recoverable;
        const request = JSON.parse(job.payload_json) as StoredRequest;
        const head = await this.repository.head();
        if (!job.expected_parent) {
          // A failure before recording a parent must pass the ordinary clean boundary gate.
          await this.repository.assertBoundary(
            this.store.meta("expected_head"),
          );
          this.transition(job.request_id, "PRECOMMIT_FAILED", {
            finished_at_ms: Date.now(),
            last_error_code: "RECOVERED_BEFORE_STAGE",
          });
        } else if (head === job.expected_parent && !job.commit_sha) {
          await this.repository.cleanRequestIndex(request.files, head);
          this.transition(job.request_id, "QUEUED", {
            expected_parent: null,
          });
          this.store.event(job.request_id, "RECOVERED_PRECOMMIT");
        } else {
          const sha = job.commit_sha ?? head;
          if (head !== sha)
            throw new TxdError(
              "HEAD_CHANGED",
              "HEAD differs from the recoverable transaction commit.",
            );
          await this.repository.verifyCommit(sha, job.expected_parent, request);
          await this.repository.assertBoundary(sha);
          this.transition(job.request_id, "LOCAL_COMMITTED", {
            commit_sha: sha,
          });
          this.store.setMeta("last_local_commit", sha);
          this.store.setMeta("expected_head", sha);
          await this.reconcile(this.store.get(job.request_id)!);
          if (this.health === "PAUSED") return;
        }
      }
      const head = await this.repository.assertBoundary(
        this.store.meta("expected_head"),
      );
      const tip = await this.repository.remoteTip();
      if (tip !== head)
        throw new TxdError(
          "INITIAL_HISTORY_MISMATCH",
          "Local HEAD and remote target must agree before accepting writes.",
        );
      this.store.setMeta("expected_head", head);
      this.store.setMeta("confirmed_remote", tip);
      this.store.setMeta("pause_reason", "");
      this.pauseReason = null;
      this.health = "READY";
      this.expire();
    } catch (error) {
      const job = this.store
        .jobs()
        .find(
          (candidate) =>
            !isTerminal(candidate.status) && candidate.status !== "QUEUED",
        );
      this.pause(error, job?.request_id);
    }
  }

  private timing(id: string, stage: string, start: number): void {
    this.store.event(id, "STAGE_TIMING", {
      stage,
      duration_ms: Date.now() - start,
    });
  }

  private async acceptOperatorAlignment(job?: Job): Promise<void> {
    const previous = this.store.meta("expected_head");
    if (!previous || !this.store.meta("pause_reason"))
      throw new TxdError(
        "ALIGNMENT_NOT_PAUSED",
        "Operator alignment requires an existing paused ledger.",
      );
    const head = await this.repository.assertBoundary();
    const tip = await this.repository.remoteTip();
    if (tip !== head || !(await this.repository.isAncestor(previous, head))) {
      throw new TxdError(
        "ALIGNMENT_UNSAFE",
        "Only an already published fast-forward with a clean index can be adopted.",
      );
    }
    if (job?.commit_sha) {
      const request = JSON.parse(job.payload_json) as StoredRequest;
      await this.repository.verifyCommit(
        job.commit_sha,
        job.expected_parent!,
        request,
      );
      if (!(await this.repository.isAncestor(job.commit_sha, head)))
        throw new TxdError(
          "ALIGNMENT_UNSAFE",
          "The unresolved transaction must remain in published history.",
        );
      this.transition(job.request_id, "SUCCEEDED", {
        remote_tip_sha: head,
        finished_at_ms: Date.now(),
        last_error_code: null,
        last_error_message: null,
      });
    } else if (job && !job.expected_parent) {
      this.transition(job.request_id, "PRECOMMIT_FAILED", {
        finished_at_ms: Date.now(),
        last_error_code: "RECOVERED_BEFORE_STAGE",
        last_error_message:
          "No Git effects occurred before the repository paused.",
      });
    } else if (job) {
      throw new TxdError(
        "ALIGNMENT_UNSAFE",
        "Recover the unjournaled transaction commit before adopting history.",
      );
    }
    this.store.event("__repository__", "OPERATOR_ALIGNMENT_ACCEPTED", {
      previous_head: previous,
      head,
    });
    this.store.setMeta("expected_head", head);
    this.store.setMeta("confirmed_remote", head);
  }
}

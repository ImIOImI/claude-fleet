// The store-backed services as idempotent steps (SPEC §8 *Startup*): a failed step
// is retried on the next call, and a step never runs twice once it succeeded.
export interface ServiceStep<S> {
  name: string;
  /** A failure skips the rest of its group; the other group still starts. */
  group: 'inbox' | 'history';
  /** Steps (of either group) that must have succeeded first. */
  after?: string[];
  run(stores: S): Promise<void> | void;
}

const LABEL = { inbox: 'Inbox unavailable', history: 'History unavailable' } as const;

export class ServiceSteps<S> {
  private readonly done = new Set<string>();

  constructor(private readonly steps: readonly ServiceStep<S>[]) {}

  /** Runs every step not yet done; throws naming each group that failed. */
  async run(stores: S): Promise<void> {
    const failed = new Map<'inbox' | 'history', string>();
    for (const st of this.steps) {
      if (this.done.has(st.name) || failed.has(st.group)) continue;
      if (st.after?.some((n) => !this.done.has(n))) continue;
      try {
        await st.run(stores);
        this.done.add(st.name);
      } catch (e) {
        failed.set(st.group, e instanceof Error ? e.message : String(e));
      }
    }
    if (failed.size) {
      throw new Error((['inbox', 'history'] as const).filter((g) => failed.has(g)).map((g) => `${LABEL[g]}: ${failed.get(g)}`).join('; '));
    }
  }

  /** The group's services were torn down: run them again on the next run(). */
  reset(group: 'inbox' | 'history'): void {
    for (const st of this.steps) if (st.group === group) this.done.delete(st.name);
  }
}

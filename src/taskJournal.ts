import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { serializeDb, deserializeDb, isEncryptedEnvelope } from './storageCrypto';
import { redact } from './redactor';
import {
  startTask,
  transitionTask,
  taskDigest,
  assertTaskAccess,
  type AgentTask,
  type ExecutionScope,
  type TaskAction,
  type TaskPrincipal,
} from './taskRuntime';

interface TaskEvent {
  version: 1;
  taskId: string;
  revision: number;
  action: 'start' | TaskAction;
  actor: string;
  requestKey: string;
  requestDigest: string;
  previousDigest: string;
  state: AgentTask;
  digest: string;
}

function safeRequest(value: unknown): unknown {
  if (typeof value === 'string')
    return redact(value, { redactSecrets: true, honorPrivateTags: true }).text;
  if (Array.isArray(value)) return value.map(safeRequest);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, safeRequest(item)]));
  return value;
}

export class TaskJournal {
  constructor(
    private readonly directory: string,
    private readonly principal: TaskPrincipal,
    private readonly options: { key?: Buffer; allowPlaintext?: boolean; now?: () => number } = {},
  ) {
    if (
      !/^[a-zA-Z0-9._:-]{1,120}$/.test(principal.id) ||
      !principal.repoScope.trim() ||
      principal.repoScope.length > 300
    )
      throw new Error('A launcher-bound principal and repository are required');
    if (
      safeRequest(principal.id) !== principal.id ||
      safeRequest(principal.repoScope) !== principal.repoScope
    )
      throw new Error('Launcher identity and scope must not contain secrets');
    if (options.key && options.key.length !== 32) throw new Error('Invalid task encryption key');
  }

  private taskPath(id: string): string {
    if (!/^[a-f0-9]{32}$/.test(id)) throw new Error('Invalid task id');
    return join(this.directory, taskDigest(this.principal.repoScope).slice(0, 32), id);
  }

  private requestKey(requestId: string): string {
    if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 120)
      throw new Error('A bounded idempotency key is required');
    return taskDigest([this.principal.id, requestId]);
  }

  private async readEvents(id: string): Promise<TaskEvent[]> {
    const directory = this.taskPath(id);
    try {
      await fs.lstat(join(directory, '.deleted.json'));
      throw new Error('Task has been deleted');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    let names: string[];
    try {
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe task directory');
      names = (await fs.readdir(directory)).filter((name) => /^\d{10}\.json$/.test(name)).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    if (names.length > 10000) throw new Error('Task journal capacity exceeded');
    const events: TaskEvent[] = [];
    for (const [index, name] of names.entries()) {
      const file = join(directory, name);
      if ((await fs.lstat(file)).isSymbolicLink()) throw new Error('Unsafe task event');
      const stat = await fs.stat(file);
      if (stat.size > 2 * 1024 * 1024) throw new Error('Oversized task event');
      const raw = await fs.readFile(file, 'utf8');
      if (!isEncryptedEnvelope(raw) && !this.options.allowPlaintext)
        throw new Error('Plaintext task journals are disabled by policy');
      const event = deserializeDb<TaskEvent>(raw, this.options.key);
      if (
        !event ||
        event.version !== 1 ||
        event.taskId !== id ||
        event.revision !== index + 1 ||
        name !== `${String(index + 1).padStart(10, '0')}.json` ||
        event.previousDigest !== (events[index - 1]?.digest ?? '') ||
        !event.state ||
        event.state.version !== 1 ||
        event.state.authority !== 'none' ||
        event.state.id !== id ||
        event.state.revision !== index + 1
      )
        throw new Error('Task journal is locked, corrupt, or has a revision gap');
      const { digest, ...body } = event;
      if (taskDigest(body) !== digest) throw new Error('Task journal integrity mismatch');
      assertTaskAccess(event.state, this.principal);
      events.push(event);
    }
    return events;
  }

  async read(id: string): Promise<AgentTask> {
    const events = await this.readEvents(id);
    const state = events[events.length - 1]?.state;
    if (!state) throw new Error('Task unavailable in this principal scope');
    return structuredClone(state);
  }

  private async locked<T>(id: string, operation: () => Promise<T>): Promise<T> {
    if (!this.principal.canWrite) throw new Error('Task writes are disabled by launcher policy');
    if (!this.options.key && !this.options.allowPlaintext)
      throw new Error('Configure a task encryption key or explicitly allow plaintext tasks');
    const directory = this.taskPath(id);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    if ((await fs.lstat(directory)).isSymbolicLink()) throw new Error('Unsafe task directory');
    const lockPath = join(directory, '.lock');
    let lock: Awaited<ReturnType<typeof fs.open>>;
    try {
      lock = await fs.open(lockPath, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw new Error('Task is busy or has an orphaned lock; retry or recover offline');
      throw error;
    }
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid, nonce: randomUUID() }));
      await lock.sync();
      return await operation();
    } finally {
      await lock.close();
      await fs.unlink(lockPath);
    }
  }

  private async commit(
    events: TaskEvent[],
    state: AgentTask,
    action: TaskEvent['action'],
    requestKey: string,
    requestDigest: string,
  ): Promise<AgentTask> {
    if (events.length >= 10000) throw new Error('Task journal capacity exceeded');
    const body: Omit<TaskEvent, 'digest'> = {
      version: 1,
      taskId: state.id,
      revision: state.revision,
      action,
      actor: this.principal.id,
      requestKey,
      requestDigest,
      previousDigest: events[events.length - 1]?.digest ?? '',
      state,
    };
    const event: TaskEvent = { ...body, digest: taskDigest(body) };
    const directory = this.taskPath(state.id);
    const target = join(directory, `${String(state.revision).padStart(10, '0')}.json`);
    const temporary = join(directory, `.pending-${randomUUID()}.tmp`);
    const file = await fs.open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(
        serializeDb(event, this.options.key, this.options.key ? 'os-keychain' : undefined),
      );
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await fs.rename(temporary, target);
      if (process.platform !== 'win32') {
        const handle = await fs.open(directory, 'r');
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
    } finally {
      await fs.unlink(temporary).catch(() => undefined);
    }
    return structuredClone(state);
  }

  async start(input: unknown, scope: ExecutionScope, requestId: string): Promise<AgentTask> {
    const requestKey = this.requestKey(requestId);
    const id = taskDigest([this.principal.repoScope, requestKey]).slice(0, 32);
    const requestDigest = taskDigest(safeRequest({ action: 'start', input, scope }));
    return this.locked(id, async () => {
      const events = await this.readEvents(id);
      if (events.length) {
        if (events[0].requestDigest !== requestDigest)
          throw new Error('Idempotency key reused for a different request');
        return structuredClone(events[0].state);
      }
      return this.commit(
        events,
        startTask(input, this.principal, scope, id, this.options.now?.() ?? Date.now()),
        'start',
        requestKey,
        requestDigest,
      );
    });
  }

  async mutate(
    id: string,
    expectedRevision: number,
    requestId: string,
    action: TaskAction,
    input: unknown,
    scope: ExecutionScope,
  ): Promise<AgentTask> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
      throw new Error('Expected revision must be a positive integer');
    const requestKey = this.requestKey(requestId);
    const requestDigest = taskDigest(safeRequest({ action, input, scope, expectedRevision }));
    return this.locked(id, async () => {
      const events = await this.readEvents(id);
      const current = events[events.length - 1]?.state;
      if (!current) throw new Error('Task unavailable in this principal scope');
      const prior = events.find((event) => event.requestKey === requestKey);
      if (prior) {
        if (prior.requestDigest !== requestDigest)
          throw new Error('Idempotency key reused for a different request');
        return structuredClone(prior.state);
      }
      if (current.revision !== expectedRevision)
        throw new Error(
          `Revision conflict: expected ${expectedRevision}, current ${current.revision}`,
        );
      const next = transitionTask(
        current,
        action,
        input,
        this.principal,
        scope,
        this.options.now?.() ?? Date.now(),
      );
      return this.commit(events, next, action, requestKey, requestDigest);
    });
  }

  async purge(
    id: string,
    expectedRevision: number,
    requestId: string,
  ): Promise<{ deleted: true; taskId: string }> {
    const requestKey = this.requestKey(requestId);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
      throw new Error('Invalid purge revision');
    return this.locked(id, async () => {
      const directory = this.taskPath(id);
      const marker = join(directory, '.deleted.json');
      let existing: { ownerHash: string; requestKey: string; revision: number } | undefined;
      try {
        existing = JSON.parse(await fs.readFile(marker, 'utf8'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (existing) {
        if (
          existing.ownerHash !== taskDigest(this.principal.id) ||
          existing.requestKey !== requestKey ||
          existing.revision !== expectedRevision
        )
          throw new Error('Task unavailable or purge request differs');
      } else {
        const events = await this.readEvents(id);
        const state = events[events.length - 1]?.state;
        if (!state || state.owner !== this.principal.id)
          throw new Error('Only the task owner may purge history');
        if (state.revision !== expectedRevision) throw new Error('Purge revision conflict');
        const temporary = join(directory, `.pending-${randomUUID()}.tmp`);
        const handle = await fs.open(temporary, 'wx', 0o600);
        try {
          await handle.writeFile(
            JSON.stringify({
              ownerHash: taskDigest(this.principal.id),
              requestKey,
              revision: expectedRevision,
            }),
          );
          await handle.sync();
        } finally {
          await handle.close();
        }
        await fs.rename(temporary, marker);
      }
      for (const name of await fs.readdir(directory)) {
        if (/^\d{10}\.json$/.test(name) || /^\.pending-.*\.tmp$/.test(name))
          await fs.unlink(join(directory, name));
      }
      return { deleted: true, taskId: id };
    });
  }
}

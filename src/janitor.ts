/**
 * Weekly janitor: re-score every stored session against the current
 * quality heuristic and refresh its `qualityScore` / `lowQuality` flags.
 * Optionally prunes sessions that have been low-quality for longer than
 * `pruneAfterDays` AND were never accepted by the user.
 *
 * Pure helper module — the timer is wired up in extension.ts.
 */
import { ContextStore } from './contextStore';
import { scoreSessionQuality } from './quality';
import { deriveLessons } from './lessons';

export interface JanitorOptions {
  qualityFloor: number;
  pruneAfterDays: number;
  /** Minimum distinct sessions before a recurring decision becomes a lesson. Default 2. */
  lessonMinSupport?: number;
}

export interface JanitorReport {
  rescored: number;
  flagged: number;
  unflagged: number;
  pruned: number;
  lessonsCreated: number;
  lessonsReinforced: number;
}

export async function runJanitor(
  store: ContextStore,
  opts: JanitorOptions,
): Promise<JanitorReport> {
  const report: JanitorReport = {
    rescored: 0,
    flagged: 0,
    unflagged: 0,
    pruned: 0,
    lessonsCreated: 0,
    lessonsReinforced: 0,
  };
  const sessions = store.getAllSessions();
  const now = Date.now();
  const DAY = 86_400_000;
  const toPrune: string[] = [];

  for (const s of sessions) {
    const q = scoreSessionQuality(s);
    const wasLow = !!s.lowQuality;
    const isLow = q.score < opts.qualityFloor;
    if (wasLow !== isLow) {
      if (isLow) {
        await store.setNoise(s.id);
        report.flagged++;
      } else {
        await store.undoNoise(s.id);
        report.unflagged++;
      }
    }
    // Store qualityScore in-place; persisted on next mutation or prune.
    s.qualityScore = q.score;
    report.rescored++;

    // Age the session from whichever happened later — original capture or the
    // user's most recent interaction with it. Using `endTime` alone meant a
    // session captured 90 days ago but retrieved/accepted yesterday would still
    // be eligible for pruning. That was a real footgun: pruneAfterDays=30 plus
    // a low-quality flag could delete sessions the user is actively using.
    const lastTouched = Math.max(s.endTime, s.usage?.lastInteractionAt ?? 0);
    if (
      opts.pruneAfterDays > 0 &&
      (s.lowQuality || isLow) &&
      (s.usage?.accepted ?? 0) === 0 &&
      now - lastTouched > opts.pruneAfterDays * DAY
    ) {
      toPrune.push(s.id);
    }
  }

  if (toPrune.length > 0) {
    report.pruned = await store.deleteSessions(toPrune);
  }

  // Consolidation pass: distill recurring decisions/problems from the
  // (surviving) episodic sessions into durable semantic + procedural lessons,
  // reinforcing any previously-derived ones instead of duplicating.
  const surviving = store.getAllSessions();
  const { lessons, created, reinforced } = deriveLessons(surviving, store.getLessons(), {
    minSupport: opts.lessonMinSupport ?? 2,
  });
  if (created > 0 || reinforced > 0) {
    await store.setLessons(lessons);
  }
  report.lessonsCreated = created;
  report.lessonsReinforced = reinforced;

  return report;
}

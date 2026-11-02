export interface TokenSavingsSource {
  rawText?: string;
  compactText?: string;
  summary?: string;
  keyFiles?: string[];
  keyTopics?: string[];
  decisions?: string[];
  problemsSolved?: string[];
}

export interface TokenSavingsEstimate {
  measurement?: 'estimated' | 'tokenized';
  baseline?: 'provided-text' | 'structured-proxy';
  rawChars: number;
  compactChars: number;
  rawTokens: number;
  compactTokens: number;
  tokensSaved: number;
  compressionRatio: number;
}

export interface TokenSavingsAggregate extends TokenSavingsEstimate {
  sessionCount: number;
}

const CHARS_PER_TOKEN = 4;

function estimateTokens(chars: number): number {
  return Math.round(chars / CHARS_PER_TOKEN);
}

/**
 * Optional real tokenizer. When the extension wires VS Code's
 * `lm.countTokens`, the `*Measured` helpers report exact token counts instead
 * of the chars/4 heuristic. Left unset in CI / tests / the stand-alone seeder
 * (which must run without a live model), where the heuristic is used.
 */
export type TokenCounter = (text: string) => Promise<number>;
let injectedCounter: TokenCounter | undefined;

/** Wire in a real token counter (e.g. VS Code `lm.countTokens`). */
export function setTokenCounter(fn: TokenCounter | undefined): void {
  injectedCounter = fn;
}

/** Whether a real token counter has been wired in. */
export function hasTokenCounter(): boolean {
  return !!injectedCounter;
}

function sessionChars(session: TokenSavingsSource): { rawChars: number; compactChars: number } {
  const { raw, compact } = sessionBlobs(session);
  return { rawChars: raw.length, compactChars: compact.length };
}

export function estimateSessionTokenSavings(session: TokenSavingsSource): TokenSavingsEstimate {
  const { rawChars, compactChars } = sessionChars(session);
  const rawTokens = estimateTokens(rawChars);
  const compactTokens = estimateTokens(compactChars);
  const ratio = compactChars > 0 ? rawTokens / Math.max(compactTokens, 1) : 1;
  return {
    measurement: 'estimated',
    baseline: session.rawText === undefined ? 'structured-proxy' : 'provided-text',
    rawChars,
    compactChars,
    rawTokens,
    compactTokens,
    tokensSaved: Math.max(0, rawTokens - compactTokens),
    compressionRatio: Math.round(ratio * 10) / 10,
  };
}

export function aggregateTokenSavings(sessions: TokenSavingsSource[]): TokenSavingsAggregate {
  const totals = sessions.reduce(
    (acc, session) => {
      const estimate = estimateSessionTokenSavings(session);
      acc.rawChars += estimate.rawChars;
      acc.compactChars += estimate.compactChars;
      acc.rawTokens += estimate.rawTokens;
      acc.compactTokens += estimate.compactTokens;
      acc.tokensSaved += estimate.tokensSaved;
      return acc;
    },
    {
      rawChars: 0,
      compactChars: 0,
      rawTokens: 0,
      compactTokens: 0,
      tokensSaved: 0,
    },
  );

  return {
    ...totals,
    sessionCount: sessions.length,
    compressionRatio:
      totals.compactTokens > 0
        ? Math.round((totals.rawTokens / Math.max(totals.compactTokens, 1)) * 10) / 10
        : 1,
  };
}

export function estimateTokenSavingsUsd(tokensSaved: number, pricePerMillionTokens = 5): number {
  return (tokensSaved * pricePerMillionTokens) / 1_000_000;
}

/** Raw + compact text blobs a session expands to / compresses into. */
function sessionBlobs(session: TokenSavingsSource): { raw: string; compact: string } {
  const compact = session.compactText ?? session.summary ?? '';
  const raw =
    session.rawText ??
    [
      session.summary ?? '',
      ...(session.keyFiles ?? []),
      ...(session.keyTopics ?? []),
      ...(session.decisions ?? []),
      ...(session.problemsSolved ?? []),
    ]
      .filter(Boolean)
      .join(' ');
  return { raw, compact };
}

/**
 * Measured variant of {@link estimateSessionTokenSavings}: uses the wired
 * {@link TokenCounter} for exact token counts when available, otherwise the
 * chars/4 heuristic. Char counts stay identical to the sync version.
 */
export async function estimateSessionTokenSavingsMeasured(
  session: TokenSavingsSource,
): Promise<TokenSavingsEstimate> {
  const { rawChars, compactChars } = sessionChars(session);
  const { raw, compact } = sessionBlobs(session);
  let measurement: 'estimated' | 'tokenized' = 'estimated';
  let rawTokens = estimateTokens(raw.length);
  let compactTokens = estimateTokens(compact.length);
  if (injectedCounter) {
    try {
      const counts = await Promise.all([injectedCounter(raw), injectedCounter(compact)]);
      if (counts.every((value) => Number.isSafeInteger(value) && value >= 0)) {
        [rawTokens, compactTokens] = counts;
        measurement = 'tokenized';
      }
    } catch {
      measurement = 'estimated';
    }
  }
  const ratio = compactChars > 0 ? rawTokens / Math.max(compactTokens, 1) : 1;
  return {
    measurement,
    baseline: session.rawText === undefined ? 'structured-proxy' : 'provided-text',
    rawChars,
    compactChars,
    rawTokens,
    compactTokens,
    tokensSaved: Math.max(0, rawTokens - compactTokens),
    compressionRatio: Math.round(ratio * 10) / 10,
  };
}

export interface TaskUsage {
  taskId: string;
  model: string;
  source: 'provider' | 'estimate';
  qualityPassed: boolean;
  inputTokens: number;
  outputTokens: number;
  auxiliaryTokens: number;
}

export function compareTaskUsage(
  baseline: TaskUsage,
  memory: TaskUsage,
): {
  savingsPercent: number | null;
  reason?: string;
} {
  if (
    typeof baseline.taskId !== 'string' ||
    !baseline.taskId.trim() ||
    typeof baseline.model !== 'string' ||
    !baseline.model.trim() ||
    baseline.taskId !== memory.taskId ||
    baseline.model !== memory.model
  ) {
    return { savingsPercent: null, reason: 'Task and model must match' };
  }
  if (baseline.source !== 'provider' || memory.source !== 'provider') {
    return { savingsPercent: null, reason: 'Provider-reported usage is required' };
  }
  if (baseline.qualityPassed !== true || memory.qualityPassed !== true) {
    return { savingsPercent: null, reason: 'Both runs must pass the same quality gate' };
  }
  const counts = [
    baseline.inputTokens,
    baseline.outputTokens,
    baseline.auxiliaryTokens,
    memory.inputTokens,
    memory.outputTokens,
    memory.auxiliaryTokens,
  ];
  if (!counts.every((value) => Number.isSafeInteger(value) && value >= 0)) {
    return { savingsPercent: null, reason: 'Usage counters must be nonnegative safe integers' };
  }
  const before = baseline.inputTokens + baseline.outputTokens + baseline.auxiliaryTokens;
  const after = memory.inputTokens + memory.outputTokens + memory.auxiliaryTokens;
  if (!Number.isSafeInteger(before) || !Number.isSafeInteger(after) || before === 0) {
    return { savingsPercent: null, reason: 'A valid nonzero baseline is required' };
  }
  return { savingsPercent: Math.round(((before - after) / before) * 10000) / 100 };
}

/** Measured variant of {@link aggregateTokenSavings}. */
export async function aggregateTokenSavingsMeasured(
  sessions: TokenSavingsSource[],
): Promise<TokenSavingsAggregate> {
  const totals = {
    rawChars: 0,
    compactChars: 0,
    rawTokens: 0,
    compactTokens: 0,
    tokensSaved: 0,
  };
  for (const session of sessions) {
    const estimate = await estimateSessionTokenSavingsMeasured(session);
    totals.rawChars += estimate.rawChars;
    totals.compactChars += estimate.compactChars;
    totals.rawTokens += estimate.rawTokens;
    totals.compactTokens += estimate.compactTokens;
    totals.tokensSaved += estimate.tokensSaved;
  }
  return {
    ...totals,
    sessionCount: sessions.length,
    compressionRatio:
      totals.compactTokens > 0
        ? Math.round((totals.rawTokens / Math.max(totals.compactTokens, 1)) * 10) / 10
        : 1,
  };
}

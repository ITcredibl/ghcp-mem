export interface TokenSavingsSource {
  summary?: string;
  keyFiles?: string[];
  keyTopics?: string[];
  decisions?: string[];
  problemsSolved?: string[];
}

export interface TokenSavingsEstimate {
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

const DEFAULT_RAW_EVENT_OVERHEAD_CHARS = 800;
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

async function countTokens(text: string): Promise<number> {
  if (injectedCounter) {
    try {
      return await injectedCounter(text);
    } catch {
      // Fall back to the heuristic if the model tokenizer is unavailable.
    }
  }
  return estimateTokens(text.length);
}

function sessionChars(session: TokenSavingsSource): { rawChars: number; compactChars: number } {
  const compactChars = (session.summary ?? '').length;
  const rawChars =
    [
      session.summary ?? '',
      ...(session.keyFiles ?? []),
      ...(session.keyTopics ?? []),
      ...(session.decisions ?? []),
      ...(session.problemsSolved ?? []),
    ].join(' ').length + DEFAULT_RAW_EVENT_OVERHEAD_CHARS;
  return { rawChars, compactChars };
}

export function estimateSessionTokenSavings(session: TokenSavingsSource): TokenSavingsEstimate {
  const { rawChars, compactChars } = sessionChars(session);
  const rawTokens = estimateTokens(rawChars);
  const compactTokens = estimateTokens(compactChars);
  const ratio = compactChars > 0 ? rawTokens / Math.max(compactTokens, 1) : 1;
  return {
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
  const compact = session.summary ?? '';
  const raw = [
    session.summary ?? '',
    ...(session.keyFiles ?? []),
    ...(session.keyTopics ?? []),
    ...(session.decisions ?? []),
    ...(session.problemsSolved ?? []),
  ].join(' ');
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
  const overheadTokens = estimateTokens(DEFAULT_RAW_EVENT_OVERHEAD_CHARS);
  const rawTokens = (await countTokens(raw)) + overheadTokens;
  const compactTokens = await countTokens(compact);
  const ratio = compactChars > 0 ? rawTokens / Math.max(compactTokens, 1) : 1;
  return {
    rawChars,
    compactChars,
    rawTokens,
    compactTokens,
    tokensSaved: Math.max(0, rawTokens - compactTokens),
    compressionRatio: Math.round(ratio * 10) / 10,
  };
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

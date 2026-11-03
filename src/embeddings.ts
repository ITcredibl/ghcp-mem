import * as vscode from 'vscode';

/**
 * Embedding helpers — optional hybrid retrieval layer.
 *
 * The VS Code `vscode.lm` embeddings API is still proposed at the time of
 * writing, so everything in this module is feature-detected and guarded with
 * try/catch. If embeddings are unavailable the rest of the extension continues
 * to work on pure keyword + recency (RRF) scoring.
 */

import type { EmbeddingFn } from './vectorMath';
export type { EmbeddingFn } from './vectorMath';

/**
 * Returns a function that produces a single-vector embedding for `text`, or
 * `undefined` if the API is not available in this VS Code build.
 */
export async function getEmbedder(): Promise<EmbeddingFn | undefined> {
  const lm = vscode.lm as any;
  if (!lm) return undefined;

  // Preferred: stable VS Code ≥1.102 API — computeEmbeddings(model, { inputs })
  if (
    typeof lm.computeEmbeddings === 'function' &&
    typeof lm.selectEmbeddingModels === 'function'
  ) {
    return async (text: string) => {
      try {
        const models: any[] = await lm.selectEmbeddingModels({});
        if (models.length > 0) {
          const res = await lm.computeEmbeddings(models[0], { inputs: [text] });
          const vec = res?.embeddings?.[0]?.values ?? res?.[0]?.values;
          if (Array.isArray(vec)) return vec;
        }
      } catch {
        /* fall through to older shape */
      }
      try {
        const res = await lm.computeEmbeddings({ inputs: [text] });
        const vec = res?.[0]?.values ?? res?.embeddings?.[0]?.values;
        return Array.isArray(vec) ? vec : undefined;
      } catch {
        return undefined;
      }
    };
  }

  // Proposed API surface (pre-1.102): vscode.lm.computeEmbeddings({ model, inputs })
  if (typeof lm.computeEmbeddings === 'function') {
    return async (text: string) => {
      try {
        const res = await lm.computeEmbeddings({ inputs: [text] });
        const vec = res?.[0]?.values ?? res?.embeddings?.[0]?.values;
        return Array.isArray(vec) ? vec : undefined;
      } catch {
        return undefined;
      }
    };
  }

  // Alternate spelling some builds exposed: vscode.lm.embeddings.compute
  if (lm.embeddings && typeof lm.embeddings.compute === 'function') {
    return async (text: string) => {
      try {
        const res = await lm.embeddings.compute({ inputs: [text] });
        const vec = res?.[0]?.values ?? res?.embeddings?.[0]?.values;
        return Array.isArray(vec) ? vec : undefined;
      } catch {
        return undefined;
      }
    };
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Pure vector math lives in `vectorMath.ts` (NO vscode import) so the
// standalone MCP server and other pure modules can use it without dragging
// the vscode module into their bundles — `node out/mcpServer.js` must start
// under plain Node. Re-exported here for extension-side convenience.
// ---------------------------------------------------------------------------
export {
  cosineSim,
  LOCAL_EMBED_DIM,
  localEmbed,
  makeLocalEmbedder,
  _resetLocalEmbedCache,
} from './vectorMath';

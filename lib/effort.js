// Picks Luna's reasoning effort per question with the Databricks `ai_decide` AI Function,
// called through its REST API (POST /api/2.0/ai-functions/ai-decide, Beta; no SQL warehouse).
// https://docs.databricks.com/api/ai-functions/v1/ai-decide
// Falls back to a fixed level if the call fails or is slow.
import { dbJson } from './auth.js';

export const EFFORT_LEVELS = ['none', 'low', 'medium', 'high', 'xhigh'];

// 'ai_decide' (default) or 'fixed' (always use the fallback level)
const STRATEGY = (process.env.RAG_EFFORT_STRATEGY || 'ai_decide').toLowerCase();
// Give up and use the fallback after this long (typical latency is ~0.5 s).
const DECIDE_TIMEOUT_MS = Math.max(1000, Number(process.env.RAG_EFFORT_TIMEOUT_MS || 8000));

export const FALLBACK_EFFORT = (() => {
  const v = (process.env.RAG_REASONING_EFFORT || 'medium').toLowerCase();
  if (EFFORT_LEVELS.includes(v)) return v;
  console.warn(`RAG_REASONING_EFFORT="${v}" is not one of ${EFFORT_LEVELS.join(', ')}; using "medium".`);
  return 'medium';
})();

// Choice labels must be exactly the effort values Luna accepts.
// Tuned so simple introductory questions (incl. "difference between X and Y") land on `low`;
// an earlier wording put two-concept comparisons under `medium`, which over-spent effort.
// Re-check against a mixed question set if you edit this (see CLAUDE.md).
const QUESTIONS = {
  effort: {
    type: 'choice',
    instructions: 'A student asked this question about their course textbook. A tutor model will answer it from retrieved textbook excerpts. '
      + 'Choose the LOWEST reasoning effort that still produces a correct, complete answer. Most introductory textbook questions '
      + '(definitions, "what is", "what is the difference between X and Y", basic explanations) are low. '
      + 'Only choose medium or higher when the answer genuinely needs connecting several ideas, calculation, or multi-step reasoning.',
    criteria: {
      none: 'Greeting, thanks, or chit-chat that needs no textbook knowledge',
      low: 'Simple, introductory question answered directly from the text: a definition, a fact, what a term means, '
        + 'or the basic difference between two related concepts (for example assets vs. liabilities, debit vs. credit)',
      medium: 'Explaining how or why several concepts relate, comparing three or more items or their effects, '
        + 'or summarizing a section or chapter',
      high: 'Multi-step problem solving with numbers: calculations, journal entries, or worked examples',
      xhigh: 'Complex multi-part analysis combining many concepts, proofs, or derivations',
    },
  },
};

const fallback = reason => ({ effort: FALLBACK_EFFORT, source: 'default', reason });

/**
 * Returns { effort, source: 'ai_decide' | 'default', confidence?, reason? }. Never throws
 * (except when the request itself is aborted), so the answer can always go ahead.
 */
export async function decideEffort(question, signal) {
  if (STRATEGY !== 'ai_decide') return fallback('fixed effort configured');
  const timeout = AbortSignal.timeout(DECIDE_TIMEOUT_MS);
  try {
    const r = await dbJson('/api/2.0/ai-functions/ai-decide', {
      method: 'POST',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      body: { state: question.slice(0, 4000), questions: QUESTIONS, options: { version: '1.0' } },
    });
    const answer = r?.response?.answers?.effort;
    if (!EFFORT_LEVELS.includes(answer?.choice)) {
      console.warn('ai_decide returned no valid choice:', JSON.stringify(r).slice(0, 300));
      return fallback('no valid choice returned');
    }
    return { effort: answer.choice, source: 'ai_decide', confidence: answer.confidence ?? null };
  } catch (err) {
    if (signal?.aborted) throw err;
    // Full detail goes to the server log; the UI only gets a short, non-sensitive reason.
    console.warn('ai_decide failed, using fallback effort:', timeout.aborted ? `timed out after ${DECIDE_TIMEOUT_MS} ms` : err.message);
    return fallback(timeout.aborted ? 'timed out' : 'request failed');
  }
}

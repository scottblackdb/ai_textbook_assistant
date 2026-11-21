// Emits `step` events that the UI's flow pane draws as a diagram of how a question was answered.
// Event: { type: 'step', node, state: 'active' | 'done' | 'error', detail?, ms? }
export function tracer(send) {
  const active = new Map(); // node -> start time

  const start = (node, detail) => {
    active.set(node, Date.now());
    send({ type: 'step', node, state: 'active', ...(detail && { detail }) });
  };
  const update = (node, detail) => {
    if (active.has(node)) send({ type: 'step', node, state: 'active', detail });
  };
  const done = (node, detail) => {
    const t = active.get(node);
    active.delete(node);
    send({ type: 'step', node, state: 'done', ...(detail && { detail }), ...(t && { ms: Date.now() - t }) });
  };
  /** Mark every step still running as failed (call before rethrowing). */
  const failActive = detail => {
    for (const node of active.keys()) send({ type: 'step', node, state: 'error', ...(detail && { detail }) });
    active.clear();
  };
  /** Run fn as a step; `describe(result)` gives the done detail. */
  const wrap = async (node, startDetail, fn, describe) => {
    start(node, startDetail);
    const result = await fn();
    done(node, describe?.(result));
    return result;
  };
  return { start, update, done, failActive, wrap };
}

export const truncate = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

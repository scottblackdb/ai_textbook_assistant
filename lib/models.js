// Answer models selectable in Lakebase (vector) mode. No heavy imports here: server.js
// reads it at startup even when the vector mode's `pg` dependency is missing.
//
// RAG_CHAT_MODELS: comma-separated "id=Label" pairs. RAG_CHAT_ENDPOINT: the default id.
// An id is either a Model Serving endpoint name (databricks-gpt-6-1-terra) or a Unity Gateway
// model service's three-part name (scott.default.textbook); see isGatewayService().
// Luna 6 goes through the Unity Gateway service scott.default.textbook (routes to
// system.ai.databricks-gpt-6-luna, with an inference table).
const DEFAULT_LIST = 'scott.default.textbook=Luna 6,databricks-gpt-6-1-terra=Terra 6.1';

/** Three-part catalog.schema.service names are Unity Gateway model services. */
export const isGatewayService = id => /^[\w-]+\.[\w-]+\.[\w-]+$/.test(id);

function parse(spec) {
  const models = [];
  for (const part of spec.split(',')) {
    const [id, ...label] = part.split('=');
    const endpoint = id?.trim();
    if (!endpoint || !/^[\w.-]+$/.test(endpoint) || models.some(m => m.id === endpoint)) continue;
    models.push({ id: endpoint, label: label.join('=').trim() || endpoint.replace(/^databricks-/, '') });
  }
  return models;
}

export const CHAT_MODELS = parse(process.env.RAG_CHAT_MODELS || DEFAULT_LIST);

export const DEFAULT_CHAT_MODEL = (() => {
  const wanted = process.env.RAG_CHAT_ENDPOINT || 'scott.default.textbook';
  if (!CHAT_MODELS.some(m => m.id === wanted)) {
    CHAT_MODELS.unshift({ id: wanted, label: wanted.replace(/^databricks-/, '') });
  }
  return wanted;
})();

/** Returns the model entry for an id, the default for a missing id, or null for an unknown one. */
export function resolveModel(id) {
  return CHAT_MODELS.find(m => m.id === (id || DEFAULT_CHAT_MODEL)) || null;
}

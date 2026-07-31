// Registry of selectable AI knowledge bases.
// Each key maps to one or more `knowledge_chunk.source` values.
// Adding a new MD: add an entry here (and seed it via scripts/seed-parasara.mjs).
export const KNOWLEDGE_SOURCES = {
  bphs: {
    label: 'Brihat Parashara Hora Sastra (Bhps)',
    sources: ['bphs_vol1', 'bphs_vol2', 'bphs_online'],
  },
};

export const getSourceFilter = (key) => {
  if (!key) return null;
  return KNOWLEDGE_SOURCES[key]?.sources ?? null;
};

export const getSourceLabel = (key) =>
  key ? KNOWLEDGE_SOURCES[key]?.label ?? null : null;

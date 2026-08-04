// Registry of selectable AI knowledge bases.
// Each key maps to one or more `knowledge_chunk.source` values.
// Adding a new MD: add an entry here (and seed it via scripts/seed-parasara.mjs).
export const KNOWLEDGE_SOURCES = {
  bphs: {
    label: 'Bhps (Brihat Parashara Hora Sastra)',
    sources: ['bphs_vol1', 'bphs_vol2'],
    instruction:
      'Bhps is the Brihat Parashara Hora Sastra by Maharshi Parashara, a verse treatise. Cite by chapter name, and reference shloka numbers where the text provides them.',
  },
  kalidas: {
    label: 'Uttara Kalamrita (Kalidasa)',
    sources: ['kalamrita'],
    instruction:
      'Uttara Kalamrita is a verse treatise by Kalidasa. Cite by Kanda (First/Second) and Chapter name, referencing shloka numbers where the text provides them.',
  },
  ratna: {
    label: 'Ratna Pradeep',
    sources: ['ratna_pradeep'],
    instruction:
      'Ratna Pradeep is a classic prose treatise on gems (ratna-shastra). Cite by Chapter name; the text is prose, so quote key passages rather than verse numbers.',
  },
  hinduPredictive: {
    label: 'Hindu Predictive Astrology',
    sources: ['hindu_predictive'],
    instruction:
      'Hindu Predictive Astrology is a classic modern treatise on Indian predictive astrology (prashna/jataka). Cite by Chapter name; the text is prose, so reference chapters and key passages rather than verse numbers.',
  },
};

export const getSourceFilter = (key) => {
  if (!key) return null;
  return KNOWLEDGE_SOURCES[key]?.sources ?? null;
};

export const getSourceLabel = (key) =>
  key ? KNOWLEDGE_SOURCES[key]?.label ?? null : null;

export const getSourceInstruction = (key) =>
  key ? KNOWLEDGE_SOURCES[key]?.instruction ?? null : null;

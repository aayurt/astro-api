// ==============================
// 1. QUERY TYPES

import { MASTER_PROMPT_TEMPLATE } from '../constants.js';

// ==============================
export const QUERY_TYPES = {
  NATAL: 'natal',
  PREDICTION: 'prediction',
  HISTORY: 'history',
  TRANSIT: 'transit',
  GENERAL: 'general',
};

// ==============================
// 2. QWEN PROMPT BUILDER
// ==============================
export function buildClassifierPrompt(question, memory) {
  let prompt = ` 
You are an intent classifier for an astrology AI system. 

Classify the question and extract time context. 

Return JSON only. 

{ 
  "type": "natal | prediction | history | transit | general", 
  "time_context": "past | present | future", 
  "time_reference": "string (default: 'now')" 
} 
`;

  if (memory && memory.length > 0) {
    prompt += `
Previous Conversation Context:
${JSON.stringify(memory, null, 2)}
`;
  }

  prompt += `
Question: 
"${question}" 
`;

  return prompt;
}

// ==============================
// 3. SAFE JSON PARSER
// ==============================
export function safeParseJSON(text, fallback = {}) {
  try {
    // Qwen might return markdown blocks or conversational text around the JSON
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    let cleanText = jsonMatch ? jsonMatch[0] : text;

    // Handle common AI JSON generation errors:
    // 1. Unescaped newlines within string values
    // We'll replace real newlines with \n inside the string values
    cleanText = cleanText.replace(/: "([\s\S]*?)"/g, (match, content) => {
      const escapedContent = content.replace(/\n/g, '\\n');
      return `: "${escapedContent}"`;
    });

    return JSON.parse(cleanText);
  } catch (e) {
    console.error('JSON Parse Error:', e.message);
    return fallback;
  }
}

// ==============================
// 4. TIME RESOLVER
// ==============================
export function resolveTimeReference(ref) {
  if (!ref || ref === 'now' || ref === 'present') return null;

  const now = new Date();

  // year (e.g. "2022")
  if (/^\d{4}$/.test(ref)) {
    return {
      start: new Date(`${ref}-01-01`),
      end: new Date(`${ref}-12-31`),
    };
  }

  if (ref === 'last_year') {
    const year = now.getFullYear() - 1;
    return {
      start: new Date(`${year}-01-01`),
      end: new Date(`${year}-12-31`),
    };
  }

  if (ref === 'next_year') {
    const year = now.getFullYear() + 1;
    return {
      start: new Date(`${year}-01-01`),
      end: new Date(`${year}-12-31`),
    };
  }

  if (ref === 'recent_past') {
    const end = now;
    const start = new Date();
    start.setMonth(start.getMonth() - 6);
    return { start, end };
  }

  if (ref === 'next_6_months') {
    const start = now;
    const end = new Date();
    end.setMonth(end.getMonth() + 6);
    return { start, end };
  }

  return null;
}

// ==============================
// 5. DASHA MAPPER
// ==============================
export function findDashaForDateRange(vimsottari, range) {
  if (!vimsottari) return null;

  // If no range is provided, return the current active dasha
  if (!range) {
    return {
      maha_dasha: vimsottari.activeMahaDasha?.dasha || null,
      antar_dasha: vimsottari.activeAntarDasha?.dasha || null,
      is_current: true,
    };
  }

  // If we have a range, try to find the dasha for that period
  // We need to look through all dashas, not just the active one
  const allDashas = vimsottari.allDashas || [];

  for (const maha of allDashas) {
    const mahaStart = new Date(maha.start_date);
    const mahaEnd = new Date(maha.end_date);

    if (range.start <= mahaEnd && range.end >= mahaStart) {
      // Find the specific antardasha within this maha dasha
      for (const antar of maha.antar_dashas || []) {
        const antarStart = new Date(antar.start_date);
        const antarEnd = new Date(antar.end_date);

        if (range.start <= antarEnd && range.end >= antarStart) {
          return {
            maha_dasha: maha.dasha,
            antar_dasha: antar.dasha,
            start: antar.start_date,
            end: antar.end_date,
          };
        }
      }
    }
  }

  // Fallback to active dasha if nothing found for the range
  return {
    maha_dasha: vimsottari.activeMahaDasha?.dasha || null,
    antar_dasha: vimsottari.activeAntarDasha?.dasha || null,
  };
}

// ==============================
// 6. TIME → DASHA PIPELINE
// ==============================
export function mapTimeToDasha(rawData, classification) {
  const range = resolveTimeReference(classification.time_reference);

  const dasha = findDashaForDateRange(rawData.vimsottari, range);

  return {
    ...classification,
    dasha_context: dasha,
  };
}

// ==============================
// 7. PAYLOAD BUILDERS
// ==============================
export function buildNatalPayload(data, dashaContext) {
  const getPlanetInfo = (p) => ({
    sign: p?.zodiac_sign_name,
    house: p?.house_number,
  });

  return {
    natal: {
      ascendant: getPlanetInfo(data.natal?.Ascendant),
      sun: getPlanetInfo(data.natal?.Sun),
      moon: getPlanetInfo(data.natal?.Moon),
      mars: getPlanetInfo(data.natal?.Mars),
      mercury: getPlanetInfo(data.natal?.Mercury),
      jupiter: getPlanetInfo(data.natal?.Jupiter),
      venus: getPlanetInfo(data.natal?.Venus),
      saturn: getPlanetInfo(data.natal?.Saturn),
      rahu: getPlanetInfo(data.natal?.Rahu),
      ketu: getPlanetInfo(data.natal?.Ketu),
    },
    dashatimings: dashaContext,
  };
}

export function buildHistoryPayload(data, dashaContext) {
  const getPlanetInfo = (p) => ({
    sign: p?.zodiac_sign_name,
    house: p?.house_number,
  });

  return {
    natal: {
      ascendant: getPlanetInfo(data.natal?.Ascendant),
      sun: getPlanetInfo(data.natal?.Sun),
      moon: getPlanetInfo(data.natal?.Moon),
      mars: getPlanetInfo(data.natal?.Mars),
      mercury: getPlanetInfo(data.natal?.Mercury),
      jupiter: getPlanetInfo(data.natal?.Jupiter),
      venus: getPlanetInfo(data.natal?.Venus),
      saturn: getPlanetInfo(data.natal?.Saturn),
      rahu: getPlanetInfo(data.natal?.Rahu),
      ketu: getPlanetInfo(data.natal?.Ketu),
    },
    dashatimings: dashaContext,
  };
}

export function buildPredictionPayload(data, dashaContext, classification) {
  const isFuture = classification?.time_context === 'future';
  const getPlanetInfo = (p) => ({
    sign: p?.zodiac_sign_name,
    house: p?.house_number,
  });

  return {
    natal: {
      ascendant: getPlanetInfo(data.natal?.Ascendant),
      sun: getPlanetInfo(data.natal?.Sun),
      moon: getPlanetInfo(data.natal?.Moon),
      mars: getPlanetInfo(data.natal?.Mars),
      mercury: getPlanetInfo(data.natal?.Mercury),
      jupiter: getPlanetInfo(data.natal?.Jupiter),
      venus: getPlanetInfo(data.natal?.Venus),
      saturn: getPlanetInfo(data.natal?.Saturn),
      rahu: getPlanetInfo(data.natal?.Rahu),
      ketu: getPlanetInfo(data.natal?.Ketu),
    },
    dashatimings: dashaContext,
    ...(isFuture
      ? {}
      : {
          transit: {
            sun: getPlanetInfo(data.transit?.Sun),
            moon: getPlanetInfo(data.transit?.Moon),
            saturn: getPlanetInfo(data.transit?.Saturn),
            jupiter: getPlanetInfo(data.transit?.Jupiter),
            rahu: getPlanetInfo(data.transit?.Rahu),
            ketu: getPlanetInfo(data.transit?.Ketu),
          },
        }),
  };
}

export function buildTransitPayload(data, dashaContext) {
  const getPlanetInfo = (p) => ({
    sign: p?.zodiac_sign_name,
    house: p?.house_number,
  });

  return {
    transit: {
      sun: getPlanetInfo(data.transit?.Sun),
      moon: getPlanetInfo(data.transit?.Moon),
      mars: getPlanetInfo(data.transit?.Mars),
      mercury: getPlanetInfo(data.transit?.Mercury),
      jupiter: getPlanetInfo(data.transit?.Jupiter),
      venus: getPlanetInfo(data.transit?.Venus),
      saturn: getPlanetInfo(data.transit?.Saturn),
      rahu: getPlanetInfo(data.transit?.Rahu),
      ketu: getPlanetInfo(data.transit?.Ketu),
    },
    dashatimings: dashaContext,
  };
}

// ==============================
// 8. ROUTER
// ==============================
export function buildAgentPayload(rawData, classification) {
  const enriched = mapTimeToDasha(rawData, classification);

  switch (classification.type) {
    case QUERY_TYPES.HISTORY:
      return buildHistoryPayload(rawData, enriched.dasha_context);

    case QUERY_TYPES.PREDICTION:
      return buildPredictionPayload(
        rawData,
        enriched.dasha_context,
        classification,
      );

    case QUERY_TYPES.NATAL:
      return buildNatalPayload(rawData, enriched.dasha_context);

    case QUERY_TYPES.TRANSIT:
      return buildTransitPayload(rawData, enriched.dasha_context);

    default:
      return buildNatalPayload(rawData, enriched.dasha_context);
  }
}

// ==============================
// 9. MAIN PIPELINE
// ==============================
export async function processUserQuery({
  question,
  rawData,
  callQwen,
  memory,
}) {
  const prompt = buildClassifierPrompt(question, memory);
  console.log('Classifier Prompt built successfully');
  console.log('Sending prompt to Qwen...');
  const response = await callQwen(prompt);
  console.log('Qwen response received successfully');

  const classification = safeParseJSON(response, {
    type: QUERY_TYPES.GENERAL,
    time_context: 'present',
    time_reference: 'now',
  });
  console.log('Classification parsed successfully');
  console.log('Building Payload...');
  console.log('raw', rawData);
  const payload = buildAgentPayload(rawData, classification);
  console.log('Payload built successfully');
  console.log({ payload });
  return {
    classification,
    payload,
  };
}

export async function buildMasterPrompt({ classification, payload, memory }) {
  const focusHint = {
    prediction: 'Focus on future trends and likely outcomes.',
    history: 'Focus on explaining past causes and patterns.',
    natal: 'Focus on personality traits only.',
    transit: 'Focus on current influences.',
  };

  const focus = focusHint[classification.type] || '';

  let prompt = MASTER_PROMPT_TEMPLATE.replace(
    '{{classification}}',
    JSON.stringify(classification, null, 2),
  ).replace('{{payload}}', JSON.stringify(payload, null, 2));

  if (focus) {
    prompt += `\n\nADDITIONAL FOCUS:\n${focus}`;
  }

  if (memory && memory.length > 0) {
    prompt += `\n\nPrevious Context:\n${JSON.stringify(memory, null, 2)}`;
  } else {
    prompt += `\n\nPrevious Context:\nNone`;
  }

  return prompt;
}

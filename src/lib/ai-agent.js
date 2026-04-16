// ==============================
// 1. QUERY TYPES

import {
  MASTER_PROMPT_TEMPLATE,
  MASTER_PROMPT_TEMPLATE_GEMINI,
  MASTER_PROMPT_TEMPLATE_UPDATED,
  MASTER_PROMPT_TEMPLATE_HTML,
  MASTER_PROMPT_TEMPLATE_SOULFUL_HTML,
} from '../constants.js';

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

function getHouseFromAscendant(planetSign, ascSign) {
  const zodiac = [
    'Aries',
    'Taurus',
    'Gemini',
    'Cancer',
    'Leo',
    'Virgo',
    'Libra',
    'Scorpio',
    'Sagittarius',
    'Capricorn',
    'Aquarius',
    'Pisces',
  ];

  const ascIndex = zodiac.indexOf(ascSign);
  const planetIndex = zodiac.indexOf(planetSign);

  let house = ((planetIndex - ascIndex + 12) % 12) + 1;

  return house;
}

export async function buildMasterPromptV2({ question, memory, rawData }) {
  console.log('🚀 Building Master Prompt V2...');
  const classifierInstructions = {
    type: 'general',
    time_context: 'past present future',
  };
  console.log('✅ Classifier instructions prepared');

  // For V2, we provide a full payload so the AI can classify and answer in one go
  const getPlanetInfo = (p) => ({
    sign: p?.zodiac_sign_name,
    house: p?.house_number,
  });

  const dashaContext = findDashaForDateRange(rawData.vimsottari, null);
  const ascSign = rawData.natal?.Ascendant?.zodiac_sign_name;

  const myTransit = {
    ascendant: {
      ...getPlanetInfo(rawData.natal?.Ascendant),
      house: getHouseFromAscendant(
        rawData.natal?.Ascendant?.zodiac_sign_name,
        ascSign,
      ),
    },
    sun: {
      ...getPlanetInfo(rawData.transit?.Sun),
      house: getHouseFromAscendant(
        rawData.transit?.Sun?.zodiac_sign_name,
        ascSign,
      ),
    },
    moon: {
      ...getPlanetInfo(rawData.transit?.Moon),
      house: getHouseFromAscendant(
        rawData.transit?.Moon?.zodiac_sign_name,
        ascSign,
      ),
    },
    // repeat for all planets...
    mars: {
      ...getPlanetInfo(rawData.transit?.Mars),
      house: getHouseFromAscendant(
        rawData.transit?.Mars?.zodiac_sign_name,
        ascSign,
      ),
    },
    mercury: {
      ...getPlanetInfo(rawData.transit?.Mercury),
      house: getHouseFromAscendant(
        rawData.transit?.Mercury?.zodiac_sign_name,
        ascSign,
      ),
    },
    jupiter: {
      ...getPlanetInfo(rawData.transit?.Jupiter),
      house: getHouseFromAscendant(
        rawData.transit?.Jupiter?.zodiac_sign_name,
        ascSign,
      ),
    },
    venus: {
      ...getPlanetInfo(rawData.transit?.Venus),
      house: getHouseFromAscendant(
        rawData.transit?.Venus?.zodiac_sign_name,
        ascSign,
      ),
    },
    saturn: {
      ...getPlanetInfo(rawData.transit?.Saturn),
      house: getHouseFromAscendant(
        rawData.transit?.Saturn?.zodiac_sign_name,
        ascSign,
      ),
    },
    rahu: {
      ...getPlanetInfo(rawData.transit?.Rahu),
      house: getHouseFromAscendant(
        rawData.transit?.Rahu?.zodiac_sign_name,
        ascSign,
      ),
    },
    ketu: {
      ...getPlanetInfo(rawData.transit?.Ketu),
      house: getHouseFromAscendant(
        rawData.transit?.Ketu?.zodiac_sign_name,
        ascSign,
      ),
    },
  };
  const activeYoginiDasha = rawData.yogini?.activeYogini?.dasha;
  const allYoginiDashas = rawData.yogini?.allDashas || [];
  const currentIndex = allYoginiDashas.findIndex(
    (d) => d.dasha === activeYoginiDasha,
  );
  const filteredYoginiDashas =
    currentIndex !== -1
      ? allYoginiDashas.slice(0, currentIndex + 6)
      : allYoginiDashas.slice(0, 6);

  const fullPayload = {
    natal: {
      ascendant: getPlanetInfo(rawData.natal?.Ascendant),
      sun: getPlanetInfo(rawData.natal?.Sun),
      moon: getPlanetInfo(rawData.natal?.Moon),
      mars: getPlanetInfo(rawData.natal?.Mars),
      mercury: getPlanetInfo(rawData.natal?.Mercury),
      jupiter: getPlanetInfo(rawData.natal?.Jupiter),
      venus: getPlanetInfo(rawData.natal?.Venus),
      saturn: getPlanetInfo(rawData.natal?.Saturn),
      rahu: getPlanetInfo(rawData.natal?.Rahu),
      ketu: getPlanetInfo(rawData.natal?.Ketu),
    },
    transit: {
      sun: getPlanetInfo(rawData.transit?.Sun),
      moon: getPlanetInfo(rawData.transit?.Moon),
      mars: getPlanetInfo(rawData.transit?.Mars),
      mercury: getPlanetInfo(rawData.transit?.Mercury),
      jupiter: getPlanetInfo(rawData.transit?.Jupiter),
      venus: getPlanetInfo(rawData.transit?.Venus),
      saturn: getPlanetInfo(rawData.transit?.Saturn),
      rahu: getPlanetInfo(rawData.transit?.Rahu),
      ketu: getPlanetInfo(rawData.transit?.Ketu),
      ascendant: getPlanetInfo(rawData.transit?.Ascendant),
    },
    myTransit,
    dashatimings: dashaContext,
    yoginiDasha: {
      activeYogini: activeYoginiDasha,
      activeYoginiAntar: rawData.yogini?.activeYoginiAntar?.dasha,
      activeYoginiStart: rawData.yogini?.activeYogini?.startDate,
      activeYoginiEnd: rawData.yogini?.activeYogini?.endDate,
      activeYoginiAntarStart: rawData.yogini?.activeYoginiAntar?.startDate,
      activeYoginiAntarEnd: rawData.yogini?.activeYoginiAntar?.endDate,
    },
  };
  console.log('📦 Full payload for V2 constructed');

  let prompt = MASTER_PROMPT_TEMPLATE_GEMINI.replace(
    '{{classification}}',
    JSON.stringify(classifierInstructions, null, 2),
  ).replace('{{payload}}', JSON.stringify(fullPayload, null, 2));

  if (memory && memory.length > 0) {
    prompt += `\n\nPrevious Context:\n${JSON.stringify(memory, null, 2)}`;
  } else {
    prompt += `\n\nPrevious Context:\nNone`;
  }

  prompt += `\n\nQuestion: "${question}"`;

  console.log('✨ Master Prompt V2 build complete');
  return prompt;
}

export async function buildMasterPromptV4({ question, memory, rawData }) {
  console.log('🚀 Building Master Prompt V4 (Enriched Data)...');

  // Helper for detailed planet info
  const getPlanetInfo = (p) => ({
    sign: p?.zodiac_sign_name,
    house: p?.house_number,
    degree: p?.normDegree ? Number(p.normDegree % 30).toFixed(2) : null,
    nakshatra: p?.nakshatra_name,
    nakshatraLord: p?.nakshatra_vimsottari_lord,
    isRetrograde: p?.isRetro === 'true' || p?.isRetro === true,
  });

  const dashaContext = findDashaForDateRange(rawData.vimsottari, null);
  const ascSign = rawData.natal?.Ascendant?.zodiac_sign_name;

  // Pre-calculate planetary aspects or interactions for V4
  const myTransit = {
    ascendant: {
      ...getPlanetInfo(rawData.natal?.Ascendant),
      house: getHouseFromAscendant(
        rawData.natal?.Ascendant?.zodiac_sign_name,
        ascSign,
      ),
    },
    sun: {
      ...getPlanetInfo(rawData.transit?.Sun),
      house: getHouseFromAscendant(
        rawData.transit?.Sun?.zodiac_sign_name,
        ascSign,
      ),
    },
    moon: {
      ...getPlanetInfo(rawData.transit?.Moon),
      house: getHouseFromAscendant(
        rawData.transit?.Moon?.zodiac_sign_name,
        ascSign,
      ),
    },
    mars: {
      ...getPlanetInfo(rawData.transit?.Mars),
      house: getHouseFromAscendant(
        rawData.transit?.Mars?.zodiac_sign_name,
        ascSign,
      ),
    },
    mercury: {
      ...getPlanetInfo(rawData.transit?.Mercury),
      house: getHouseFromAscendant(
        rawData.transit?.Mercury?.zodiac_sign_name,
        ascSign,
      ),
    },
    jupiter: {
      ...getPlanetInfo(rawData.transit?.Jupiter),
      house: getHouseFromAscendant(
        rawData.transit?.Jupiter?.zodiac_sign_name,
        ascSign,
      ),
    },
    venus: {
      ...getPlanetInfo(rawData.transit?.Venus),
      house: getHouseFromAscendant(
        rawData.transit?.Venus?.zodiac_sign_name,
        ascSign,
      ),
    },
    saturn: {
      ...getPlanetInfo(rawData.transit?.Saturn),
      house: getHouseFromAscendant(
        rawData.transit?.Saturn?.zodiac_sign_name,
        ascSign,
      ),
    },
    rahu: {
      ...getPlanetInfo(rawData.transit?.Rahu),
      house: getHouseFromAscendant(
        rawData.transit?.Rahu?.zodiac_sign_name,
        ascSign,
      ),
    },
    ketu: {
      ...getPlanetInfo(rawData.transit?.Ketu),
      house: getHouseFromAscendant(
        rawData.transit?.Ketu?.zodiac_sign_name,
        ascSign,
      ),
    },
  };

  const now = new Date();
  const allYoginiDashas = rawData.yogini?.allDashas || [];

  // Find active Yogini Maha Dasha based on current time
  const currentMahaDashaObj = allYoginiDashas.find((yd) => {
    const start = new Date(yd.startDate);
    const end = new Date(yd.endDate);
    return now >= start && now <= end;
  });

  const activeYoginiDasha = currentMahaDashaObj?.name;

  // Find active Yogini Antar Dasha based on current time
  let activeYoginiAntarObj = null;
  if (currentMahaDashaObj && currentMahaDashaObj.antardashas) {
    activeYoginiAntarObj = currentMahaDashaObj.antardashas.find((ad) => {
      const start = new Date(ad.startDate);
      const end = new Date(ad.endDate);
      return now >= start && now <= end;
    });
  }
  const activeYoginiAntarDasha = activeYoginiAntarObj?.name;

  console.log(
    'Calculated Active Yogini:',
    activeYoginiDasha,
    '/',
    activeYoginiAntarDasha,
  );

  const currentIndex = allYoginiDashas.findIndex(
    (d) => d.dasha === activeYoginiDasha,
  );
  const filteredYoginiDashas =
    currentIndex !== -1
      ? allYoginiDashas.slice(0, currentIndex + 6)
      : allYoginiDashas.slice(0, 6);

  const fullPayload = {
    natal: {
      ascendant: getPlanetInfo(rawData.natal?.Ascendant),
      sun: getPlanetInfo(rawData.natal?.Sun),
      moon: getPlanetInfo(rawData.natal?.Moon),
      mars: getPlanetInfo(rawData.natal?.Mars),
      mercury: getPlanetInfo(rawData.natal?.Mercury),
      jupiter: getPlanetInfo(rawData.natal?.Jupiter),
      venus: getPlanetInfo(rawData.natal?.Venus),
      saturn: getPlanetInfo(rawData.natal?.Saturn),
      rahu: getPlanetInfo(rawData.natal?.Rahu),
      ketu: getPlanetInfo(rawData.natal?.Ketu),
    },
    transit: {
      sun: getPlanetInfo(rawData.transit?.Sun),
      moon: getPlanetInfo(rawData.transit?.Moon),
      mars: getPlanetInfo(rawData.transit?.Mars),
      mercury: getPlanetInfo(rawData.transit?.Mercury),
      jupiter: getPlanetInfo(rawData.transit?.Jupiter),
      venus: getPlanetInfo(rawData.transit?.Venus),
      saturn: getPlanetInfo(rawData.transit?.Saturn),
      rahu: getPlanetInfo(rawData.transit?.Rahu),
      ketu: getPlanetInfo(rawData.transit?.Ketu),
      ascendant: getPlanetInfo(rawData.transit?.Ascendant),
    },
    myTransit,
    dashatimings: dashaContext,
    yoginiDasha: {
      activeYogini: activeYoginiDasha,
      activeYoginiAntar: activeYoginiAntarDasha,
      activeYoginiStart: currentMahaDashaObj?.startDate,
      activeYoginiEnd: currentMahaDashaObj?.endDate,
      activeYoginiAntarStart: activeYoginiAntarObj?.startDate,
      activeYoginiAntarEnd: activeYoginiAntarObj?.endDate,
      allYoginiDashas: filteredYoginiDashas,
    },
    aiPersona: rawData.aiPersona,
  };

  console.log('📦 Full payload for V4 constructed');

  const detailedKeywords = [
    'detail',
    'explain more',
    'elaborate',
    'comprehensive',
    'deep dive',
    'thorough',
  ];
  const isDetailed = detailedKeywords.some((kw) =>
    question.toLowerCase().includes(kw),
  );
  const lengthHint = isDetailed
    ? 'This is a detailed request. Provide approximately 120 words per paragraph, with a total word count around 500 words.'
    : 'This is a standard request. Provide a concise but soulful reading with approximately 40 words per paragraph.';

  let prompt = MASTER_PROMPT_TEMPLATE_GEMINI.replace(
    '{{payload}}',
    JSON.stringify(fullPayload, null, 2),
  ).replace('{{lengthHint}}', lengthHint);

  if (memory && memory.length > 0) {
    prompt += `\n\nPrevious Context:\n${JSON.stringify(memory, null, 2)}`;
  } else {
    prompt += `\n\nPrevious Context:\nNone`;
  }

  prompt += `\n\nQuestion: "${question}"`;

  console.log('✨ Master Prompt V4 build complete');
  return prompt;
}

export async function buildMasterPromptV5({ question, memory, rawData }) {
  console.log('🚀 Building Master Prompt V5 (HTML Output)...');

  // Reuse the logic from V4 for consistent enriched data
  const getPlanetInfo = (p) => ({
    sign: p?.zodiac_sign_name,
    house: p?.house_number,
    degree: p?.normDegree ? Number(p.normDegree % 30).toFixed(2) : null,
    nakshatra: p?.nakshatra_name,
    nakshatraLord: p?.nakshatra_vimsottari_lord,
    isRetrograde: p?.isRetro === 'true' || p?.isRetro === true,
  });

  const dashaContext = findDashaForDateRange(rawData.vimsottari, null);
  // const ascSign = rawData.natal?.Ascendant?.zodiac_sign_name;

  // const myTransit = {
  //   ascendant: {
  //     ...getPlanetInfo(rawData.natal?.Ascendant),
  //     house: getHouseFromAscendant(
  //       rawData.natal?.Ascendant?.zodiac_sign_name,
  //       ascSign,
  //     ),
  //   },
  //   sun: {
  //     ...getPlanetInfo(rawData.transit?.Sun),
  //     house: getHouseFromAscendant(
  //       rawData.transit?.Sun?.zodiac_sign_name,
  //       ascSign,
  //     ),
  //   },
  //   moon: {
  //     ...getPlanetInfo(rawData.transit?.Moon),
  //     house: getHouseFromAscendant(
  //       rawData.transit?.Moon?.zodiac_sign_name,
  //       ascSign,
  //     ),
  //   },
  //   mars: {
  //     ...getPlanetInfo(rawData.transit?.Mars),
  //     house: getHouseFromAscendant(
  //       rawData.transit?.Mars?.zodiac_sign_name,
  //       ascSign,
  //     ),
  //   },
  //   mercury: {
  //     ...getPlanetInfo(rawData.transit?.Mercury),
  //     house: getHouseFromAscendant(
  //       rawData.transit?.Mercury?.zodiac_sign_name,
  //       ascSign,
  //     ),
  //   },
  //   jupiter: {
  //     ...getPlanetInfo(rawData.transit?.Jupiter),
  //     house: getHouseFromAscendant(
  //       rawData.transit?.Jupiter?.zodiac_sign_name,
  //       ascSign,
  //     ),
  //   },
  //   venus: {
  //     ...getPlanetInfo(rawData.transit?.Venus),
  //     house: getHouseFromAscendant(
  //       rawData.transit?.Venus?.zodiac_sign_name,
  //       ascSign,
  //     ),
  //   },
  //   saturn: {
  //     ...getPlanetInfo(rawData.transit?.Saturn),
  //     house: getHouseFromAscendant(
  //       rawData.transit?.Saturn?.zodiac_sign_name,
  //       ascSign,
  //     ),
  //   },
  //   rahu: {
  //     ...getPlanetInfo(rawData.transit?.Rahu),
  //     house: getHouseFromAscendant(
  //       rawData.transit?.Rahu?.zodiac_sign_name,
  //       ascSign,
  //     ),
  //   },
  //   ketu: {
  //     ...getPlanetInfo(rawData.transit?.Ketu),
  //     house: getHouseFromAscendant(
  //       rawData.transit?.Ketu?.zodiac_sign_name,
  //       ascSign,
  //     ),
  //   },
  // };

  const now = new Date();
  const allYoginiDashas = rawData.yogini?.allDashas || [];

  const currentMahaDashaObj = allYoginiDashas.find((yd) => {
    const start = new Date(yd.startDate);
    const end = new Date(yd.endDate);
    return now >= start && now <= end;
  });

  const activeYoginiDasha = currentMahaDashaObj?.name;
  const currentIndex = allYoginiDashas.findIndex(
    (d) => d.dasha === activeYoginiDasha,
  );
  const filteredYoginiDashas =
    currentIndex !== -1
      ? allYoginiDashas.slice(0, currentIndex + 6)
      : allYoginiDashas.slice(0, 8);

  let activeYoginiAntarObj = null;
  if (currentMahaDashaObj && currentMahaDashaObj.antardashas) {
    activeYoginiAntarObj = currentMahaDashaObj.antardashas.find((ad) => {
      const start = new Date(ad.startDate);
      const end = new Date(ad.endDate);
      return now >= start && now <= end;
    });
  }
  const activeYoginiAntarDasha = activeYoginiAntarObj?.name;

  const allVimsottariDashas = rawData.vimsottari?.allDashas || [];
  const vimsottariBirthDate = allVimsottariDashas[0]?.start_date
    ? new Date(allVimsottariDashas[0].start_date)
    : null;
  const vimsottariCutoff = vimsottariBirthDate
    ? new Date(
      vimsottariBirthDate.getFullYear() + 20,
      vimsottariBirthDate.getMonth(),
      vimsottariBirthDate.getDate(),
    )
    : null;

  const filteredVimsottari = {
    ...rawData.vimsottari,
    allDashas: vimsottariCutoff
      ? allVimsottariDashas.filter(
        (d) => new Date(d.start_date) < vimsottariCutoff,
      )
      : allVimsottariDashas,
  };

  const fullPayload = {
    natal: {
      ascendant: getPlanetInfo(rawData.natal?.Ascendant),
      sun: getPlanetInfo(rawData.natal?.Sun),
      moon: getPlanetInfo(rawData.natal?.Moon),
      mars: getPlanetInfo(rawData.natal?.Mars),
      mercury: getPlanetInfo(rawData.natal?.Mercury),
      jupiter: getPlanetInfo(rawData.natal?.Jupiter),
      venus: getPlanetInfo(rawData.natal?.Venus),
      saturn: getPlanetInfo(rawData.natal?.Saturn),
      rahu: getPlanetInfo(rawData.natal?.Rahu),
      ketu: getPlanetInfo(rawData.natal?.Ketu),
    },
    transit: {
      datetime: now.toISOString(),
      data: {
        sun: getPlanetInfo(rawData.transit?.Sun),
        moon: getPlanetInfo(rawData.transit?.Moon),
        mars: getPlanetInfo(rawData.transit?.Mars),
        mercury: getPlanetInfo(rawData.transit?.Mercury),
        jupiter: getPlanetInfo(rawData.transit?.Jupiter),
        venus: getPlanetInfo(rawData.transit?.Venus),
        saturn: getPlanetInfo(rawData.transit?.Saturn),
        rahu: getPlanetInfo(rawData.transit?.Rahu),
        ketu: getPlanetInfo(rawData.transit?.Ketu),
        ascendant: getPlanetInfo(rawData.transit?.Ascendant),
      }
    },
    // myCurrentTransit: {
    //   datetime: now.toISOString(),
    //   data: myTransit,
    // },
    vimsottariDasha: {
      activeVimsottari: dashaContext,
      allVimsottari: filteredVimsottari,
    },
    yoginiDasha: {
      activeYogini: activeYoginiDasha,
      activeYoginiAntar: activeYoginiAntarDasha,
      activeYoginiStart: currentMahaDashaObj?.startDate,
      activeYoginiEnd: currentMahaDashaObj?.endDate,
      activeYoginiAntarStart: activeYoginiAntarObj?.startDate,
      activeYoginiAntarEnd: activeYoginiAntarObj?.endDate,
      allYoginiDashas: filteredYoginiDashas,
    },
    // aiPersona: rawData.aiPersona,
  };
  console.log({ natal: fullPayload.natal })
  // Replace placeholders in MASTER_PROMPT_TEMPLATE_HTML
  let prompt = MASTER_PROMPT_TEMPLATE_SOULFUL_HTML.replace(
    '{{payload}}',
    JSON.stringify(fullPayload, null, 2),
  ).replace('{{user_query}}', question);
  // Add memory context if present
  if (memory && memory.length > 0) {
    prompt += `\n\nPrevious Conversation History:\n${memory}`;
  }
  // const oneLine = prompt
  //   .replace(/\s+/g, ' ')   // collapse whitespace
  //   .trim();

  console.log('✨ Master Prompt V5 build complete');
  return prompt;
}

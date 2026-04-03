import SwissEph from 'swisseph-wasm';

export async function getPlanetsForDate(date) {
  const swe = new SwissEph();
  await swe.initSwissEph();

  // 1. Calculate Julian Day
  const jd = swe.julday(
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDate(),
    date.getUTCHours() + date.getUTCMinutes() / 60,
  );

  // 2. SET SIDEREAL MODE (Matches your provided data)
  // Using Lahiri Ayanamsa (Standard for Vedic/Sidereal)
  swe.set_sid_mode(swe.SE_SIDM_LAHIRI);
  const flags = swe.SEFLG_SWIEPH | swe.SEFLG_SIDEREAL;

  const planetIds = {
    Sun: swe.SE_SUN,
    Moon: swe.SE_MOON,
    Mars: swe.SE_MARS,
    Jupiter: swe.SE_JUPITER,
    Saturn: swe.SE_SATURN,
    Rahu: swe.SE_MEAN_NODE,
    Mercury: swe.SE_MERCURY,
    Venus: swe.SE_VENUS,
    Ketu: swe.SE_MEAN_NODE, // Ketu is always 180 degrees from Rahu
  };

  const zodiacSigns = [
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

  const results = {};
  for (const [name, id] of Object.entries(planetIds)) {
    const pos = swe.calc_ut(jd, id, flags);
    let longitude = pos[0];

    if (name === 'Ketu') {
      longitude = (longitude + 180) % 360;
    }

    const signIndex = Math.floor(longitude / 30);

    results[name] = {
      name: name,
      fullDegree: longitude,
      normDegree: longitude % 30,
      zodiac_sign_name: zodiacSigns[signIndex],
      sign_number: signIndex + 1,
      isRetro: pos[3] < 0 ? 'true' : 'false',
      // Adding these for compatibility with the user's snippet and potential frontend needs
      degree_in_sign: (longitude % 30).toFixed(2),
      isRetrograde: pos[3] < 0,
    };
  }

  swe.close();
  return results;
}

export async function getYoginiDasha(date) {
  const swe = new SwissEph();
  await swe.initSwissEph();

  const jd = swe.julday(
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDate(),
    date.getUTCHours() + date.getUTCMinutes() / 60,
  );

  swe.set_sid_mode(swe.SE_SIDM_LAHIRI);
  const flags = swe.SEFLG_SWIEPH | swe.SEFLG_SIDEREAL;

  const pos = swe.calc_ut(jd, swe.SE_MOON, flags);
  const moonLong = pos[0];

  const nakshatraSpan = 13 + 1 / 3; // 13.3333 degrees
  const nakshatraIndex = Math.floor(moonLong / nakshatraSpan) + 1;
  const moonPosInNak = moonLong % nakshatraSpan;

  const yoginis = [
    { name: 'Sankata', period: 8, planet: 'Rahu' },
    { name: 'Mangala', period: 1, planet: 'Moon' },
    { name: 'Pingala', period: 2, planet: 'Sun' },
    { name: 'Dhanya', period: 3, planet: 'Jupiter' },
    { name: 'Bhramari', period: 4, planet: 'Mars' },
    { name: 'Bhadrika', period: 5, planet: 'Mercury' },
    { name: 'Ulka', period: 6, planet: 'Saturn' },
    { name: 'Siddha', period: 7, planet: 'Venus' },
  ];

  // Formula: (Nakshatra + 3) % 8
  const startingYoginiIdx = (nakshatraIndex + 3) % 8;
  const startingYogini = yoginis[startingYoginiIdx];

  // Calculate balance
  const remainingSpan = nakshatraSpan - moonPosInNak;
  const balanceYears = (remainingSpan / nakshatraSpan) * startingYogini.period;

  const totalCycleYears = 36;

  // Function to calculate antardashas for a given yogini period
  const calculateAntardashas = (
    mainYogini,
    mainStart,
    mainEnd,
    isBalance = false,
  ) => {
    const mainDurationMs =
      new Date(mainEnd).getTime() - new Date(mainStart).getTime();
    const antardashas = [];
    let currentAntarStart = new Date(mainStart);

    // Antardasha order starts from the main yogini itself
    const mainIdx = yoginis.findIndex((y) => y.name === mainYogini.name);

    for (let i = 0; i < 8; i++) {
      const antarYogini = yoginis[(mainIdx + i) % 8];
      const weight = antarYogini.period / totalCycleYears;
      const durationMs = mainDurationMs * weight;

      const antarEnd = new Date(currentAntarStart.getTime() + durationMs);

      antardashas.push({
        name: antarYogini.name,
        planet: antarYogini.planet,
        startDate: currentAntarStart.toISOString(),
        endDate: antarEnd.toISOString(),
      });

      currentAntarStart = antarEnd;
    }
    return antardashas;
  };

  // Generate full cycle (3 cycles total to cover ~108 years)
  const results = [];
  let currentDate = new Date(date);

  // First dasha (balance)
  const firstEndDate = new Date(currentDate);
  const balanceYearsInt = Math.floor(balanceYears);
  const balanceDays = (balanceYears % 1) * 365.25;
  firstEndDate.setFullYear(firstEndDate.getFullYear() + balanceYearsInt);
  firstEndDate.setDate(firstEndDate.getDate() + Math.round(balanceDays));

  const mainBalance = {
    name: startingYogini.name,
    planet: startingYogini.planet,
    startDate: new Date(currentDate).toISOString(),
    endDate: new Date(firstEndDate).toISOString(),
    isBalance: true,
  };
  mainBalance.antardashas = calculateAntardashas(
    startingYogini,
    mainBalance.startDate,
    mainBalance.endDate,
    true,
  );
  results.push(mainBalance);

  currentDate = new Date(firstEndDate);

  // Generate next dashas for 3 full cycles
  let currentIdx = (startingYoginiIdx + 1) % 8;
  for (let i = 0; i < 24; i++) {
    const yogini = yoginis[currentIdx];
    const endDate = new Date(currentDate);
    endDate.setFullYear(endDate.getFullYear() + yogini.period);

    const dasha = {
      name: yogini.name,
      planet: yogini.planet,
      startDate: new Date(currentDate).toISOString(),
      endDate: new Date(endDate).toISOString(),
    };
    dasha.antardashas = calculateAntardashas(
      yogini,
      dasha.startDate,
      dasha.endDate,
    );
    results.push(dasha);

    currentDate = new Date(endDate);
    currentIdx = (currentIdx + 1) % 8;
  }

  swe.close();
  return results;
}

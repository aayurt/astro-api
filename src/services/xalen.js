import { XalenWasm, initSync } from '@xalen/wasm';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let ready = false;
function ensureReady() {
  if (!ready) throw new Error('XalenWasm not initialized. Call xalen.init() first.');
}

const ZODIAC_SIGNS = [
  'Aries', 'Taurus', 'Gemini', 'Cancer', 'Leo', 'Virgo',
  'Libra', 'Scorpio', 'Sagittarius', 'Capricorn', 'Aquarius', 'Pisces',
];

const PLANET_NAMES = {
  0: 'Sun', 1: 'Moon', 2: 'Mercury', 3: 'Venus', 4: 'Mars',
  5: 'Jupiter', 6: 'Saturn', 7: 'Rahu', 8: 'Ketu',
};

const PLANET_ORDER = ['Sun', 'Moon', 'Mars', 'Mercury', 'Jupiter', 'Venus', 'Saturn', 'Rahu', 'Ketu'];

const XALEN_BODY_IDS = {
  Sun: 0, Moon: 1, Mercury: 2, Venus: 3, Mars: 4,
  Jupiter: 5, Saturn: 6, Rahu: 9, Ketu: 13,
};

function radiansToDegrees(r) {
  return r * 180 / Math.PI;
}

function signNameToNumber(name) {
  if (!name) return 1;
  for (let i = 0; i < ZODIAC_SIGNS.length; i++) {
    if (name.includes(ZODIAC_SIGNS[i])) return i + 1;
  }
  const ALT = ['Mesha','Vrishabha','Mithuna','Karka','Simha','Kanya','Tula','Vrishchika','Dhanu','Makara','Kumbha','Meena'];
  for (let i = 0; i < ALT.length; i++) {
    if (name.includes(ALT[i])) return i + 1;
  }
  return 1;
}

function jdToDate(jd) {
  const jd0 = Math.floor(jd + 0.5);
  const frac = jd + 0.5 - jd0;
  const a = jd0 + 32044;
  const b = Math.floor((4 * a + 3) / 146097);
  const c = a - Math.floor(146097 * b / 4);
  const d = Math.floor((4 * c + 3) / 1461);
  const e = c - Math.floor(1461 * d / 4);
  const m = Math.floor((5 * e + 2) / 153);
  const day = e - Math.floor((153 * m + 2) / 5) + 1;
  const month = m + 3 - 12 * Math.floor(m / 10);
  const year = 100 * b + d - 4800 + Math.floor(m / 10);
  const totalMinutes = frac * 24 * 60;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = Math.floor(totalMinutes % 60);
  const seconds = Math.round((totalMinutes % 1) * 60);
  // Build in UTC — the JD is UT, so constructing via the local-tz Date constructor
  // (as the old code did) shifted dates by the machine's own offset.
  return new Date(Date.UTC(year, month - 1, day, hours, minutes, seconds)).toISOString();
}

function calcHouseNumber(lonDeg, houseCuspsDeg) {
  for (let i = 0; i < 12; i++) {
    const start = houseCuspsDeg[i];
    const end = houseCuspsDeg[(i + 1) % 12];
    if (start <= end) {
      if (lonDeg >= start && lonDeg < end) return i + 1;
    } else {
      if (lonDeg >= start || lonDeg < end) return i + 1;
    }
  }
  return 1;
}

function normalizePlanetData(raw) {
  const lon = raw.longitude ?? raw.fullDegree ?? 0;
  const signNum = Math.floor(lon / 30) + 1;
  const normDeg = lon % 30;
  return {
    fullDegree: lon,
    normDegree: normDeg,
    current_sign: signNum,
    sign_number: signNum,
    zodiac_sign_name: ZODIAC_SIGNS[signNum - 1] || '',
    house_number: raw.house_number ?? raw.houseNumber ?? 1,
    nakshatra_name: raw.nakshatra_name ?? raw.nakshatraName ?? '',
    nakshatra_pada: raw.nakshatra_pada ?? raw.nakshatraPada ?? Math.floor((lon % 13.33333333) / (13.33333333 / 4)) + 1,
    isRetro: raw.isRetro ?? (raw.isRetrograde === true || raw.isRetrograde === 'true' ? 'true' : 'false'),
    degrees: Math.floor(normDeg),
    minutes: Math.floor((normDeg % 1) * 60),
  };
}

function toPlanetMap(planetEntries) {
  const namedMap = {};
  for (const item of planetEntries) {
    const key = item.planetName || item.name || item.planet_id;
    // Accept already-normalized entries (fullDegree) as well as raw entries (longitude)
    if (key && (item.longitude !== undefined || item.fullDegree !== undefined)) {
      namedMap[key] = normalizePlanetData(item);
    }
  }
  return namedMap;
}

function findNakshatra(longitude) {
  const NAKSHATRAS = [
    'Ashwini', 'Bharani', 'Krittika', 'Rohini', 'Mrigashira',
    'Ardra', 'Punarvasu', 'Pushya', 'Ashlesha', 'Magha',
    'Purva Phalguni', 'Uttara Phalguni', 'Hasta', 'Chitra',
    'Swati', 'Vishakha', 'Anuradha', 'Jyeshtha', 'Mula',
    'Purva Ashadha', 'Uttara Ashadha', 'Shravana', 'Dhanishta',
    'Shatabhisha', 'Purva Bhadrapada', 'Uttara Bhadrapada', 'Revati',
  ];
  return NAKSHATRAS[Math.floor(longitude / 13.33333333) % 27];
}

let _w;
function getW() {
  ensureReady();
  return _w;
}

async function init() {
  if (ready) return;
  const wasmPath = path.join(__dirname, '../../node_modules/@xalen/wasm/xalen_wasm_bg.wasm');
  const wasmBuffer = fs.readFileSync(wasmPath);
  initSync({ module: wasmBuffer });
  _w = new XalenWasm();
  ready = true;
}

function buildPayload({ year, month, date, hours, minutes, seconds, latitude, longitude, timezone }) {
  const hour = hours + (minutes || 0) / 60 + (seconds || 0) / 3600;
  const tz = parseFloat(timezone || '5.5');
  // julianDay() is a plain Gregorian->JD conversion (no timezone handling), but every
  // XALEN function takes jd_ut1. Convert local wall-clock to UT1 by subtracting the
  // UTC offset — otherwise the Ascendant/houses drift by the full offset (~82° for IST).
  const jd = XalenWasm.julianDay(year, month, date, hour) - tz / 24;
  return { jd, lat: latitude, lon: longitude, tz };
}

async function fetchPlanetsExtended(payload) {
  ensureReady();
  const { jd, lat, lon } = buildPayload(payload);

  const chart = JSON.parse(getW().fullChartJson(jd, lat, lon, 0));

  // XALEN returns planet longitudes in the SIDEREAL frame but the ascendant/MC and
  // house cusps in the TROPICAL frame. Convert the ascendant to sidereal and rebuild
  // the whole-sign house cusps from it so houses line up with the sidereal planets.
  const ayanamsa = chart.ayanamsa_deg ?? 0;
  const ascLon = (((chart.ascendant_deg ?? 0) - ayanamsa) % 360 + 360) % 360;
  const ascSignStart = Math.floor(ascLon / 30) * 30;
  const houseCuspsDeg = Array.from({ length: 12 }, (_, i) => (ascSignStart + i * 30) % 360);

  const PLANET_MAP_NAME = {
    Sun: 'Sun', Moon: 'Moon', Mars: 'Mars', Mercury: 'Mercury',
    Jupiter: 'Jupiter', Venus: 'Venus', Saturn: 'Saturn',
    'Rahu (Mean Node)': 'Rahu',
  };
  const planets = chart.planets || {};

  const planetEntries = [];

  for (const [xalenName, localName] of Object.entries(PLANET_MAP_NAME)) {
    const p = planets[xalenName];
    if (!p) continue;
    const pos = JSON.parse(getW().planetPositionJson(jd, XALEN_BODY_IDS[localName], true, 0));

    const nakshatraInfo = JSON.parse(getW().nakshatraInfoJson(p.longitude));

    planetEntries.push({
      planetName: localName,
      longitude: p.longitude,
      isRetrograde: pos.is_retrograde,
      houseNumber: calcHouseNumber(p.longitude, houseCuspsDeg),
      nakshatraName: nakshatraInfo.name || p.nakshatra || '',
      nakshatraPada: nakshatraInfo.pada || 1,
    });
  }

  // Ketu (derived as Rahu + 180°)
  const rahuPos = JSON.parse(getW().planetPositionJson(jd, 9, true, 0));
  const ketuLon = (rahuPos.longitude + 180) % 360;
  const ketuNak = JSON.parse(getW().nakshatraInfoJson(ketuLon));
  planetEntries.push({
    planetName: 'Ketu',
    longitude: ketuLon,
    isRetrograde: rahuPos.is_retrograde,
    houseNumber: calcHouseNumber(ketuLon, houseCuspsDeg),
    nakshatraName: ketuNak.name || '',
    nakshatraPada: ketuNak.pada || 1,
  });

  // Ascendant
  const ascNak = JSON.parse(getW().nakshatraInfoJson(ascLon));
  if (ascLon) {
    planetEntries.push({
      planetName: 'Ascendant',
      longitude: ascLon,
      isRetrograde: false,
      houseNumber: 1,
      nakshatraName: ascNak.name || '',
      nakshatraPada: ascNak.pada || 1,
    });
  }

  return { output: planetEntries };
}

async function fetchNavamsa(payload) {
  ensureReady();
  const { jd, lat, lon } = buildPayload(payload);
  const chart = JSON.parse(getW().fullChartJson(jd, lat, lon, 0));
  const planets = chart.planets || {};

  // D9 lagna: navamsa sign of the sidereal ascendant (the library's ascendant is tropical)
  const ayanamsa = chart.ayanamsa_deg ?? 0;
  const ascLon = (((chart.ascendant_deg ?? 0) - ayanamsa) % 360 + 360) % 360;
  const d9LagnaSign = signNameToNumber(XalenWasm.divisionalChart(ascLon, 9));

  const VEDIC_NAMES = {
    Sun: 'Sun', Moon: 'Moon', Mars: 'Mars', Mercury: 'Mercury',
    Jupiter: 'Jupiter', Venus: 'Venus', Saturn: 'Saturn',
    'Rahu (Mean Node)': 'Rahu',
  };

  // Also get Ketu from rahu + 180
  const rahuLon = planets['Rahu (Mean Node)']?.longitude;
  const allEntries = {};

  for (const [xalenName, localName] of Object.entries(VEDIC_NAMES)) {
    const p = planets[xalenName];
    if (!p) continue;
    const d9Sign = signNameToNumber(XalenWasm.divisionalChart(p.longitude, 9));
    allEntries[localName] = d9Sign;
  }

  if (rahuLon != null) {
    const ketuLon = (rahuLon + 180) % 360;
    const d9Ketu = signNameToNumber(XalenWasm.divisionalChart(ketuLon, 9));
    allEntries['Ketu'] = d9Ketu;
  }

  allEntries['Ascendant'] = d9LagnaSign;

  const output = Object.entries(allEntries).map(([planetName, signNum]) => {
    const longitude = (signNum - 1) * 30 + 15;
    const houseNumber = ((signNum - d9LagnaSign + 12) % 12) + 1;
    return {
      planetName,
      longitude,
      isRetrograde: false,
      houseNumber,
    };
  });

  return { output };
}

async function fetchVimsottariDashas(payload) {
  ensureReady();
  const { jd, lat, lon } = buildPayload(payload);

  const chart = JSON.parse(getW().fullChartJson(jd, lat, lon, 0));
  const moonLon = chart.planets?.Moon?.longitude;
  if (moonLon == null) throw new Error('Moon longitude not found for dasha calculation');

  const raw = JSON.parse(XalenWasm.vimshottariDasha(moonLon, jd));

  function formatDasha(d) {
    return {
      dasha: d.lord,
      start_date: jdToDate(d.start_jd),
      end_date: jdToDate(d.end_jd),
      antar_dashas: (d.sub_periods || []).map(formatDasha),
    };
  }

  return raw.map(formatDasha);
}

async function fetchPanchang(payload) {
  ensureReady();
  const { jd, lat, lon } = buildPayload(payload);
  const raw = JSON.parse(getW().panchangJson(jd, 0));

  const TITHI_NAMES = [
    'Pratipada', 'Dwitiya', 'Tritiya', 'Chaturthi', 'Panchami',
    'Shashti', 'Saptami', 'Ashtami', 'Navami', 'Dashami',
    'Ekadashi', 'Dwadashi', 'Trayodashi', 'Chaturdashi', 'Purnima',
    'Pratipada', 'Dwitiya', 'Tritiya', 'Chaturthi', 'Panchami',
    'Shashti', 'Saptami', 'Ashtami', 'Navami', 'Dashami',
    'Ekadashi', 'Dwadashi', 'Trayodashi', 'Chaturdashi', 'Amavasya',
  ];
  const NAKSHATRA_NAMES = [
    'Ashwini', 'Bharani', 'Krittika', 'Rohini', 'Mrigashira',
    'Ardra', 'Punarvasu', 'Pushya', 'Ashlesha', 'Magha',
    'Purva Phalguni', 'Uttara Phalguni', 'Hasta', 'Chitra',
    'Swati', 'Vishakha', 'Anuradha', 'Jyeshtha', 'Mula',
    'Purva Ashadha', 'Uttara Ashadha', 'Shravana', 'Dhanishta',
    'Shatabhisha', 'Purva Bhadrapada', 'Uttara Bhadrapada', 'Revati',
  ];
  const YOGA_NAMES = [
    'Vishkumbha', 'Preeti', 'Ayushman', 'Saubhagya', 'Shobhana',
    'Atiganda', 'Sukarma', 'Dhriti', 'Shoola', 'Ganda',
    'Vriddhi', 'Dhruva', 'Vyaghata', 'Harshana', 'Vajra',
    'Siddhi', 'Vyatipata', 'Variyan', 'Parigha', 'Shiva',
    'Siddha', 'Sadhya', 'Shubha', 'Shukla', 'Brahma',
    'Indra', 'Vaidhriti',
  ];
  const KARANA_NAMES = [
    'Kimstughna', 'Bava', 'Balava', 'Kaulava', 'Taitila',
    'Garija', 'Vanija', 'Vishti', 'Shakuni', 'Chatushpada',
    'Naga',
  ];
  const VARA_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  const tithiNum = raw.tithi?.number || 1;
  const tithiName = TITHI_NAMES[tithiNum - 1] || '';
  const paksha = raw.tithi?.paksha || (tithiNum <= 15 ? 'Shukla' : 'Krishna');
  const nakshatraName = raw.nakshatra || '';
  const yogaNum = raw.yoga?.number || 1;
  const yogaName = YOGA_NAMES[yogaNum - 1] || '';
  const karanaNum = raw.karana?.number || 1;
  const karanaName = KARANA_NAMES[Math.min(karanaNum - 1, KARANA_NAMES.length - 1)] || '';
  const varaName = VARA_NAMES[['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].indexOf(raw.vara)] || raw.vara || '';

  return {
    tithi: { name: tithiName },
    nakshatra: { name: nakshatraName },
    yoga: { name: yogaName },
    karana: { name: karanaName },
    weekday: { vedic_weekday_name: varaName },
    sun_rise: '',
    sun_set: '',
  };
}

export const xalen = {
  ZODIAC_SIGNS,
  PLANET_NAMES,
  toPlanetMap,
  normalizePlanetData,
  findNakshatra,
  init,

  fetchPlanetsExtended,
  fetchNavamsa,
  fetchVimsottariDashas,
  fetchPanchang,
};

import pkg from '@prisma/client';
import { toNodeHandler } from 'better-auth/node';
import cors from 'cors';
import 'dotenv/config';
import express from 'express';
import { MASTER_PROMPT_TEMPLATE_PERSONALITY_GEMINI } from './constants.js';
import {
  buildMasterPrompt,
  buildMasterPromptV4,
  buildMasterPromptV5,
  processUserQuery,
  safeParseJSON,
} from './lib/ai-agent.js';
import { getYoginiDasha } from './lib/astrology.js';
import { auth } from './lib/auth.js';
import {
  KNOWLEDGE_SOURCES,
  getSourceFilter,
  getSourceLabel,
  getSourceInstruction,
} from './lib/knowledge-sources.js';
import { askQwen as askQwenLib } from './lib/qwen.js';
import { GeminiWebService } from './services/gemini.js';
import { GemmaService } from './services/gemma.js';
import { xalen } from './services/xalen.js';
import { trustedOrigins } from './trustedDomains.js';
const { PrismaClient } = pkg;

const prisma = new PrismaClient();
const geminiService = new GeminiWebService();
const gemmaService = new GemmaService();

const app = express();
const port = process.env.PORT || 3001;

app.set('trust proxy', true);

app.use(
  cors({
    origin: trustedOrigins,
    credentials: true,
  }),
);

// better-auth handler
console.log('Better Auth URL: ' + process.env.BETTER_AUTH_URL);
app.all('/astro/api/auth/{*any}', toNodeHandler(auth));
app.all('/api/auth/{*any}', toNodeHandler(auth));

app.use(express.json());

// Middleware to get user from auth session
const getUser = async (req, res, next) => {
  try {
    const session = await auth.api.getSession({
      headers: new Headers(req.headers),
    });

    if (!session || !session.user) {
      console.log('❌ Session not found or user not found in session');
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Always fetch full user from Prisma to ensure all fields (birthDate, coins, etc.) are available
    const fullUser = await prisma.user.findUnique({
      where: { id: session.user.id },
    });

    if (!fullUser) {
      return res.status(401).json({ error: 'User not found in database' });
    }

    req.user = fullUser;
    next();
  } catch (error) {
    console.error('getUser middleware error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

const resolveProfile = async (req, res, next) => {
  const profileId = req.query.profileId || req.body?.profileId;
  if (profileId) {
    const profile = await prisma.profile.findFirst({
      where: { id: profileId, userId: req.user.id },
    }).catch(() => null);
    if (profile) {
      const { id, userId, createdAt, updatedAt, ...profileData } = profile;
      req.user = { ...req.user, ...profileData, _skipAstroCache: true };
    }
  }
  next();
};

const withProfile = [getUser, resolveProfile];

app.get('/api', async (req, res) => {
  res.json({ success: true });
});

// Location Search API (using Nominatim - OpenStreetMap)
app.post('/api/location/search', getUser, async (req, res) => {
  const { location } = req.body;
  if (!location) {
    return res.status(400).json({ error: 'Location query is required' });
  }

  try {
    const response = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(
        location,
      )}&limit=5&addressdetails=1`,
      {
        headers: {
          'User-Agent': 'AstroApp/1.0',
        },
      },
    );

    if (!response.ok) {
      throw new Error(`Location API error: ${response.statusText}`);
    }
    const data = await response.json();

    // Map Nominatim results to a consistent format
    const results = data.map((item) => ({
      complete_name: item.display_name,
      latitude: parseFloat(item.lat),
      longitude: parseFloat(item.lon),
      // Nominatim doesn't provide timezone, we'll handle that on selection or with another call
    }));

    res.json(results);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Timezone API (using TimeZoneDB API)
app.post('/api/location/timezone', getUser, async (req, res) => {
  const { latitude, longitude } = req.body;
  if (latitude === undefined || longitude === undefined) {
    return res
      .status(400)
      .json({ error: 'Latitude and Longitude are required' });
  }

  try {
    const apiKey = process.env.TIMEZONEDB_API_KEY;

    const response = await fetch(
      `http://api.timezonedb.com/v2.1/get-time-zone?key=${apiKey}&format=json&by=position&lat=${latitude}&lng=${longitude}`,
    );

    if (!response.ok) {
      // Fallback to a default if TimeZoneDB API fails
      return res.json({ timezone_offset: 5.5 });
    }

    const data = await response.json();

    if (data.status !== 'OK') {
      console.error('TimeZoneDB API Error:', data.message || data.status);
      return res.json({ timezone_offset: 5.5 });
    }

    // TimeZoneDB returns gmtOffset in seconds. Convert to hours.
    const timezoneOffsetHours = data.gmtOffset / 3600;

    res.json({
      timezone_offset: timezoneOffsetHours,
      timezone_id: data.zoneName,
    });
  } catch (error) {
    console.error('Timezone fetch error:', error);
    res.json({ timezone_offset: 5.5 }); // Graceful fallback
  }
});

// Route to update user profile
app.post('/api/user/profile', getUser, async (req, res) => {
  const { birthDate, birthTime, location, latitude, longitude, timezone } =
    req.body;
  try {
    // If birth details are changing, delete old astrology data to force recalculation
    await prisma.astrologyData.deleteMany({
      where: { userId: req.user.id },
    });

    const updatedUser = await prisma.user.update({
      where: { id: req.user.id },
      data: {
        birthDate: birthDate ? new Date(birthDate) : undefined,
        birthTime,
        location,
        latitude: latitude ? parseFloat(latitude) : undefined,
        longitude: longitude ? parseFloat(longitude) : undefined,
        timezone,
      },
    });

    res.json(updatedUser);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const getAstroData = async (
  user,
  endpoint,
  type = null,
  useCurrentTime = false,
  force = false,
) => {
  const ONE_DAY = 24 * 60 * 60 * 1000;

  // 🚀 1. Check Global Transit Cache (shared across all users in a timezone)
  if (!force && type === 'transit') {
    const timezone = user.timezone || '5.5';
    try {
      const cachedTransit = await prisma.transitCache.findUnique({
        where: { timezone: timezone.toString() },
      });
      if (
        cachedTransit &&
        Date.now() - new Date(cachedTransit.updatedAt).getTime() < ONE_DAY
      ) {
        console.log(`✅ Returning cached transit for timezone ${timezone}`);
        return cachedTransit.data;
      }
    } catch (err) {
      console.log(`Transit cache check failed, fetching fresh...`);
    }
  }

  // 🔧 2. Prepare payload
  // Components are the user's LOCAL wall-clock; buildPayload() subtracts the UTC offset
  // to produce the UT1 Julian Day XALEN expects.
  const timezone = parseFloat(user.timezone || '5.5');
  let payload;
  if (useCurrentTime) {
    // Transit: user's local wall-clock now (shift now by the user's offset, read as UTC)
    const localNow = new Date(Date.now() + timezone * 3600000);
    payload = {
      year: localNow.getUTCFullYear(),
      month: localNow.getUTCMonth() + 1,
      date: localNow.getUTCDate(),
      hours: localNow.getUTCHours(),
      minutes: localNow.getUTCMinutes(),
      seconds: localNow.getUTCSeconds(),
      latitude: user.latitude,
      longitude: user.longitude,
      timezone,
    };
  } else {
    const birth = new Date(user.birthDate);
    const [birthHour, birthMinute] = (user.birthTime || '12:00').split(':').map(Number);
    payload = {
      year: birth.getUTCFullYear(),
      month: birth.getUTCMonth() + 1,
      date: birth.getUTCDate(),
      hours: birthHour,
      minutes: birthMinute || 0,
      seconds: 0,
      latitude: user.latitude,
      longitude: user.longitude,
      timezone,
    };
  }

  let processedData;

  try {
    if (type === 'mahaDashas') {
      processedData = await xalen.fetchVimsottariDashas(payload);
    } else if (type === 'transit') {
      const result = await xalen.fetchPlanetsExtended(payload);
      processedData = xalen.toPlanetMap(result.output);
    } else if (type === 'navamsa') {
      const result = await xalen.fetchNavamsa(payload);
      processedData = xalen.toPlanetMap(result.output);
    } else if (['planets', 'extended', 'natal'].includes(type)) {
      const result = await xalen.fetchPlanetsExtended(payload);
      processedData = xalen.toPlanetMap(result.output);
    } else {
      throw new Error(`Unknown astrology data type: ${type}`);
    }
  } catch (err) {
    console.error(`Astro API error for ${type}:`, err.message);
    throw new Error(`Astro API error: ${err.message}`);
  }

  // 🚀 3. Update Global Transit Cache (shared across timezone)
  if (type === 'transit') {
    const timezone = user.timezone || '5.5';
    await prisma.transitCache.upsert({
      where: { timezone },
      update: { data: processedData, updatedAt: new Date() },
      create: { timezone, data: processedData },
    });
  }

  return processedData;
};

app.get('/api/astrology/planets', withProfile, async (req, res) => {
  const user = req.user;
  if (!user.birthDate || user.latitude === undefined) {
    return res.status(400).json({ error: 'User birth details missing' });
  }

  try {
    // Check DB first
    const existing = user?._skipAstroCache ? null : await prisma.astrologyData.findUnique({
      where: { userId: user.id },
    });
    if (existing?.planets) {
      console.log('✅ DB: Fetched data for planets');
      return res.json(existing.planets);
    }
    console.log('↻ API: Fetching new data for planets');
    const data = await getAstroData(user, 'planets', 'planets');
    console.log('✅ API: Fetched new data for planets');

    await prisma.astrologyData.upsert({
      where: { userId: user.id },
      update: { planets: data },
      create: { userId: user.id, planets: data },
    }).catch(() => {});

    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/astrology/planets-extended', withProfile, async (req, res) => {
  const user = req.user;

  if (!user.birthDate || user.latitude === undefined) {
    return res.status(400).json({ error: 'User birth details missing' });
  }

  try {
    const existing = user?._skipAstroCache ? null : await prisma.astrologyData.findUnique({
      where: { userId: user.id },
    });

    if (existing?.extended) {
      console.log('✅ DB: Fetched data for extended');
      return res.json(existing.extended);
    }
    console.log('↻ API: Fetching new data for extended');
    const data = await getAstroData(user, 'planets/extended', 'extended');
    console.log('✅ API: Fetched new data for extended');
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/astrology/natal-chart', withProfile, async (req, res) => {
  const user = req.user;
  const force = req.query.force === 'true';
  if (
    !user.birthDate ||
    user.latitude === undefined ||
    user.longitude === undefined
  ) {
    return res.status(400).json({ error: 'User birth details missing' });
  }
  try {
    const data = await getAstroData(user, 'planets', 'natal', false, force);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/astrology/d9-chart', withProfile, async (req, res) => {
  const user = req.user;
  if (
    !user.birthDate ||
    user.latitude === undefined ||
    user.longitude === undefined
  ) {
    return res.status(400).json({ error: 'User birth details missing' });
  }
  try {
    const existing = user?._skipAstroCache ? null : await prisma.astrologyData.findUnique({
      where: { userId: user.id },
    });
    if (existing?.navamsa) {
      console.log('✅ DB: Fetched data for navamsa');
      return res.json(existing.navamsa);
    }

    const data = await getAstroData(user, 'navamsa-chart-info', 'navamsa');
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/astrology/panchang', withProfile, async (req, res) => {
  const user = req.user;
  if (
    !user.birthDate ||
    user.latitude === undefined ||
    user.longitude === undefined
  ) {
    return res.status(400).json({ error: 'User birth details missing' });
  }
  try {
    const existing = user?._skipAstroCache ? null : await prisma.astrologyData.findUnique({
      where: { userId: user.id },
    });
    if (existing?.panchang) return res.json(existing.panchang);

    const birth = new Date(user.birthDate);
    const [birthHour, birthMinute] = (user.birthTime || '12:00').split(':').map(Number);
    const payload = {
      year: birth.getUTCFullYear(),
      month: birth.getUTCMonth() + 1,
      date: birth.getUTCDate(),
      hours: birthHour,
      minutes: birthMinute || 0,
      seconds: 0,
      latitude: user.latitude,
      longitude: user.longitude,
      timezone: parseFloat(user.timezone || '5.5'),
    };

    const panchang = await xalen.fetchPanchang(payload);

    await prisma.astrologyData.upsert({
      where: { userId: user.id },
      update: { panchang },
      create: { userId: user.id, panchang },
    });

    res.json(panchang);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/astrology/highlights', withProfile, async (req, res) => {
  const user = req.user;
  if (!user.birthDate || user.latitude === undefined) {
    return res.status(400).json({ error: 'User birth details missing' });
  }

  try {
    const existing = user?._skipAstroCache ? null : await prisma.astrologyData.findUnique({
      where: { userId: user.id },
    });

    let planets = existing?.extended;
    if (!planets) {
      planets = await getAstroData(user, 'planets/extended', 'extended');
    }

    const highlights = [];
    const planetEntries = Object.entries(planets);

    // 1. Retrograde Alert
    const retroPlanets = planetEntries
      .filter(
        ([name, data]) =>
          data.isRetro === 'true' && name !== 'Rahu' && name !== 'Ketu',
      )
      .map(([name]) => name);
    if (retroPlanets.length > 0) {
      highlights.push({
        title: 'Retrograde Alert',
        detail: `${retroPlanets.join(', ')} ${retroPlanets.length > 1 ? 'are' : 'is'} currently retrograde in your chart.`,
      });
    }

    // 2. Combust Alert
    const sun = planets.Sun;
    if (sun) {
      const sunDegree = sun.fullDegree;
      const thresholds = {
        Moon: 12,
        Mars: 17,
        Mercury: planets.Mercury?.isRetro === 'true' ? 12 : 14,
        Jupiter: 11,
        Venus: planets.Venus?.isRetro === 'true' ? 8 : 10,
        Saturn: 15,
      };

      const combustPlanets = Object.entries(thresholds)
        .filter(([name, threshold]) => {
          const p = planets[name];
          if (!p) return false;
          const diff = Math.abs(p.fullDegree - sunDegree);
          const distance = Math.min(diff, 360 - diff);
          return distance < threshold;
        })
        .map(([name]) => name);

      if (combustPlanets.length > 0) {
        highlights.push({
          title: 'Combust Alert',
          detail: `${combustPlanets.join(', ')} ${combustPlanets.length > 1 ? 'are' : 'is'} combust (too close to the Sun).`,
        });
      }
    }

    // 3. Sun & Moon Sign
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
    if (sun) {
      highlights.push({
        title: 'Sun Sign',
        detail: `Your Sun is in ${sun.zodiac_sign_name || zodiacSigns[sun.current_sign - 1]}.`,
      });
    }
    if (planets.Moon) {
      highlights.push({
        title: 'Moon Sign',
        detail: `Your Moon is in ${planets.Moon.zodiac_sign_name || zodiacSigns[planets.Moon.current_sign - 1]}.`,
      });
    }

    // 4. Jaimini Karakas (Atmakaraka & Darakaraka)
    const majorPlanets = [
      'Sun',
      'Moon',
      'Mars',
      'Mercury',
      'Jupiter',
      'Venus',
      'Saturn',
    ]
      .map((name) => ({ name, degree: planets[name]?.normDegree % 30 || 0 }))
      .sort((a, b) => b.degree - a.degree);

    if (majorPlanets.length >= 7) {
      highlights.push({
        title: 'Atmakaraka',
        detail: `${majorPlanets[0].name} is your soul planet (Atmakaraka), holding the highest degree.`,
      });
      highlights.push({
        title: 'Darakaraka',
        detail: `${majorPlanets[6].name} is your spouse planet (Darakaraka), holding the lowest degree.`,
      });
    }

    // 5. Yogakaraka
    const ascSign = planets?.Ascendant?.current_sign;
    const yogakarakaMap = {
      2: { name: 'Saturn', houses: '9th & 10th' }, // Taurus: 9 & 10
      4: { name: 'Mars', houses: '5th & 10th' }, // Cancer: 5 & 10
      5: { name: 'Mars', houses: '4th & 9th' }, // Leo: 4 & 9
      7: { name: 'Saturn', houses: '4th & 5th' }, // Libra: 4 & 5
      10: { name: 'Venus', houses: '5th & 10th' }, // Capricorn: 5 & 10
      11: { name: 'Venus', houses: '4th & 9th' }, // Aquarius: 4 & 9
    };
    const yk = yogakarakaMap[ascSign];
    if (yk) {
      highlights.push({
        title: 'Yogakaraka',
        detail: `${yk.name} is your Yogakaraka planet, ruling your ${yk.houses} houses. It brings immense luck and power.`,
      });
    }
    console.log({ yk, ascSign, planets });
    // 6. Conjunctions (Planets in same house)
    const houseMap = {};
    planetEntries.forEach(([name, data]) => {
      const house = data.house_number || 1;
      if (!houseMap[house]) houseMap[house] = [];
      houseMap[house].push(name);
    });

    const conjunctions = Object.entries(houseMap)
      .filter(([house, planets]) => planets.length > 1)
      .map(([house, planets]) => `${planets.join(' & ')} in House ${house}`);

    if (conjunctions.length > 0) {
      highlights.push({
        title: 'Conjunctions',
        detail: `Key planetary pairings: ${conjunctions.join('; ')}.`,
      });
    }

    res.json(highlights);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/astrology/transit', withProfile, async (req, res) => {
  const user = req.user;
  if (!user.latitude || user.longitude === undefined) {
    return res.status(400).json({ error: 'User location details missing' });
  }
  const timezone = user.timezone || '5.5';
  const force = req.query.force === 'true';

  try {
    // Check global transit cache
    const cachedTransit = await prisma.transitCache.findUnique({
      where: { timezone: timezone.toString() },
    });

    const ONE_DAY = 24 * 60 * 60 * 1000;
    if (
      !force &&
      cachedTransit &&
      Date.now() - new Date(cachedTransit.updatedAt).getTime() < ONE_DAY
    ) {
      console.log(`✅ Returning cached transit data for timezone ${timezone}`);
      return res.json(cachedTransit.data);
    }

    console.log(`↻ Fetching fresh transit data for timezone ${timezone}`);
    const data = await getAstroData(
      user,
      'planets/extended',
      'transit',
      true,
      force,
    );

    // Update global cache
    await prisma.transitCache.upsert({
      where: { timezone: timezone.toString() },
      update: { data, updatedAt: new Date() },
      create: { timezone: timezone.toString(), data },
    });

    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Convert various raw data formats into a named planet map with all derived fields
const toPlanetMap = (output) => {
  if (Array.isArray(output)) {
    // Old format: [index, {PlanetName: {properties}}] or direct array of entries
    const isOldFormat = output[1] && !Array.isArray(output[1]) && !output[0]?.name && !output[0]?.planetName;
    const rawData = isOldFormat
      ? Object.entries(output[1]).map(([name, val]) => ({ name, ...val }))
      : output;
    return xalen.toPlanetMap(rawData);
  }
  return xalen.toPlanetMap(
    Object.entries(output).map(([name, val]) => ({ name, ...val })),
  );
};

const shiftChartRelativeTo = (transitData, referenceSign) => {
  const result = {};
  for (const [planet, info] of Object.entries(transitData ?? {})) {
    const transitSign = info?.sign_number || info?.current_sign || 0;
    if (transitSign === 0) continue;
    let relativeHouse = transitSign - referenceSign + 1;
    if (relativeHouse <= 0) relativeHouse += 12;
    result[planet] = {
      ...info,
      original_house_number: info.house_number,
      house_number: relativeHouse,
    };
  }
  if (result.Ascendant) {
    result.Ascendant.transit_sign = result.Ascendant.current_sign || result.Ascendant.sign_number;
    result.Ascendant.current_sign = referenceSign;
  }
  return result;
};

app.get('/api/astrology/my-transit', withProfile, async (req, res) => {
  const user = req.user;

  if (user.latitude == null || user.longitude == null) {
    return res.status(400).json({ error: 'User location details missing' });
  }

  const timezone = user.timezone ?? '5.5';
  const force = req.query.force === 'true';

  try {
    const cachedTransit = user?._skipAstroCache ? null : await prisma.astrologyData.findUnique({
      where: { userId: user.id },
    });

    const ONE_DAY = 24 * 60 * 60 * 1000;

    // ✅ Proper cache validation
    if (
      !force &&
      cachedTransit?.myTransit &&
      Object.keys(cachedTransit.myTransit).length > 0 &&
      cachedTransit?.myTransitUpdatedAt &&
      Date.now() - new Date(cachedTransit.myTransitUpdatedAt).getTime() <
        ONE_DAY
    ) {
      console.log('✅ Returning cached myTransit (fresh)');
      return res.json(cachedTransit.myTransit);
    }

    console.log(`↻ Fetching fresh transit data for timezone ${timezone}`);

    const transitData = await getAstroData(
      user,
      'planets/extended',
      'transit',
      true,
    );

    const natalData = await getAstroData(
      user,
      'planets/extended',
      'natal',
      false,
    );

    const planetMap = toPlanetMap(transitData?.output || transitData);
    const natalAscSign = natalData?.Ascendant?.current_sign;
    if (!natalAscSign) {
      throw new Error('Natal Ascendant sign not found');
    }

    const result = shiftChartRelativeTo(planetMap, natalAscSign);

    await prisma.astrologyData.upsert({
      where: { userId: user.id },
      update: {
        myTransit: result,
        myTransitUpdatedAt: new Date(),
      },
      create: {
        userId: user.id,
        myTransit: result,
        myTransitUpdatedAt: new Date(),
      },
    });

    return res.json(result);
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      error: error.message || 'Internal server error',
    });
  }
});

app.get('/api/astrology/lagna-gochar', withProfile, async (req, res) => {
  const user = req.user;
  if (user.latitude == null || user.longitude == null) {
    return res.status(400).json({ error: 'User location details missing' });
  }

  const force = req.query.force === 'true';
  try {
    const cached = user?._skipAstroCache ? null : await prisma.astrologyData.findUnique({
      where: { userId: user.id },
    });

    const ONE_DAY = 24 * 60 * 60 * 1000;
    if (
      !force &&
      cached?.lagnaGochar &&
      Object.keys(cached.lagnaGochar).length > 0 &&
      cached?.lagnaGocharUpdatedAt &&
      Date.now() - new Date(cached.lagnaGocharUpdatedAt).getTime() < ONE_DAY
    ) {
      console.log('✅ Returning cached lagnaGochar');
      return res.json(cached.lagnaGochar);
    }

    const transitData = await getAstroData(
      user,
      'planets/extended',
      'transit',
      true,
    );

    const natalData = await getAstroData(
      user,
      'planets/extended',
      'natal',
      false,
    );

    const planetMap = toPlanetMap(transitData?.output || transitData);
    const lagnaSign = natalData?.Ascendant?.current_sign;
    if (!lagnaSign) {
      throw new Error('Natal Ascendant sign not found');
    }

    const result = shiftChartRelativeTo(planetMap, lagnaSign);

    await prisma.astrologyData.upsert({
      where: { userId: user.id },
      update: {
        lagnaGochar: result,
        lagnaGocharUpdatedAt: new Date(),
      },
      create: {
        userId: user.id,
        lagnaGochar: result,
        lagnaGocharUpdatedAt: new Date(),
      },
    });

    return res.json(result);
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      error: error.message || 'Internal server error',
    });
  }
});

app.get('/api/astrology/chandra-gochar', withProfile, async (req, res) => {
  const user = req.user;
  if (user.latitude == null || user.longitude == null) {
    return res.status(400).json({ error: 'User location details missing' });
  }

  const force = req.query.force === 'true';
  try {
    const cached = user?._skipAstroCache ? null : await prisma.astrologyData.findUnique({
      where: { userId: user.id },
    });

    const ONE_DAY = 24 * 60 * 60 * 1000;
    if (
      !force &&
      cached?.chandraGochar &&
      Object.keys(cached.chandraGochar).length > 0 &&
      cached?.chandraGocharUpdatedAt &&
      Date.now() - new Date(cached.chandraGocharUpdatedAt).getTime() < ONE_DAY
    ) {
      console.log('✅ Returning cached chandraGochar');
      return res.json(cached.chandraGochar);
    }

    const transitData = await getAstroData(
      user,
      'planets/extended',
      'transit',
      true,
    );

    const natalData = await getAstroData(
      user,
      'planets/extended',
      'natal',
      false,
    );

    const planetMap = toPlanetMap(transitData?.output || transitData);
    const moonSign = natalData?.Moon?.current_sign;
    if (!moonSign) {
      throw new Error('Natal Moon sign not found');
    }

    const result = shiftChartRelativeTo(planetMap, moonSign);

    await prisma.astrologyData.upsert({
      where: { userId: user.id },
      update: {
        chandraGochar: result,
        chandraGocharUpdatedAt: new Date(),
      },
      create: {
        userId: user.id,
        chandraGochar: result,
        chandraGocharUpdatedAt: new Date(),
      },
    });

    return res.json(result);
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      error: error.message || 'Internal server error',
    });
  }
});

app.get('/api/astrology/all-transit', withProfile, async (req, res) => {
  const user = req.user;
  if (user.latitude == null || user.longitude == null) {
    return res.status(400).json({ error: 'User location details missing' });
  }

  const timezone = user.timezone || '5.5';
  const force = req.query.force === 'true';

  try {
    // Check global transit cache
    const cachedTransit = await prisma.transitCache.findUnique({
      where: { timezone: timezone.toString() },
    });
    const ONE_DAY = 24 * 60 * 60 * 1000;
    let transitData;
    if (!force && cachedTransit && Date.now() - new Date(cachedTransit.updatedAt).getTime() < ONE_DAY) {
      console.log(`✅ Returning cached transit data for timezone ${timezone}`);
      transitData = cachedTransit.data;
    } else {
      console.log(`↻ Fetching fresh transit data for timezone ${timezone}`);
      transitData = await getAstroData(user, 'planets/extended', 'transit', true, force);
      await prisma.transitCache.upsert({
        where: { timezone: timezone.toString() },
        update: { data: transitData, updatedAt: new Date() },
        create: { timezone: timezone.toString(), data: transitData },
      });
    }

    const cachedUser = user?._skipAstroCache ? null : await prisma.astrologyData.findUnique({
      where: { userId: user.id },
    });

    // Always normalize transit into the named-map shape the frontend expects
    const transitMap = toPlanetMap(transitData?.output || transitData);

    // Check if all cached user transit data is still fresh
    if (!force && cachedUser?.lagnaGochar && cachedUser?.chandraGochar && cachedUser?.myTransit &&
        Object.keys(cachedUser.lagnaGochar).length > 0 &&
        Object.keys(cachedUser.chandraGochar).length > 0 &&
        Object.keys(cachedUser.myTransit).length > 0 &&
        cachedUser.lagnaGocharUpdatedAt &&
        Date.now() - new Date(cachedUser.lagnaGocharUpdatedAt).getTime() < ONE_DAY) {
      console.log('✅ Returning all cached user transit data');
      return res.json({
        transit: transitMap,
        myTransit: cachedUser.myTransit,
        lagnaGochar: cachedUser.lagnaGochar,
        chandraGochar: cachedUser.chandraGochar,
      });
    }

    const natalData = await getAstroData(user, 'planets/extended', 'natal', false);
    const planetMap = transitMap;

    // lagnaGochar = transit relative to natal Ascendant (same as myTransit)
    const natalAscSign = natalData?.Ascendant?.current_sign;
    if (!natalAscSign) throw new Error('Natal Ascendant sign not found');
    const myTransit = shiftChartRelativeTo(planetMap, natalAscSign);
    const lagnaGochar = myTransit;

    // chandraGochar = transit relative to natal Moon sign
    const natalMoonSign = natalData?.Moon?.current_sign;
    if (!natalMoonSign) throw new Error('Natal Moon sign not found');
    const chandraGochar = shiftChartRelativeTo(planetMap, natalMoonSign);

    // Persist all derived charts
    await prisma.astrologyData.upsert({
      where: { userId: user.id },
      update: {
        lagnaGochar,
        lagnaGocharUpdatedAt: new Date(),
        chandraGochar,
        chandraGocharUpdatedAt: new Date(),
        myTransit,
        myTransitUpdatedAt: new Date(),
      },
      create: {
        userId: user.id,
        lagnaGochar,
        lagnaGocharUpdatedAt: new Date(),
        chandraGochar,
        chandraGocharUpdatedAt: new Date(),
        myTransit,
        myTransitUpdatedAt: new Date(),
      },
    });

    return res.json({
      transit: transitMap,
      myTransit,
      lagnaGochar,
      chandraGochar,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

app.get('/api/astrology/yogini-dasha', withProfile, async (req, res) => {
  const user = req.user;
  if (!user.birthDate || user.latitude === undefined) {
    return res.status(400).json({ error: 'User birth details missing' });
  }
  try {
    const existing = user?._skipAstroCache ? null : await prisma.astrologyData.findUnique({
      where: { userId: user.id },
    });
    if (existing?.yoginiDasha) return res.json(existing.yoginiDasha);

    const data = await getYoginiDasha(new Date(user.birthDate));

    await prisma.astrologyData.upsert({
      where: { userId: user.id },
      update: { yoginiDasha: data },
      create: { userId: user.id, yoginiDasha: data },
    });

    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/astrology/dasha-info', withProfile, async (req, res) => {
  const user = req.user;
  const force = req.query.force === 'true';
  if (!user.birthDate || user.latitude === undefined) {
    return res.status(400).json({ error: 'User birth details missing' });
  }
  try {
    const data = await getAstroData(
      user,
      'vimsottari/dasa-information',
      'dashaInfo',
      false,
      force,
    );
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/astrology/maha-dashas', withProfile, async (req, res) => {
  const user = req.user;
  const force = req.query.force === 'true';
  if (!user.birthDate || user.latitude === undefined) {
    return res.status(400).json({ error: 'User birth details missing' });
  }
  try {
    const data = await getAstroData(
      user,
      'vimsottari/maha-dasas-and-antar-dasas',
      'mahaDashas',
      false,
      force,
    );
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Coin management endpoints
app.get('/api/user/coins', getUser, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { coins: true, lastClaimedAt: true },
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const canClaim =
      !user.lastClaimedAt ||
      Date.now() - new Date(user.lastClaimedAt).getTime() >=
        24 * 60 * 60 * 1000;

    res.json({
      coins: user.coins,
      canClaim,
      lastClaimedAt: user.lastClaimedAt,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/user/claim-coins', getUser, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const lastClaimed = user.lastClaimedAt
      ? new Date(user.lastClaimedAt).getTime()
      : 0;
    const now = Date.now();
    const gap = 24 * 60 * 60 * 1000;

    if (now - lastClaimed < gap) {
      return res
        .status(400)
        .json({ error: 'Daily claim already used. Please wait 24 hours.' });
    }

    const updatedUser = await prisma.user.update({
      where: { id: req.user.id },
      data: {
        coins: user.coins + 1,
        lastClaimedAt: new Date(),
      },
    });

    res.json({
      success: true,
      coins: updatedUser.coins,
      lastClaimedAt: updatedUser.lastClaimedAt,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Coupon redemption (sets coins to the coupon amount, never decreases)
const COUPONS = {
  '50': { coins: 50 },
};

app.post('/api/user/redeem-coupon', getUser, async (req, res) => {
  try {
    const { code } = req.body || {};
    const coupon = COUPONS[String(code || '').trim().toUpperCase()];
    if (!coupon) {
      return res.status(400).json({ error: 'Invalid coupon code' });
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
    });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const updatedUser = await prisma.user.update({
      where: { id: req.user.id },
      data: { coins: Math.max(user.coins, coupon.coins) },
    });

    res.json({
      success: true,
      coins: updatedUser.coins,
      coupon: { code: String(code).trim().toUpperCase(), coins: coupon.coins },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Profile Endpoints ──────────────────────────────────────────────

app.get('/api/user/profiles', getUser, async (req, res) => {
  try {
    let profiles = await prisma.profile.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: 'asc' },
    });
    if (profiles.length === 0) {
      const defaultProfile = await prisma.profile.create({
        data: {
          userId: req.user.id,
          name: req.user.name || 'Me',
          relation: 'self',
          birthDate: req.user.birthDate,
          birthTime: req.user.birthTime,
          location: req.user.location,
          latitude: req.user.latitude,
          longitude: req.user.longitude,
          timezone: req.user.timezone,
        },
      });
      profiles = [defaultProfile];
    }
    res.json(profiles);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/user/profiles', getUser, async (req, res) => {
  try {
    const { name, relation, avatar, color, birthDate, birthTime, location, latitude, longitude, timezone } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const profile = await prisma.profile.create({
      data: {
        userId: req.user.id,
        name,
        relation: relation || 'friend',
        avatar: avatar || 'cat',
        color: color || 'indigo',
        birthDate: birthDate ? new Date(birthDate) : null,
        birthTime: birthTime || null,
        location: location || null,
        latitude: latitude ? parseFloat(latitude) : null,
        longitude: longitude ? parseFloat(longitude) : null,
        timezone: timezone || null,
      },
    });
    res.status(201).json(profile);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/user/profiles/:id', getUser, async (req, res) => {
  try {
    const existing = await prisma.profile.findFirst({
      where: { id: req.params.id, userId: req.user.id },
    });
    if (!existing) return res.status(404).json({ error: 'Profile not found' });
    const { name, relation, avatar, color, birthDate, birthTime, location, latitude, longitude, timezone } = req.body;
    const profile = await prisma.profile.update({
      where: { id: req.params.id },
      data: {
        name: name || undefined,
        relation: relation || undefined,
        avatar: avatar || undefined,
        color: color || undefined,
        birthDate: birthDate ? new Date(birthDate) : birthDate === null ? null : undefined,
        birthTime: birthTime !== undefined ? birthTime : undefined,
        location: location !== undefined ? location : undefined,
        latitude: latitude !== undefined ? parseFloat(latitude) : undefined,
        longitude: longitude !== undefined ? parseFloat(longitude) : undefined,
        timezone: timezone !== undefined ? timezone : undefined,
      },
    });
    res.json(profile);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/user/profiles/:id', getUser, async (req, res) => {
  try {
    const existing = await prisma.profile.findFirst({
      where: { id: req.params.id, userId: req.user.id },
    });
    if (!existing) return res.status(404).json({ error: 'Profile not found' });
    if (existing.relation === 'self') {
      return res.status(400).json({ error: 'Cannot delete your main profile' });
    }
    await prisma.profile.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Remedy Endpoints ────────────────────────────────────────────────

app.get('/api/user/remedies', getUser, async (req, res) => {
  try {
    const remedies = await prisma.remedy.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: 'desc' },
    });
    res.json(remedies);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/user/remedies', getUser, async (req, res) => {
  try {
    const { type, title, description, source, sourceRef } = req.body;
    if (!type || !title || !description) {
      return res.status(400).json({ error: 'type, title, and description are required' });
    }
    const remedy = await prisma.remedy.create({
      data: {
        userId: req.user.id,
        type,
        title,
        description,
        source: source || 'manual',
        sourceRef: sourceRef || null,
      },
    });
    res.status(201).json(remedy);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.patch('/api/user/remedies/:id/toggle', getUser, async (req, res) => {
  try {
    const remedy = await prisma.remedy.findFirst({
      where: { id: req.params.id, userId: req.user.id },
    });
    if (!remedy) {
      return res.status(404).json({ error: 'Remedy not found' });
    }
    const updated = await prisma.remedy.update({
      where: { id: req.params.id },
      data: { completed: !remedy.completed },
    });
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/user/remedies/:id', getUser, async (req, res) => {
  try {
    const remedy = await prisma.remedy.findFirst({
      where: { id: req.params.id, userId: req.user.id },
    });
    if (!remedy) {
      return res.status(404).json({ error: 'Remedy not found' });
    }
    await prisma.remedy.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/user/remedies/scan', getUser, async (req, res) => {
  try {
    const userId = req.user.id;
    const existing = await prisma.remedy.findMany({
      where: { userId },
      select: { title: true },
    });
    const existingTitles = new Set(existing.map(r => r.title.toLowerCase().trim()));
    const found = [];

    // Scan transit predictions
    const ad = await prisma.astrologyData.findUnique({
      where: { userId },
      select: { transitPredictions: true },
    });
    if (ad?.transitPredictions) {
      for (const [key, tp] of Object.entries(ad.transitPredictions)) {
        const entry = tp;
        if (entry.remedy && entry.remedy !== 'None needed' && entry.remedy !== 'None') {
          const title = extractRemedyTitle(entry.remedy);
          if (!existingTitles.has(title.toLowerCase().trim())) {
            const created = await prisma.remedy.create({
              data: { userId, type: inferRemedyType(entry.remedy), title, description: entry.remedy, source: 'transit_prediction', sourceRef: key },
            });
            found.push(created);
            existingTitles.add(title.toLowerCase().trim());
          }
        }
      }
    }

    // Scan chat messages
    const messages = await prisma.message.findMany({
      where: { conversation: { userId }, role: 'assistant' },
      select: { id: true, content: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    for (const msg of messages) {
      const remedies = parseRemediesFromText(msg.content);
      for (const r of remedies) {
        if (!existingTitles.has(r.title.toLowerCase().trim())) {
          const created = await prisma.remedy.create({
            data: { userId, type: r.type, title: r.title, description: r.description, source: 'ai_chat', sourceRef: msg.id },
          });
          found.push(created);
          existingTitles.add(r.title.toLowerCase().trim());
        }
      }
    }

    res.json({ scanned: true, found: found.length, remedies: found });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

function extractRemedyTitle(text) {
  const clean = text.replace(/^[-•*]\s*/, '').trim();
  const firstSentence = clean.split(/[.!]/)[0].trim();
  return firstSentence.length > 80 ? firstSentence.slice(0, 77) + '...' : firstSentence;
}

function inferRemedyType(text) {
  const lower = text.toLowerCase();
  if (lower.includes('mantra') || lower.includes('chant') || lower.includes('om ') || lower.includes('namah')) return 'mantra';
  if (lower.includes('gemstone') || lower.includes('sapphire') || lower.includes('ruby') || lower.includes('pearl') || lower.includes('coral') || lower.includes('emerald') || lower.includes('diamond') || lower.includes('stone') || lower.includes('wear')) return 'gemstone';
  if (lower.includes('donate') || lower.includes('charity') || lower.includes('give ') || lower.includes('feed')) return 'charity';
  if (lower.includes('fast') || lower.includes('diet') || lower.includes('exercise') || lower.includes('routine') || lower.includes('sleep')) return 'lifestyle';
  return 'ritual';
}

function parseRemediesFromText(text) {
  const results = [];

  // Format 1: HTML <ul> with remedy list items
  const ulRegex = /<ul[^>]*>([\s\S]*?)<\/ul>/gi;
  let ulMatch;
  while ((ulMatch = ulRegex.exec(text)) !== null) {
    const liRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
    let liMatch;
    while ((liMatch = liRegex.exec(ulMatch[1])) !== null) {
      const content = liMatch[1].replace(/<[^>]*>/g, '').trim();
      if (content && content.length > 5 && !content.toLowerCase().includes('remed')) {
        results.push({ title: extractRemedyTitle(content), description: content, type: inferRemedyType(content) });
      }
    }
  }

  // Format 2: Bold labels
  const labelRegex = /\*\*(?:Recommended Remedies|Lal Kitab Remedies|Mantras?)\*\*:\s*([\s\S]*?)(?=\n\*\*|$)/gi;
  let labelMatch;
  while ((labelMatch = labelRegex.exec(text)) !== null) {
    const content = labelMatch[1].replace(/<[^>]*>/g, '').trim();
    if (content && content.length > 5) {
      const items = content.split(/[.;]\s+/).filter(s => s.trim().length > 5);
      for (const item of items) {
        const clean = item.trim();
        results.push({ title: extractRemedyTitle(clean), description: clean, type: inferRemedyType(clean) });
      }
    }
  }

  // Format 3: Plain "Remedy:" prefix
  const plainRegex = /(?:^|\n)\s*(?:Remed(?:y|ies))\s*:\s*([\s\S]*?)(?=\n\s*(?:\w+)\s*:|$)/gi;
  let plainMatch;
  while ((plainMatch = plainRegex.exec(text)) !== null) {
    const content = plainMatch[1].replace(/<[^>]*>/g, '').trim();
    if (content && content.length > 5 && !content.toLowerCase().includes('none')) {
      const items = content.split(/[.;]\s+/).filter(s => s.trim().length > 5);
      for (const item of items) {
        const clean = item.trim();
        results.push({ title: extractRemedyTitle(clean), description: clean, type: inferRemedyType(clean) });
      }
    }
  }

  return results;
}

function optimizeAstroData(raw) {
  const getPlanet = (p) => ({
    sign: p.zodiac_sign_name,
    house: p.house_number,
    degree: Number(p.normDegree?.toFixed?.(2) ?? p.normDegree),
    nakshatra: p.nakshatra_name,
    retro: p.isRetro === 'true' || p.isRetro === true,
  });

  const planets = raw.natal;

  return {
    meta: {
      user_id: raw.userId,
      birth: {
        date: raw.birthDetails.date,
        time: raw.birthDetails.time,
        location: raw.birthDetails.location,
        lat: raw.birthDetails.latitude,
        lon: raw.birthDetails.longitude,
      },
    },

    natal: {
      ascendant: {
        sign: planets.Ascendant.zodiac_sign_name,
        degree: Number(planets.Ascendant.normDegree.toFixed(2)),
        nakshatra: planets.Ascendant.nakshatra_name,
      },

      sun: {
        sign: planets.Sun.zodiac_sign_name,
        house: planets.Sun.house_number,
        nakshatra: planets.Sun.nakshatra_name,
      },

      moon: {
        sign: planets.Moon.zodiac_sign_name,
        house: planets.Moon.house_number,
        nakshatra: planets.Moon.nakshatra_name,
      },

      key_planets: {
        venus: {
          ...getPlanet(planets.Venus),
          role: 'atmakaraka',
        },
        saturn: {
          ...getPlanet(planets.Saturn),
          role: 'yogakaraka',
        },
        mars: getPlanet(planets.Mars),
        mercury: getPlanet(planets.Mercury),
        jupiter: getPlanet(planets.Jupiter),
      },
    },

    dasha: {
      system: 'vimshottari',
      maha: raw.vimsottari?.activeMahaDasha?.dasha,
      antar: raw.vimsottari?.activeAntarDasha?.dasha,
      period: {
        maha_start: raw.vimsottari?.activeMahaDasha?.start_date,
        maha_end: raw.vimsottari?.activeMahaDasha?.end_date,
      },
    },

    transit: {
      focus_planets: {
        jupiter: {
          sign: raw.transit.Jupiter.zodiac_sign_name,
          house: raw.transit.Jupiter.house_number,
        },
        saturn: {
          sign: raw.transit.Saturn.zodiac_sign_name,
          house: raw.transit.Saturn.house_number,
        },
        rahu: {
          sign: raw.transit.Rahu.zodiac_sign_name,
          house: raw.transit.Rahu.house_number,
        },
        ketu: {
          sign: raw.transit.Ketu.zodiac_sign_name,
          house: raw.transit.Ketu.house_number,
        },
      },

      moon: {
        sign: raw.transit.Moon.zodiac_sign_name,
        house: raw.transit.Moon.house_number,
      },
    },

    derived: {
      atmakaraka: raw.specialPlanets.atmakaraka.name,
      darakaraka: raw.specialPlanets.darakaraka.name,
      yogakaraka: raw.specialPlanets.yogakaraka.name,
    },
  };
}

app.get('/api/astrology/summary', withProfile, async (req, res) => {
  const user = req.user;
  if (!user.birthDate || user.latitude === undefined) {
    return res.status(400).json({ error: 'User birth details missing' });
  }

  try {
    const now = new Date();

    // 1. Fetch Natal (D1) and Navamsa (D9)
    const [natal, navamsa] = await Promise.all([
      getAstroData(user, 'planets/extended', 'extended'),
      getAstroData(user, 'navamsa-chart-info', 'navamsa'),
    ]);

    // 2. Fetch Vimsottari Maha Dashas and identify active
    const mahaDashas = await getAstroData(
      user,
      'vimsottari/maha-dasas-and-antar-dasas',
      'mahaDashas',
    );

    const activeMahaDasha = mahaDashas.find((md) => {
      const start = new Date(md.start_date);
      const end = new Date(md.end_date);
      return now >= start && now <= end;
    });

    let activeAntarDasha = null;
    if (activeMahaDasha) {
      activeAntarDasha = activeMahaDasha.antar_dashas.find((ad) => {
        const start = new Date(ad.start_date);
        const end = new Date(ad.end_date);
        return now >= start && now <= end;
      });
    }

    // 3. Fetch Yogini Dashas and identify active
    let yoginiDashas;
    const existingData = user?._skipAstroCache ? null : await prisma.astrologyData.findUnique({
      where: { userId: user.id },
    });

    if (existingData?.yoginiDasha) {
      yoginiDashas = existingData.yoginiDasha;
    } else {
      yoginiDashas = await getYoginiDasha(new Date(user.birthDate));
      await prisma.astrologyData.upsert({
        where: { userId: user.id },
        update: { yoginiDasha: yoginiDashas },
        create: { userId: user.id, yoginiDasha: yoginiDashas },
      });
    }

    const activeYogini = yoginiDashas.find((yd) => {
      const start = new Date(yd.startDate);
      const end = new Date(yd.endDate);
      return now >= start && now <= end;
    });

    let activeYoginiAntar = null;
    if (activeYogini && activeYogini.antardashas) {
      activeYoginiAntar = activeYogini.antardashas.find((ad) => {
        const start = new Date(ad.startDate);
        const end = new Date(ad.endDate);
        return now >= start && now <= end;
      });
    }

    // 4. Fetch Transit (Today)
    const transit = await getAstroData(
      user,
      'planets/extended',
      'transit',
      true,
    );

    // 5. Calculate Special Planets (Karakas)
    const majorPlanets = [
      'Sun',
      'Moon',
      'Mars',
      'Mercury',
      'Jupiter',
      'Venus',
      'Saturn',
    ]
      .map((name) => ({
        name,
        degree: (natal[name]?.normDegree || 0) % 30,
        sign: natal[name]?.sign_number,
      }))
      .sort((a, b) => b.degree - a.degree);

    const atmakaraka = majorPlanets[0].name;
    const darakaraka = majorPlanets[6].name;
    // 6. Calculate Yogakaraka based on Ascendant sign
    const ascSign = natal?.Ascendant?.current_sign;
    const yogakarakaMap = {
      2: { name: 'Saturn', houses: '9th & 10th' }, // Taurus: 9 & 10
      4: { name: 'Mars', houses: '5th & 10th' }, // Cancer: 5 & 10
      5: { name: 'Mars', houses: '4th & 9th' }, // Leo: 4 & 9
      7: { name: 'Saturn', houses: '4th & 5th' }, // Libra: 4 & 5
      10: { name: 'Venus', houses: '5th & 10th' }, // Capricorn: 5 & 10
      11: { name: 'Venus', houses: '4th & 9th' }, // Aquarius: 4 & 9
    };

    const ykInfo = yogakarakaMap[ascSign];
    const yogakaraka = ykInfo
      ? {
          name: ykInfo.name,
          houses: ykInfo.houses,
          details: natal[ykInfo.name],
        }
      : null;

    const rawData = {
      userId: user.id,
      birthDetails: {
        date: user.birthDate,
        time: user.birthTime,
        location: user.location,
        latitude: user.latitude,
        longitude: user.longitude,
        timezone: user.timezone,
      },
      natal,
      navamsa,
      vimsottari: {
        activeMahaDasha,
        activeAntarDasha,
      },
      yogini: {
        activeYogini,
        activeYoginiAntar,
      },
      transit,
      specialPlanets: {
        atmakaraka: {
          name: atmakaraka,
          details: natal[atmakaraka],
        },
        darakaraka: {
          name: darakaraka,
          details: natal[darakaraka],
        },
        yogakaraka,
      },
    };
    res.json(optimizeAstroData(rawData));
  } catch (error) {
    console.error('Summary API error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Helper to prepare data for AI
const prepareAstroRawData = async (user) => {
  const currentUser = user?._skipAstroCache
    ? user
    : await prisma.user.findUnique({
        where: { id: user.id },
      });
  if (!currentUser) throw new Error('User not found');

  // Fetch global transit cache (same for all users in same timezone)
  const globalTransit = await prisma.transitCache.findUnique({
    where: { timezone: currentUser.timezone || '5.5' },
  });
  const now = new Date();
  const ONE_DAY = 24 * 60 * 60 * 1000;
  const isGlobalTransitFresh =
    globalTransit &&
    now.getTime() - new Date(globalTransit.updatedAt).getTime() < ONE_DAY;

  // Always fetch fresh data - no user-specific caching
  // This ensures always correct data, especially after profile updates
  const [natal, mahaDashas, transit, yoginiDashas] = await Promise.all([
    getAstroData(currentUser, 'planets/extended', 'extended'),
    getAstroData(
      currentUser,
      'vimsottari/maha-dasas-and-antar-dasas',
      'mahaDashas',
    ),
    isGlobalTransitFresh
      ? globalTransit.data
      : getAstroData(currentUser, 'planets/extended', 'transit', true),
    getYoginiDasha(new Date(currentUser.birthDate)),
  ]);

  // Save fetched data to DB for other endpoints that use it
  const existing = user?._skipAstroCache
    ? null
    : await prisma.astrologyData.findUnique({
        where: { userId: currentUser.id },
      });
  if (!user?._skipAstroCache) {
    await prisma.astrologyData.upsert({
      where: { userId: currentUser.id },
      update: {
        extended: natal,
        mahaDashas: mahaDashas,
        yoginiDasha: yoginiDashas,
      },
      create: {
        userId: currentUser.id,
        extended: natal,
        mahaDashas: mahaDashas,
        yoginiDasha: yoginiDashas,
      },
    });
  }

  // Helper for finding active dasha
  const findActive = (list, startKey, endKey) =>
    list?.find((item) => {
      const s = new Date(item[startKey]);
      const e = new Date(item[endKey]);
      return now >= s && now <= e;
    });

  const activeMahaDasha = findActive(mahaDashas, 'start_date', 'end_date');
  const activeAntarDasha = activeMahaDasha
    ? findActive(activeMahaDasha.antar_dashas, 'start_date', 'end_date')
    : null;

  const activeYogini = findActive(yoginiDashas, 'startDate', 'endDate');
  const activeYoginiAntar = activeYogini
    ? findActive(activeYogini.antardashas, 'startDate', 'endDate')
    : null;

  return {
    natal,
    vimsottari: { activeMahaDasha, activeAntarDasha, allDashas: mahaDashas },
    yogini: { activeYogini, activeYoginiAntar, allDashas: yoginiDashas },
    transit,
    aiPersona: existing?.aiPersona,
  };
};

app.post('/api/astrology/ai-feed', withProfile, async (req, res) => {
  const user = req.user;
  const { question } = req.body;

  if (!question) {
    return res.status(400).json({ error: 'Question is required' });
  }

  if (!user.birthDate || user.latitude === undefined) {
    return res.status(400).json({ error: 'User birth details missing' });
  }

  try {
    const rawData = await prepareAstroRawData(user);

    const result = await processUserQuery({
      question,
      rawData,
      callQwen: askQwenLib,
      memory: [], // Single-shot query, no memory
    });

    res.json(result);
  } catch (error) {
    console.error('AI-Feed API error:', error);
    res.status(500).json({ error: error.message });
  }
});

// AI Chat history endpoints
app.get('/api/ai/knowledge-sources', getUser, async (req, res) => {
  try {
    let counts = {};
    try {
      const rows = await prisma.$queryRaw`
        SELECT source, COUNT(*)::int AS count
        FROM knowledge_chunk
        GROUP BY source
      `;
      counts = Object.fromEntries(rows.map((r) => [r.source, Number(r.count)]));
    } catch (error) {
      console.error('Knowledge chunk count query failed:', error.message);
    }
    const sources = Object.entries(KNOWLEDGE_SOURCES).map(([key, cfg]) => ({
      key,
      label: cfg.label,
      chunkCount: cfg.sources.reduce(
        (acc, s) => acc + (counts[s] || 0),
        0,
      ),
    }));
    res.json(sources);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/ai/conversations', getUser, async (req, res) => {
  try {
    const conversations = await prisma.conversation.findMany({
      where: { userId: req.user.id },
      orderBy: { updatedAt: 'desc' },
    });
    res.json(conversations);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/ai/conversations/:id', getUser, async (req, res) => {
  try {
    const conversation = await prisma.conversation.findFirst({
      where: { id: req.params.id, userId: req.user.id },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    res.json(conversation);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// AI Chat endpoint (consumes coins)
app.post('/api/ai/chat', withProfile, async (req, res) => {
  const { message, conversationId } = req.body;

  try {
    const user = req.user;

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (user.coins <= 0) {
      return res
        .status(403)
        .json({ error: 'Insufficient coins. Please claim your daily coin.' });
    }

    // Deduct 1 coin
    await prisma.user.update({
      where: { id: req.user.id },
      data: { coins: user.coins - 1 },
    });

    let conversation;
    if (conversationId) {
      conversation = await prisma.conversation.findFirst({
        where: { id: conversationId, userId: user.id },
      });
    }

    if (!conversation) {
      conversation = await prisma.conversation.create({
        data: {
          userId: user.id,
          title: message.substring(0, 50),
        },
      });
    } else {
      // Update title if it's the default or just update timestamp
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { updatedAt: new Date() },
      });
    }

    // Store user message
    const userMessage = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        role: 'user',
        content: message,
      },
    });

    // Fetch previous context (excluding the message we just added)
    const previousMessages = await prisma.message.findMany({
      where: {
        conversationId: conversation.id,
        id: { not: userMessage.id },
      },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });

    // Reverse to get chronological order
    const memory = previousMessages
      .reverse()
      .map((m) => ({ role: m.role, content: m.content }));

    // 1. Fetch Astrology Data & Classification
    console.log('Fetching Astrology Data & Classification...');
    const rawData = await prepareAstroRawData(user);
    console.log('Astrology Data & Classification fetched successfully');
    console.log('👺 Processing User Query...');
    const feedResult = await processUserQuery({
      question: message,
      rawData,
      callQwen: askQwenLib,
      memory,
    });
    console.log('✅ User Query processed successfully');
    console.log('🚀 Building Master Prompt...');
    const masterPrompt = await buildMasterPrompt({
      classification: feedResult.classification,
      payload: feedResult.payload,
      memory,
    });
    console.log('✅ Master Prompt built successfully');
    const qwenChatId = conversation.qwenChatId || null;
    let aiResponse = '';
    let qwenResult = null; // Declare outside try block
    try {
      console.log('👺 Processing Qwen with Master Prompt...');
      qwenResult = await askQwenLib(masterPrompt, qwenChatId);
      aiResponse = qwenResult.response;
      if (qwenResult.conversationId && !conversation.qwenChatId) {
        await prisma.conversation.update({
          where: { id: conversation.id },
          data: { qwenChatId: qwenResult.conversationId },
        });
      }
      const jsonResponse = safeParseJSON(aiResponse, {
        summary:
          "I'm sorry, I'm currently unable to access my celestial insights. Please try again later.",
        time_context: 'N/A',
        astrological_analysis: 'N/A',
        timeline_breakdown: 'N/A',
        real_world_impact: 'N/A',
        practical_guidance: 'N/A',
      });
      const fullText = [
        jsonResponse.summary,
        jsonResponse.time_context,
        jsonResponse.astrological_analysis,
        jsonResponse.timeline_breakdown,
        jsonResponse.real_world_impact,
        jsonResponse.practical_guidance,
      ].join('\n\n');
      aiResponse = fullText;
      console.log('✅ Qwen response received successfully');
    } catch (err) {
      console.error('Qwen Error:', err);
      aiResponse =
        "I'm sorry, I'm currently unable to access my celestial insights. Please try again later.";
    }

    // We only save user chat to the db as requested
    // (Assistant message not saved for now)
    // post it to the db
    console.log('👺 Saving Qwen response to database...');
    await prisma.message.create({
      data: {
        conversationId: conversation.id,
        role: 'assistant',
        content: aiResponse,
      },
    });
    console.log('✅ Qwen response saved successfully');
    const returnedQwenChatId =
      qwenResult?.conversationId || conversation.qwenChatId;
    res.json({
      response: aiResponse,
      coinsLeft: user.coins - 1,
      conversationId: conversation.id,
      qwenChatId: returnedQwenChatId,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// AI Chat 2 endpoint (single-pass prompt)
app.post('/api/ai/chat2', withProfile, async (req, res) => {
  const { message, conversationId } = req.body;
  console.log('--- AI Chat 2 Start ---');
  console.log('Message:', message);

  try {
    const user = req.user;

    if (!user) {
      console.log('❌ User not found');
      return res.status(404).json({ error: 'User not found' });
    }

    if (user.coins <= 0) {
      console.log('❌ Insufficient coins');
      return res
        .status(403)
        .json({ error: 'Insufficient coins. Please claim your daily coin.' });
    }

    // Deduct 1 coin
    await prisma.user.update({
      where: { id: req.user.id },
      data: { coins: user.coins - 1 },
    });
    console.log('💰 Coin deducted. Remaining:', user.coins - 1);

    let conversation;
    if (conversationId) {
      conversation = await prisma.conversation.findFirst({
        where: { id: conversationId, userId: user.id },
      });
    }

    if (!conversation) {
      conversation = await prisma.conversation.create({
        data: {
          userId: user.id,
          title: message.substring(0, 50),
        },
      });
      console.log('🆕 New conversation created:', conversation.id);
    } else {
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { updatedAt: new Date() },
      });
      console.log('🔄 Existing conversation updated:', conversation.id);
    }

    // Store user message
    const userMessage = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        role: 'user',
        content: message,
      },
    });

    // Fetch previous context
    const previousMessages = await prisma.message.findMany({
      where: {
        conversationId: conversation.id,
        id: { not: userMessage.id },
      },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });

    const memory = previousMessages.reverse().map((m) => {
      let content = m.content;
      if (m.role === 'assistant') {
        // If it's the assistant, only take the first paragraph or first 200 characters
        const paragraphs = m.content.split('\n\n');
        const firstPara = paragraphs[0] || '';
        content =
          firstPara.length > 200
            ? firstPara.substring(0, 200) + '...'
            : firstPara;
      }
      return { role: m.role, content };
    });
    console.log(
      '🧠 Memory retrieved (summarized assistant msgs), items:',
      memory.length,
    );

    // Fetch Astrology Data
    console.log('🔭 Fetching Astrology Data...');
    const rawData = await prepareAstroRawData(user);
    delete rawData.transit;
    console.log('✅ Astrology Data fetched');

    // Build Master Prompt V4 (Single-pass, Enriched)
    const masterPrompt = await buildMasterPromptV4({
      question: message,
      memory,
      rawData,
    });

    let aiResponse = '';
    try {
      console.log('👺 Sending Master Prompt V4 to Gemini...');
      const geminiResult = await geminiService.ask(masterPrompt);
      aiResponse = geminiResult.content;

      const jsonResponse = safeParseJSON(aiResponse, {
        paragraph_1:
          "I'm sorry, I'm currently unable to access my celestial insights. Please try again later.",
        paragraph_2: 'N/A',
        paragraph_3: 'N/A',
        paragraph_4: 'N/A',
      });

      const fullText = [
        jsonResponse.paragraph_1,
        jsonResponse.paragraph_2,
        jsonResponse.paragraph_3,
        jsonResponse.paragraph_4,
      ].join('\n\n');
      aiResponse = fullText;
      console.log('✅ Gemini response received and parsed');
    } catch (err) {
      console.error('🔥 Gemini Error:', err);
      aiResponse =
        "I'm sorry, I'm currently unable to access my celestial insights. Please try again later.";
    }

    // Save response
    await prisma.message.create({
      data: {
        conversationId: conversation.id,
        role: 'assistant',
        content: aiResponse,
      },
    });
    console.log('💾 Assistant response saved to DB');

    console.log('--- AI Chat 2 Complete ---');
    res.json({
      response: aiResponse,
      coinsLeft: user.coins - 1,
      conversationId: conversation.id,
    });
  } catch (error) {
    console.error('💥 AI-Chat2 API error:', error);
    res.status(500).json({ error: error.message });
  }
});

// AI Chat 5 endpoint (HTML Output)
app.post('/api/ai/chat5', withProfile, async (req, res) => {
  const { message, conversationId } = req.body;
  console.log('--- AI Chat 5 Start ---');
  console.log('Message:', message);

  try {
    const user = req.user;

    if (!user) {
      console.log('❌ User not found');
      return res.status(404).json({ error: 'User not found' });
    }

    if (user.coins <= 0) {
      console.log('❌ Insufficient coins');
      return res
        .status(403)
        .json({ error: 'Insufficient coins. Please claim your daily coin.' });
    }

    // Deduct 1 coin
    await prisma.user.update({
      where: { id: req.user.id },
      data: { coins: user.coins - 1 },
    });
    console.log('💰 Coin deducted. Remaining:', user.coins - 1);

    let conversation;
    if (conversationId) {
      conversation = await prisma.conversation.findFirst({
        where: { id: conversationId, userId: user.id },
      });
    }

    if (!conversation) {
      conversation = await prisma.conversation.create({
        data: {
          userId: user.id,
          title: message.substring(0, 50),
        },
      });
      console.log('🆕 New conversation created:', conversation.id);
    } else {
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { updatedAt: new Date() },
      });
      console.log('🔄 Existing conversation updated:', conversation.id);
    }

    // Store user message
    const userMessage = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        role: 'user',
        content: message,
      },
    });

    // Fetch previous context
    const previousMessages = await prisma.message.findMany({
      where: {
        conversationId: conversation.id,
        id: { not: userMessage.id },
      },
      orderBy: { createdAt: 'desc' },
      take: 8,
    });

    const historyString = previousMessages.reverse().map((m) => {
      let content = m.content;
      if (m.role === 'assistant') {
        // Simple summary for memory efficiency
        content =
          m.content.length > 150
            ? m.content.substring(0, 150) + '...'
            : m.content;
      }
      return { role: m.role, content };
    });
    const memory = historyString
      .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
      .join('\n');

    // Fetch Astrology Data
    console.log('🔭 Fetching Astrology Data...');
    console.log('User', user);
    const rawData = await prepareAstroRawData(user);
    console.log('✅ Astrology Data fetched');

    // Build Master Prompt V5
    const masterPrompt = await buildMasterPromptV5({
      question: message,
      memory,
      rawData,
    });

    let aiResponse = '';
    try {
      console.log('👺 Sending Master Prompt V5 to Gemini...');
      const geminiResult = await geminiService.ask(masterPrompt);
      aiResponse = geminiResult.content;

      // Clean up potential markdown backticks
      aiResponse = aiResponse.replace(/```html|```/g, '').trim();

      console.log('✅ Gemini response received (HTML)');
    } catch (err) {
      console.error('🔥 Gemini Error:', err);
      aiResponse =
        "<div class='error'>I'm sorry, I'm currently unable to access my celestial insights. Please try again later.</div>";
    }
    console.log('Ai response', {
      conversationId: conversation.id,

      aiResponse,
    });
    // Save response
    await prisma.message.create({
      data: {
        conversationId: conversation.id,
        role: 'assistant',
        content: aiResponse,
      },
    });
    console.log('💾 Assistant response saved to DB');

    console.log('--- AI Chat 5 Complete ---');
    res.json({
      response: aiResponse,
      coinsLeft: user.coins - 1,
      conversationId: conversation.id,
    });
  } catch (error) {
    console.error('💥 AI-Chat5 API error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Knowledge search endpoint
app.get('/api/knowledge/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.length < 2) return res.json({ results: [] });

    const terms = q.replace(/[^a-zA-Z0-9\s]/g, '').split(/\s+/).filter(Boolean);
    if (terms.length === 0) return res.json({ results: [] });

    const patterns = terms.map(t => `%${t}%`);
    const tagPatterns = [...patterns];

    const results = await prisma.$queryRaw`
      SELECT id, source, chapter, title, content, tags
      FROM knowledge_chunk
      WHERE content ILIKE ANY(ARRAY[${patterns}])
         OR tags ILIKE ANY(ARRAY[${tagPatterns}])
      ORDER BY
        CASE WHEN content ILIKE ALL(ARRAY[${patterns}]) THEN 1
             WHEN title ILIKE ANY(ARRAY[${patterns}]) THEN 2
             ELSE 3
        END
      LIMIT 8
    `;

    const serialized = results.map(r => ({
      ...r,
      content: r.content.length > 600 ? r.content.slice(0, 600) + '...' : r.content,
    }));

    res.json({ results: serialized });
  } catch (error) {
    console.error('Knowledge search error:', error);
    res.status(500).json({ error: error.message });
  }
});

// AI Chat 6 endpoint (Gemma/Google AI SDK - HTML Output)
app.post('/api/ai/chat6', withProfile, async (req, res) => {
  const { message, conversationId, profileId, knowledgeSource } = req.body;
  console.log('--- AI Chat 6 (Gemma) Start ---');
  console.log('Message:', message);

  try {
    const user = req.user;

    if (!user) {
      console.log('❌ User not found');
      return res.status(404).json({ error: 'User not found' });
    }

    if (user.coins <= 0) {
      console.log('❌ Insufficient coins');
      return res
        .status(403)
        .json({ error: 'Insufficient coins. Please claim your daily coin.' });
    }

    // Deduct 1 coin
    await prisma.user.update({
      where: { id: req.user.id },
      data: { coins: user.coins - 1 },
    });
    console.log('💰 Coin deducted. Remaining:', user.coins - 1);

    let conversation;
    if (conversationId) {
      conversation = await prisma.conversation.findFirst({
        where: { id: conversationId, userId: user.id },
      });
    }

    if (!conversation) {
      conversation = await prisma.conversation.create({
        data: {
          userId: user.id,
          title: message.substring(0, 50),
          profileId: profileId ?? null,
          knowledgeSource: knowledgeSource ?? null,
        },
      });
      console.log('🆕 New conversation created:', conversation.id);
    } else {
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { updatedAt: new Date() },
      });
      console.log('🔄 Existing conversation updated:', conversation.id);

      // Lock the conversation to its chart: resolve the chart owner from the
      // stored profileId regardless of the currently-active profile.
      if (conversation.profileId && conversation.profileId !== profileId) {
        const lockedProfile = await prisma.profile
          .findFirst({ where: { id: conversation.profileId, userId: user.id } })
          .catch(() => null);
        if (lockedProfile) {
          const { id, userId, createdAt, updatedAt, ...profileData } = lockedProfile;
          req.user = { ...user, ...profileData, _skipAstroCache: true };
        }
      }
    }

    // Store user message
    await prisma.message.create({
      data: {
        conversationId: conversation.id,
        role: 'user',
        content: message,
      },
    });

    // Fetch Astrology Data (locked to the conversation's chart)
    console.log('🔭 Fetching Astrology Data...');
    const rawData = await prepareAstroRawData(req.user);
    console.log('✅ Astrology Data fetched');

    // Search the conversation's selected knowledge base
    const knowledgeLabel = getSourceLabel(conversation.knowledgeSource);
    const sourceFilter = getSourceFilter(conversation.knowledgeSource);
    const knowledgeInstruction = getSourceInstruction(conversation.knowledgeSource);
    let parasaraContext = '';
    try {
      const terms = message
        .replace(/[^a-zA-Z0-9\s]/g, '')
        .split(/\s+/)
        .filter(w => w.length > 3)
        .slice(0, 4);
      if (sourceFilter && terms.length > 0) {
        const patterns = terms.map(t => `%${t}%`);
        const chunks = await prisma.$queryRaw`
          SELECT source, chapter, title, content, tags
          FROM knowledge_chunk
          WHERE source = ANY(ARRAY[${sourceFilter}])
            AND (content ILIKE ANY(ARRAY[${patterns}])
             OR tags ILIKE ANY(ARRAY[${patterns}]))
          LIMIT 5
        `;
        if (chunks.length > 0) {
          parasaraContext = chunks
            .map(c => `[${c.source} | ${c.chapter} | ${c.title}]\n${c.content.length > 800 ? c.content.slice(0, 800) + '...' : c.content}`)
            .join('\n\n---\n\n');
          console.log(`📚 ${knowledgeLabel || conversation.knowledgeSource} context: ${chunks.length} chunks`);
        }
      } else {
        console.log(`📚 No knowledge base selected for this conversation`);
      }
    } catch (err) {
      console.error('Knowledge base search error:', err);
    }

    // Build Master Prompt V5
    const masterPrompt = await buildMasterPromptV5({
      question: message,
      memory: '',
      rawData,
      parasaraContext,
      knowledgeLabel,
      knowledgeInstruction,
    });

    let aiResponse = '';
    try {
      console.log('👺 Sending Master Prompt V5 to Gemma...');
      aiResponse = await gemmaService.ask(masterPrompt);

      // Sanitize: ensure content starts from <div class="astrology-response"> tag
      const astrologyResponseTag = '<div class="astrology-response">';
      const lastIndex = aiResponse.lastIndexOf(astrologyResponseTag);
      if (lastIndex !== -1) {
        aiResponse = aiResponse.substring(lastIndex);
      }

      console.log('✅ Gemini Web response received');
    } catch (err) {
      console.error('🔥 Gemini Web Error:', err);
      aiResponse =
        "<div class='error'>I'm sorry, I'm currently unable to access my celestial insights. Please try again later.</div>";
    }

    // Save response
    await prisma.message.create({
      data: {
        conversationId: conversation.id,
        role: 'assistant',
        content: aiResponse,
      },
    });
    console.log('💾 Assistant response saved to DB');

    console.log('--- AI Chat 6 (Gemini Web) Complete ---');
    res.json({
      response: aiResponse,
      coinsLeft: user.coins - 1,
      conversationId: conversation.id,
    });
  } catch (error) {
    console.error('💥 AI-Chat6 API error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/ai/persona', getUser, async (req, res) => {
  try {
    const user = req.user;

    // Check if persona already exists in AstrologyData
    const existingData = user?._skipAstroCache ? null : await prisma.astrologyData.findUnique({
      where: { userId: user.id },
      select: { aiPersona: true },
    });

    if (existingData?.aiPersona) {
      return res.json({ persona: existingData.aiPersona });
    }

    // Generate new persona
    if (!user.birthDate || user.latitude === undefined) {
      return res.status(400).json({ error: 'User birth details missing' });
    }

    console.log('🔭 Generating Persona Analysis for:', user.id);
    const rawData = await prepareAstroRawData(user);

    // Only use natal chart data as requested
    const natalData = rawData.natal;
    const personaPrompt = MASTER_PROMPT_TEMPLATE_PERSONALITY_GEMINI.replace(
      '{{payload}}',
      JSON.stringify(natalData, null, 2),
    );

    const geminiResult = await geminiService.ask(personaPrompt);
    const aiResponse = geminiResult.content;

    // The template asks for raw HTML, so we store it directly.
    // We remove any potential markdown backticks that Gemini might add despite instructions.
    const cleanHtml = aiResponse.replace(/```html|```/g, '').trim();

    await prisma.astrologyData.upsert({
      where: { userId: user.id },
      update: { aiPersona: cleanHtml },
      create: { userId: user.id, aiPersona: cleanHtml },
    });

    console.log('✅ Persona Analysis generated and stored');
    res.json({ persona: cleanHtml });
  } catch (error) {
    console.error('💥 AI-Persona API error:', error);
    res.status(500).json({ error: error.message });
  }
});

const ZODIAC_SIGNS = [
  'Aries','Taurus','Gemini','Cancer','Leo','Virgo',
  'Libra','Scorpio','Sagittarius','Capricorn','Aquarius','Pisces',
];

// AI Transit Prediction endpoints (free, no coin deduction)
app.get('/api/ai/transit-prediction', getUser, async (req, res) => {
  try {
    const userData = await prisma.astrologyData.findUnique({
      where: { userId: req.user.id },
      select: { transitPredictions: true },
    });
    res.json(userData?.transitPredictions || {});
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/ai/transit-prediction', getUser, async (req, res) => {
  const { transitType } = req.body;
  const validTypes = ['global', 'lagna', 'chandra'];
  if (!validTypes.includes(transitType)) {
    return res.status(400).json({ error: 'Invalid transit type' });
  }

  try {
    const user = req.user;
    const today = new Date().toISOString().slice(0, 10);
    const cacheKey = `${transitType}_${today}`;

    const userData = await prisma.astrologyData.findUnique({
      where: { userId: user.id },
      select: { transitPredictions: true },
    });
    const existing = userData?.transitPredictions?.[cacheKey];
    if (existing?.prediction) {
      return res.json(existing);
    }

    const timezone = user.timezone || '5.5';
    const ONE_DAY = 24 * 60 * 60 * 1000;

    let chartData = null;

    if (transitType === 'global') {
      const cachedTransit = await prisma.transitCache.findUnique({
        where: { timezone: timezone.toString() },
      });
      if (cachedTransit && Date.now() - new Date(cachedTransit.updatedAt).getTime() < ONE_DAY) {
        chartData = cachedTransit.data;
      } else {
        chartData = await getAstroData(user, 'planets/extended', 'transit', true, false);
      }
    } else {
      const ad = await prisma.astrologyData.findUnique({
        where: { userId: user.id },
      });
      if (ad) {
        if (transitType === 'lagna') chartData = ad.lagnaGochar;
        else chartData = ad.chandraGochar;
      }
      if (!chartData) {
        const transitRaw = await getAstroData(user, 'planets/extended', 'transit', true, false);
        const planetMap = toPlanetMap(transitRaw?.output || transitRaw);
        const natalData = await getAstroData(user, 'planets/extended', 'natal', false, false);
        const refSign = transitType === 'lagna'
          ? natalData?.Ascendant?.current_sign
          : natalData?.Moon?.current_sign;
        if (!refSign) throw new Error(`Natal ${transitType === 'lagna' ? 'Ascendant' : 'Moon'} sign not found`);
        chartData = shiftChartRelativeTo(planetMap, refSign);
      }
    }

    const planetLines = Object.entries(chartData || {})
      .filter(([name]) => !['Ascendant', 'MC', 'Descendant', 'IC'].includes(name))
      .map(([name, p]) => {
        const sign = p.zodiac_sign_name || ZODIAC_SIGNS[(p.current_sign || p.sign_number || 1) - 1] || '';
        const retro = p.isRetro === 'true' ? ' (R)' : '';
        const house = p.house_number || '';
        return `${name}: ${((p.normDegree || 0) % 30).toFixed(1)}° ${sign}, House ${house}${retro}`;
      })
      .join('\n');

    const typeLabels = {
      global: 'Global Transit (current sky positions for your location)',
      lagna: 'Lagna Gochar (transit relative to your Ascendant sign)',
      chandra: 'Chandra Gochar (transit relative to your Moon sign)',
    };

    const prompt = `You are a master Vedic astrologer. Analyze these transit planetary positions for ${typeLabels[transitType]}:

${planetLines}

Provide a brief, insightful prediction about the current cosmic energies and how they may affect the person. If there are challenging aspects that call for a remedy, suggest one simple Vedic remedy (mantra, gemstone, or practice). 

Format your response EXACTLY as follows (keep each section concise — 2-4 sentences each):

PREDICTION:
(Your astrological prediction here)

REMEDY:
(Specific remedy or "None needed" if the transits are generally favorable)`;

    const aiResponse = await gemmaService.ask(prompt);
    const predictionMatch = aiResponse.match(/PREDICTION:\s*([\s\S]*?)(?=REMEDY:|$)/i);
    const remedyMatch = aiResponse.match(/REMEDY:\s*([\s\S]*)/i);

    const result = {
      prediction: predictionMatch ? predictionMatch[1].trim() : aiResponse.trim(),
      remedy: remedyMatch ? remedyMatch[1].trim() : null,
    };

    await prisma.astrologyData.upsert({
      where: { userId: user.id },
      update: {
        transitPredictions: {
          ...(userData?.transitPredictions || {}),
          [cacheKey]: result,
        },
      },
      create: {
        userId: user.id,
        transitPredictions: { [cacheKey]: result },
      },
    });

    res.json(result);
  } catch (error) {
    console.error('Transit prediction error:', error);
    res.status(500).json({ error: error.message || 'Failed to generate prediction' });
  }
});

xalen.init().then(() => {
  app.listen(port, () => {
    console.log(`Server running on port ${port}: URL: http://localhost:${port}`);
  });
}).catch(err => {
  console.error('Failed to initialize XALEN ephemeris:', err);
  process.exit(1);
});

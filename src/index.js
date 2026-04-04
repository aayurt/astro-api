import pkg from '@prisma/client';
const { PrismaClient } = pkg;
import { toNodeHandler } from 'better-auth/node';
import cors from 'cors';
import 'dotenv/config';
import express from 'express';
import {
  buildMasterPrompt,
  processUserQuery,
  safeParseJSON,
} from './lib/ai-agent.js';
import { getYoginiDasha } from './lib/astrology.js';
import { auth } from './lib/auth.js';
import { askQwen as askQwenLib } from './lib/qwen.js';
import { trustedOrigins } from './trustedDomains.js';

const prisma = new PrismaClient();

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
const authHandler = toNodeHandler(auth);

app.all('/api/auth/*path', async (req, res, next) => {
  try {
    console.log('=======\n', req.url);
    console.log('=======', req.path);
    return auth.handler(req, res);
  } catch (err) {
    console.error('Better Auth error:', err);
    next(err);
  }
});

app.use(express.json());

// Middleware to get user from auth session
const getUser = async (req, res, next) => {
  const session = await auth.api.getSession({
    headers: new Headers(req.headers),
  });
  if (!session) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  req.user = session.user;
  next();
};

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

// Astrology API Endpoints
// 🔥 In-memory key block tracking
const keyState = new Map();

const isKeyAvailable = (key) => {
  const state = keyState.get(key);
  if (!state) return true;
  return Date.now() > state.blockedUntil;
};

const blockKey = (key, duration = 60 * 60 * 1000) => {
  keyState.set(key, {
    blockedUntil: Date.now() + duration,
  });
};

const getAstroData = async (
  user,
  endpoint,
  type = null,
  useCurrentTime = false,
) => {
  // ✅ STEP 1: Check cache (NO expiry, except for transit)
  if (type && type !== 'transit') {
    const existing = await prisma.astrologyData.findUnique({
      where: { userId: user.id },
    });

    if (existing && existing[type]) {
      console.log('✅ Returning cached astrology data');
      return existing[type];
    }
  }

  // 🔧 Prepare payload
  const dateToUse = useCurrentTime ? new Date() : new Date(user.birthDate);
  const [hours, minutes] = useCurrentTime
    ? [dateToUse.getHours(), dateToUse.getMinutes()]
    : (user.birthTime || '12:00').split(':').map(Number);

  const payload = {
    year: dateToUse.getFullYear(),
    month: dateToUse.getMonth() + 1,
    date: dateToUse.getDate(),
    hours: hours,
    minutes: minutes || 0,
    seconds: dateToUse.getSeconds() || 0,
    latitude: user.latitude,
    longitude: user.longitude,
    timezone: parseFloat(user.timezone || '5.5'),
    config: {
      observation_point: 'topocentric',
      ayanamsha: 'lahiri',
    },
  };

  const apiKeys = [
    process.env.ASTRO_API_KEY,
    process.env.ASTRO_API_KEY_1,
    process.env.ASTRO_API_KEY_2,
  ].filter(Boolean);

  let response;
  let lastError = null;

  // 🔁 STEP 2: Try only AVAILABLE keys
  for (const key of apiKeys) {
    if (!isKeyAvailable(key)) {
      console.log(`⏭ Skipping blocked key: ${key.substring(0, 5)}...`);
      continue;
    }

    try {
      response = await fetch(`https://json.freeastrologyapi.com/${endpoint}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': key,
        },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        console.log(`✅ Success with key: ${key.substring(0, 5)}...`);
        lastError = null;
        break;
      }

      // ❌ Handle API error
      const error = await response.json().catch(() => ({}));
      lastError = error;

      console.log(
        `❌ Key failed: ${key.substring(0, 5)}..., Status: ${response.status}, Error: ${
          error.error || error.message || 'Unknown'
        }`,
      );

      // 🚨 Block key if rate limited
      if (
        response.status === 429 ||
        error?.message?.toLowerCase().includes('limit')
      ) {
        console.log(`⛔ Blocking key (rate limit): ${key.substring(0, 5)}...`);
        blockKey(key);
      }
    } catch (err) {
      lastError = { message: err.message };
      console.log(
        `🔥 Fetch failed with key: ${key.substring(0, 5)}..., Error: ${err.message}`,
      );
    }
  }

  // ❌ If all keys failed
  if (!response || !response.ok) {
    throw new Error(
      `Astro API error: ${
        response ? response.statusText : 'All keys failed'
      } - ${JSON.stringify(lastError)}`,
    );
  }

  // ✅ STEP 3: Process response
  const data = await response.json();

  let processedData = data;

  if (data && data.output && type === 'mahaDashas') {
    const rawDashas =
      typeof data.output === 'string' ? JSON.parse(data.output) : data.output;
    processedData = Object.entries(rawDashas).map(([mahaName, antarObj]) => {
      const antarDashas = Object.entries(antarObj).map(
        ([antarName, times]) => ({
          dasha: antarName,
          start_date: times.start_time,
          end_date: times.end_time,
        }),
      );

      return {
        dasha: mahaName,
        start_date: antarDashas[0]?.start_date || '',
        end_date: antarDashas[antarDashas.length - 1]?.end_date || '',
        antar_dashas: antarDashas,
      };
    });
  } else if (
    data &&
    data.output &&
    (type === 'dashaInfo' || type === 'transit')
  ) {
    processedData =
      typeof data.output === 'string' ? JSON.parse(data.output) : data.output;
  }
  // Transform any response that contains an 'output' array or numeric-keyed object into a named map
  // This applies to planets, planets-extended, natal-chart, and navamsa-chart
  if (
    data &&
    data.output &&
    ['planets', 'extended', 'natal', 'navamsa'].includes(type)
  ) {
    const rawData = Array.isArray(data.output)
      ? data.output[1] &&
        typeof data.output[1] === 'object' &&
        !Array.isArray(data.output[1])
        ? Object.entries(data.output[1]).map(([name, val]) => ({
            name,
            ...val,
          }))
        : data.output[0] && typeof data.output[0] === 'object'
          ? Object.values(data.output[0])
          : data.output
      : Object.values(data.output);

    const namedMap = {};
    rawData.forEach((item) => {
      if (
        item &&
        (item.name || item.localized_name || (item.planet && item.planet.en))
      ) {
        const name =
          item.name || item.localized_name || (item.planet && item.planet.en);
        const { name: _n, ...details } = item;
        namedMap[name] = details;
      }
    });

    processedData = namedMap;
  }

  // ✅ STEP 4: Save to DB
  if (type) {
    await prisma.astrologyData.upsert({
      where: { userId: user.id },
      update: { [type]: processedData },
      create: { userId: user.id, [type]: processedData },
    });
  }

  return processedData;
};

app.get('/api/astrology/planets', getUser, async (req, res) => {
  const user = req.user;

  if (!user.birthDate || user.latitude === undefined) {
    return res.status(400).json({ error: 'User birth details missing' });
  }

  try {
    // Check DB first
    const existing = await prisma.astrologyData.findUnique({
      where: { userId: user.id },
    });
    if (existing?.planets) {
      console.log('✅ DB: Fetched data for planets');
      return res.json(existing.planets.output[1]);
    }
    console.log('↻ API: Fetching new data for planets');
    const data = await getAstroData(user, 'planets', 'planets');
    console.log('✅ API: Fetched new data for planets');

    res.json(data.output[1]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/astrology/planets-extended', getUser, async (req, res) => {
  const user = req.user;
  if (!user.birthDate || user.latitude === undefined) {
    return res.status(400).json({ error: 'User birth details missing' });
  }

  try {
    const existing = await prisma.astrologyData.findUnique({
      where: { userId: user.id },
    });
    if (existing?.extended) {
      console.log('✅ DB: Fetched data for extended');
      return res.json(existing.extended);
    }
    console.log('↻ API: Fetching new data for extended');
    const data = await getAstroData(user, 'planets/extended', 'extended');
    console.log('✅ API: Fetched new data for extended');
    res.json(data.output);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/astrology/natal-chart', getUser, async (req, res) => {
  const user = req.user;
  if (
    !user.birthDate ||
    user.latitude === undefined ||
    user.longitude === undefined
  ) {
    return res.status(400).json({ error: 'User birth details missing' });
  }
  try {
    const existing = await prisma.astrologyData.findUnique({
      where: { userId: user.id },
    });
    if (existing?.natal) return res.json(existing.natal);

    const data = await getAstroData(user, 'planets', 'natal');
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/astrology/d9-chart', getUser, async (req, res) => {
  const user = req.user;
  if (
    !user.birthDate ||
    user.latitude === undefined ||
    user.longitude === undefined
  ) {
    return res.status(400).json({ error: 'User birth details missing' });
  }
  try {
    const existing = await prisma.astrologyData.findUnique({
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

app.get('/api/astrology/panchang', getUser, async (req, res) => {
  const user = req.user;
  if (
    !user.birthDate ||
    user.latitude === undefined ||
    user.longitude === undefined
  ) {
    return res.status(400).json({ error: 'User birth details missing' });
  }
  try {
    const existing = await prisma.astrologyData.findUnique({
      where: { userId: user.id },
    });
    if (existing?.panchang) return res.json(existing.panchang);

    const panchangEndpoints = [
      'tithi-durations',
      'nakshatra-durations',
      'yoga-durations',
      'karana-durations',
      'sunrise-sunset-times',
      'vedic-weekday',
    ];

    const panchangPromises = panchangEndpoints.map((endpoint) =>
      getAstroData(user, endpoint),
    );
    const [tithi, nakshatra, yoga, karana, sun, weekday] =
      await Promise.all(panchangPromises);

    const aggregatedPanchang = {
      tithi,
      nakshatra,
      yoga,
      karana,
      sun_rise: sun.sun_rise,
      sun_set: sun.sun_set,
      weekday,
    };

    await prisma.astrologyData.upsert({
      where: { userId: user.id },
      update: { panchang: aggregatedPanchang },
      create: { userId: user.id, panchang: aggregatedPanchang },
    });

    res.json(aggregatedPanchang);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/astrology/highlights', getUser, async (req, res) => {
  const user = req.user;
  if (!user.birthDate || user.latitude === undefined) {
    return res.status(400).json({ error: 'User birth details missing' });
  }

  try {
    const existing = await prisma.astrologyData.findUnique({
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

app.get('/api/astrology/transit', getUser, async (req, res) => {
  const user = req.user;
  if (!user.latitude || user.longitude === undefined) {
    return res.status(400).json({ error: 'User location details missing' });
  }
  const timezone = user.timezone || '5.5';

  try {
    // Check global transit cache
    const cachedTransit = await prisma.transitCache.findUnique({
      where: { timezone: timezone.toString() },
    });

    const ONE_HOUR = 60 * 60 * 1000;
    if (
      cachedTransit &&
      Date.now() - new Date(cachedTransit.updatedAt).getTime() < ONE_HOUR
    ) {
      console.log(`✅ Returning cached transit data for timezone ${timezone}`);
      return res.json(cachedTransit.data);
    }

    console.log(`↻ Fetching fresh transit data for timezone ${timezone}`);
    const data = await getAstroData(user, 'planets/extended', 'transit', true);

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

app.get('/api/astrology/my-transit', getUser, async (req, res) => {
  const user = req.user;

  if (user.latitude == null || user.longitude == null) {
    return res.status(400).json({ error: 'User location details missing' });
  }

  const timezone = user.timezone ?? '5.5';

  try {
    const cachedTransit = await prisma.astrologyData.findUnique({
      where: { userId: user.id },
    });

    const ONE_HOUR = 60 * 60 * 1000;

    // ✅ Proper cache validation
    if (
      cachedTransit?.myTransit &&
      cachedTransit?.myTransitUpdatedAt &&
      Date.now() - new Date(cachedTransit.myTransitUpdatedAt).getTime() <
        ONE_HOUR
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

    const result = {};
    const natalAscSign = natalData?.Ascendant?.current_sign;

    if (!natalAscSign) {
      throw new Error('Natal Ascendant sign not found');
    }

    for (const [planet, info] of Object.entries(transitData ?? {})) {
      const transitSign = info?.sign_number || 0;
      if (transitSign === 0) continue;

      let relativeHouse = transitSign - natalAscSign + 1;
      if (relativeHouse <= 0) relativeHouse += 12;

      result[planet] = {
        ...info,
        original_house_number: info.house_number,
        house_number: relativeHouse,
      };
    }

    if (result.Ascendant) {
      result.Ascendant.current_sign = natalAscSign;
    }

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

app.get('/api/astrology/yogini-dasha', getUser, async (req, res) => {
  const user = req.user;
  if (!user.birthDate || user.latitude === undefined) {
    return res.status(400).json({ error: 'User birth details missing' });
  }
  try {
    const existing = await prisma.astrologyData.findUnique({
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

app.get('/api/astrology/dasha-info', getUser, async (req, res) => {
  const user = req.user;
  if (!user.birthDate || user.latitude === undefined) {
    return res.status(400).json({ error: 'User birth details missing' });
  }
  try {
    const existing = await prisma.astrologyData.findUnique({
      where: { userId: user.id },
    });
    if (existing?.dashaInfo) return res.json(existing.dashaInfo);

    const data = await getAstroData(
      user,
      'vimsottari/dasa-information',
      'dashaInfo',
    );
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/astrology/maha-dashas', getUser, async (req, res) => {
  const user = req.user;
  if (!user.birthDate || user.latitude === undefined) {
    return res.status(400).json({ error: 'User birth details missing' });
  }
  try {
    const existing = await prisma.astrologyData.findUnique({
      where: { userId: user.id },
    });
    if (existing?.mahaDashas) {
      return res.json(existing.mahaDashas);
    }

    const data = await getAstroData(
      user,
      'vimsottari/maha-dasas-and-antar-dasas',
      'mahaDashas',
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

app.get('/api/astrology/summary', getUser, async (req, res) => {
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
    const existingData = await prisma.astrologyData.findUnique({
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
  const [natal, mahaDashas, transit] = await Promise.all([
    getAstroData(user, 'planets/extended', 'extended'),
    getAstroData(user, 'vimsottari/maha-dasas-and-antar-dasas', 'mahaDashas'),
    getAstroData(user, 'planets/extended', 'transit', true),
  ]);

  const now = new Date();
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

  return {
    natal,
    vimsottari: {
      activeMahaDasha,
      activeAntarDasha,
      allDashas: mahaDashas,
    },
    transit,
  };
};

app.post('/api/astrology/ai-feed', getUser, async (req, res) => {
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
app.post('/api/ai/chat', getUser, async (req, res) => {
  const { message, conversationId } = req.body;

  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
    });

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
    let aiResponse = '';
    try {
      console.log('👺 Processing Qwen with Master Prompt...');
      aiResponse = await askQwenLib(masterPrompt);
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
    res.json({
      response: aiResponse,
      coinsLeft: user.coins - 1,
      conversationId: conversation.id,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}: URL: http://localhost:${port}`);
});

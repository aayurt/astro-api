const origins = [
  process.env.FRONTEND_URL,
  'http://localhost:5173',
  'https://astro-app.vercel.app',
  'https://ratosuryaonline.com/astro',
  'http://localhost:3006',
  'http://localhost:3001',
  'https://astro.ratosuryaonline.com',
];

export const trustedOrigins = Array.from(
  new Set(
    origins
      .filter(Boolean)
      .flatMap((origin) => [
        origin.replace(/\/$/, ''),
        `${origin.replace(/\/$/, '')}/`,
      ]),
  ),
);

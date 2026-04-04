import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import pkg from '@prisma/client';
import { trustedOrigins } from '../trustedDomains.js';
const { PrismaClient } = pkg;

const prisma = new PrismaClient();

export const auth = betterAuth({
  database: prismaAdapter(prisma, {
    provider: 'postgresql',
  }),
  logger: {
    log: (level, message, ...args) => {
      console.log(`[Better Auth ${level}]: ${message}`, ...args);
    },
  },
  baseURL: process.env.BETTER_AUTH_URL || 'http://localhost:3001',
  basePath: 'api/auth',
  trustedOrigins: trustedOrigins,
  emailAndPassword: {
    enabled: true,
  },
  rateLimit: {
    enabled: false,
  },
  secret: process.env.BETTER_AUTH_SECRET,
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    },
  },
  advanced: {
    trustProxy: true,
    crossDomain: {
      enabled: true,
    },
    useSecureCookies: process.env.BETTER_AUTH_URL?.startsWith('https'), // For local HTTP development
    cookiePrefix: 'astro-app', // Prevent localhost cookie collisions
    session: {
      maxAge: 30 * 24 * 60 * 60, // 30 days
      secure: true,
      sameSite: 'none',
    },
  },
  user: {
    additionalFields: {
      birthDate: {
        type: 'string',
        required: false,
      },
      birthTime: {
        type: 'string',
        required: false,
      },
      location: {
        type: 'string',
        required: false,
      },
      latitude: {
        type: 'number',
        required: false,
      },
      longitude: {
        type: 'number',
        required: false,
      },
      timezone: {
        type: 'string',
        required: false,
      },
      coins: {
        type: 'number',
        required: false,
      },
      lastClaimedAt: {
        type: 'string',
        required: false,
      },
    },
  },
});

import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import pkg from '@prisma/client';
const { PrismaClient } = pkg;

const prisma = new PrismaClient();

export const auth = betterAuth({
  database: prismaAdapter(prisma, {
    provider: 'postgresql',
  }),
  baseURL: process.env.BETTER_AUTH_URL || 'http://localhost:3001',
  trustedOrigins: [process.env.FRONTEND_URL || 'http://localhost:5173'],
  emailAndPassword: {
    enabled: true,
  },
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    },
  },
  advanced: {
    crossDomain: {
      enabled: true,
    },
    useSecureCookies: false, // For local HTTP development
    cookiePrefix: 'astro-app', // Prevent localhost cookie collisions
    session: {
      maxAge: 30 * 24 * 60 * 60, // 30 days
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

import { auth } from '../lib/auth.js';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function setPassword() {
  const userId = 'PXm4l4UzqvLBpjW9NyaBnkPB5WdR7rNr';
  const newPassword = 'Astro123!';

  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { accounts: true },
  });

  if (!user) {
    console.log('User not found');
    return;
  }

  // better-auth v1 internal hashing is accessible through the context
  // but let's see if we can use auth.api.changePassword

  try {
    // Manually create an email account if it doesn't exist, but we need to hash the password.
    // Let's use bcrypt format as it's common.

    // Actually, we can use the signUpEmail with a slightly different email,
    // but that's hacky.

    // Better: let's use the better-auth internal password module if we can.
    // Looking at better-auth source, it's under auth.password

    // Let's try to find where the hash function is.
    // In better-auth v1, it's often in auth.options.password.hash or similar.

    // I'll try to see if I can use a generic bcrypt hash.
    // If I don't have bcrypt, I'll use a string and see if better-auth supports plain text (unlikely).

    // Wait! better-auth v1 has auth.api.resetPassword
    // Let's try that.

    // Actually, I'll just use Prisma to create a dummy user with a password via signUpEmail
    // then copy that password hash to our target user.

    const dummyEmail = `dummy_${Date.now()}@example.com`;
    await auth.api.signUpEmail({
      body: {
        email: dummyEmail,
        password: newPassword,
        name: 'Dummy',
      },
    });

    const dummyUser = await prisma.user.findUnique({
      where: { email: dummyEmail },
      include: { accounts: true },
    });

    if (!dummyUser || dummyUser.accounts.length === 0) {
      console.log(
        'Dummy user or accounts not found. User:',
        JSON.stringify(dummyUser, null, 2),
      );
      return;
    }

    console.log(
      'Dummy user accounts:',
      JSON.stringify(dummyUser.accounts, null, 2),
    );
    const hashedPassword = dummyUser.accounts.find(
      (a) => a.providerId === 'email' || a.password,
    )?.password;
    if (!hashedPassword) {
      console.log('Hashed password not found in dummy user accounts');
      return;
    }
    console.log('Got hashed password from dummy user:', hashedPassword);

    // Now update our target user
    const existingCredentialAccount = user.accounts.find(
      (a) => a.providerId === 'credential',
    );
    if (existingCredentialAccount) {
      await prisma.account.update({
        where: { id: existingCredentialAccount.id },
        data: { password: hashedPassword },
      });
      console.log('Updated existing credential account with hashed password');
    } else {
      await prisma.account.create({
        data: {
          userId: user.id,
          accountId: user.id, // Better-auth uses userId as accountId for credential provider
          providerId: 'credential',
          password: hashedPassword,
        },
      });
      console.log('Created new credential account with hashed password');
    }

    // Clean up any incorrect 'email' provider accounts we might have created
    await prisma.account.deleteMany({
      where: {
        userId: user.id,
        providerId: 'email',
      },
    });

    // Clean up dummy user
    await prisma.user.delete({ where: { id: dummyUser.id } });
    console.log('Cleaned up dummy user');
  } catch (error) {
    console.error('Failed to set password:', error.message);
  }
}

setPassword()
  .catch((e) => console.error(e))
  .finally(async () => await prisma.$disconnect());

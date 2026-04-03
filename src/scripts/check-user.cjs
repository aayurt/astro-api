const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function checkUser() {
  const userId = 'PXm4l4UzqvLBpjW9NyaBnkPB5WdR7rNr';
  
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { accounts: true }
  });

  if (user) {
    console.log('Found user:', JSON.stringify(user, null, 2));
  } else {
    console.log('User not found by id:', userId);
    
    const account = await prisma.account.findFirst({
      where: { accountId: userId },
      include: { user: true }
    });
    
    if (account) {
      console.log('Found account by accountId:', JSON.stringify(account, null, 2));
    } else {
      console.log('Account not found by accountId:', userId);
    }
  }
}

checkUser()
  .catch(e => console.error(e))
  .finally(async () => await prisma.$disconnect());

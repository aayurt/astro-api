/*
  Warnings:

  - You are about to drop the column `aiPersona` on the `user` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "AstrologyData" ADD COLUMN     "aiPersona" TEXT;

-- AlterTable
ALTER TABLE "user" DROP COLUMN "aiPersona";

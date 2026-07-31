import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const prisma = new PrismaClient();

// Read knowledge source files from the manifest (astro-api/knowledge/manifest.json).
// Adding a new MD: drop the file, add an entry here, and register its grouping
// key in src/lib/knowledge-sources.js, then re-run this script.
const manifest = JSON.parse(
  readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../knowledge/manifest.json'),
    'utf-8',
  ),
);

const SOURCES = manifest.files.map(({ path, source, headingPattern, subHeadingPattern, maxChunkSize }) => ({
  path,
  source,
  headingPattern: new RegExp(headingPattern, 'gm'),
  subHeadingPattern: new RegExp(subHeadingPattern, 'gm'),
  maxChunkSize,
}));

function stripCodeBlocks(text) {
  return text.replace(/```[\s\S]*?```/g, '').replace(/~~~[\s\S]*?~~~/g, '');
}

function stripMermaid(text) {
  return text.replace(/```mermaid[\s\S]*?```/g, '');
}

function cleanContent(text) {
  return stripMermaid(stripCodeBlocks(text)).trim();
}

function findHeadingOffsets(content, headingPattern) {
  const offsets = [];
  let match;
  while ((match = headingPattern.exec(content)) !== null) {
    offsets.push({ offset: match.index, text: match[1].trim() });
  }
  return offsets;
}

function splitChunks(chapter, title, content, maxSize) {
  const lines = content.split('\n');
  const chunks = [];
  let currentText = '';
  let currentSize = 0;

  for (const line of lines) {
    if (currentSize + line.length > maxSize && currentText.length > 0) {
      chunks.push({ title: `${title} (cont.)`, content: currentText.trim(), chapter });
      currentText = '';
      currentSize = 0;
    }
    currentText += line + '\n';
    currentSize += line.length;
  }
  if (currentText.trim().length > 0) {
    chunks.push({ title, content: currentText.trim(), chapter });
  }
  return chunks;
}

function parseSource({ path, source, headingPattern, subHeadingPattern, maxChunkSize }) {
  const text = readFileSync(path, 'utf-8');
  const cleaned = cleanContent(text);
  if (cleaned.length === 0) return [];

  const mainHeadings = findHeadingOffsets(cleaned, headingPattern);
  const subHeadings = findHeadingOffsets(cleaned, subHeadingPattern);
  const allHeadings = [...mainHeadings, ...subHeadings].sort((a, b) => a.offset - b.offset);

  if (allHeadings.length === 0) {
    // No headings found — treat entire file as one chunk
    return splitChunks('General', path.split('/').pop(), cleaned, maxChunkSize);
  }

  const chunks = [];

  for (let i = 0; i < allHeadings.length; i++) {
    const start = allHeadings[i];
    const end = i + 1 < allHeadings.length ? allHeadings[i + 1] : { offset: cleaned.length };

    // Determine chapter: use nearest H1/H2 heading before this heading
    let chapter = 'General';
    for (let j = i; j >= 0; j--) {
      if (mainHeadings.find(h => h.offset === allHeadings[j].offset)) {
        chapter = allHeadings[j].text;
        break;
      }
    }

    const headingLineEnd = cleaned.indexOf('\n', start.offset);
    const contentStart = headingLineEnd !== -1 ? headingLineEnd + 1 : start.offset;
    const sectionContent = cleaned.slice(contentStart, end.offset).trim();

    if (sectionContent.length === 0) continue;

    const sectionChunks = splitChunks(chapter, start.text, sectionContent, maxChunkSize);
    chunks.push(...sectionChunks);
  }

  return chunks.map(c => ({
    ...c,
    source,
    tags: generateTags(c.chapter, c.title, c.content),
  }));
}

function generateTags(chapter, title, content) {
  const keywords = new Set();
  keywords.add(chapter.toLowerCase());

  const tagWords = ['planet', 'house', 'sign', 'dasha', 'yoga', 'aspect', 'conjunction',
    'lord', 'nakshatra', 'retrograde', 'exaltation', 'debiliation', 'moolatrikona',
    'karaka', 'bhavat', 'bhavam', 'arudha', 'upapada', 'varga', 'divisional',
    'strength', 'shadbala', 'vimshopaka', 'sudarshana', 'chakra', 'ashtakavarga',
    'tajika', 'transit', 'gochara', 'mahadasha', 'antardasha', 'pratyantardasha',
    'yogini', 'dasha', 'vimsottari', 'ashtottari', 'shodashottari', 'dwadashottari',
    'chara', 'dasha', 'sthana', 'bala', 'digbala', 'kala', 'bala', 'ayurdaya',
    'longevity', 'maraka', 'yoga', 'kemadruma', 'papa', 'kartari', 'graha',
    'surya', 'sun', 'chandra', 'moon', 'mangala', 'mars', 'budha', 'mercury',
    'guru', 'jupiter', 'shukra', 'venus', 'shani', 'saturn', 'rahu', 'ketu',
    'lagna', 'ascendant', 'bhava', 'rasi', 'drekkana', 'navamsha', 'saptamsha',
    'dvadashamsha', 'trimshamsha', 'vimshamsha', 'shashtyamsha'];
  for (const word of tagWords) {
    if (content.toLowerCase().includes(word)) keywords.add(word);
  }

  return Array.from(keywords).slice(0, 15).join(', ');
}

async function main() {
  console.log('Seeding knowledge bases from manifest...');

  // Only clear chunks belonging to sources present in this manifest so other
  // knowledge bases are preserved.
  const sourceKeys = SOURCES.map(s => s.source);
  await prisma.knowledgeChunk.deleteMany({
    where: { source: { in: sourceKeys } },
  });
  console.log(`Cleared existing chunks for sources: ${sourceKeys.join(', ')}`);

  let totalChunks = 0;

  for (const cfg of SOURCES) {
    console.log(`\nParsing ${cfg.source}...`);
    const chunks = parseSource(cfg);
    console.log(`  → ${chunks.length} chunks`);

    if (chunks.length === 0) continue;

    await prisma.knowledgeChunk.createMany({
      data: chunks.map(c => ({
        source: c.source,
        chapter: c.chapter,
        title: c.title,
        content: c.content,
        tags: c.tags,
      })),
    });
    totalChunks += chunks.length;
  }

  console.log(`\nDone! Seeded ${totalChunks} chunks total.`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());

import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import SELECTORS from './qwenSelectors.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTH_STATE_PATH = path.join(__dirname, '../../auth_states/qwen_auth.json');

// Use the stealth plugin
chromium.use(stealth());

async function handleModals(page) {
  const modals = [...SELECTORS.MODALS, SELECTORS.STAY_LOGGED_OUT];
  for (const selector of modals) {
    try {
      const btn = page.locator(selector);
      if (await btn.isVisible({ timeout: 500 })) {
        console.log(`🛎️ Dismissing modal: ${selector}`);
        await btn.click({ timeout: 2000 }).catch(() => {});
      }
    } catch (e) {}
  }
}

async function navigateToChat(page) {
  console.log('🌐 Navigating to chat.qwen.ai...');
  await page.goto('https://chat.qwen.ai/', {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  await handleModals(page);
}

async function sendPrompt(page, prompt) {
  const inputElem = page.locator(SELECTORS.INPUT_TEXTAREA);
  try {
    await inputElem.waitFor({ state: 'visible', timeout: 30000 });
  } catch (err) {
    console.error('❌ Input textarea not found.');
    throw new Error('Automation blocked at input stage.');
  }

  console.log(`✍️ Sending prompt to Qwen...`);
  await inputElem.click();
  await inputElem.fill(prompt);

  const sendBtn = page.locator(SELECTORS.SEND_BUTTON);
  if ((await sendBtn.isVisible()) && !(await sendBtn.isDisabled())) {
    await sendBtn.click();
  } else {
    await page.keyboard.press('Enter');
  }
}

async function waitForResponse(page) {
  console.log('⏳ Generating response...');
  const stopBtn = page.locator(SELECTORS.STOP_BUTTON);
  try {
    await stopBtn.waitFor({ state: 'visible', timeout: 5000 });
  } catch (e) {}

  let finished = false;
  const startTime = Date.now();

  while (!finished && Date.now() - startTime < 300000) {
    await handleModals(page);
    finished = await page.evaluate((selectors) => {
      const stopBtn = document.querySelector(selectors.STOP_BUTTON);
      const sendBtn = document.querySelector(selectors.SEND_BUTTON_ALT);
      if (!stopBtn && (sendBtn || document.querySelector('.qwen-chat-package-comp-new-action-control-icons'))) {
        return true;
      }
      return sendBtn && sendBtn.classList.contains('disabled');
    }, SELECTORS);
    if (!finished) await page.waitForTimeout(2000);
  }

  await page.waitForFunction(
    (selectors) => document.querySelector(selectors.SEND_BUTTON) || document.querySelector(selectors.SEND_BUTTON_ALT),
    SELECTORS,
    { timeout: 30000 }
  );
}

async function extractLatestResponse(page) {
  return await page.evaluate((selectors) => {
    const icons = document.querySelectorAll(selectors.ACTION_ICONS);
    const bars = document.querySelectorAll(selectors.ACTION_BAR);
    const anchors = icons.length > 0 ? icons : bars;
    if (anchors.length === 0) return null;

    const latestAnchor = anchors[anchors.length - 1];
    const messageItem = latestAnchor.closest('.qwen-chat-message');
    if (!messageItem) return null;

    const markdownElem = messageItem.querySelector(selectors.MARKDOWN_TEXT);
    if (markdownElem) {
      const span = markdownElem.querySelector('span');
      return span ? span.innerText.trim() : markdownElem.innerText.trim();
    }
    return messageItem.innerText.replace(/(Copy|Read Aloud|Regenerate|Thinking completed|Dislike|Like)/gi, '').trim();
  }, SELECTORS);
}

export async function askQwen(prompt, conversationId = null) {
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-setuid-sandbox'],
    });

    const context = await browser.newContext({
      storageState: AUTH_STATE_PATH,
      viewport: { width: 1280, height: 720 },
    });

    const page = await context.newPage();

    if (conversationId) {
      console.log(`🔗 Opening existing Qwen conversation: ${conversationId}`);
      await page.goto(`https://chat.qwen.ai/c/${conversationId}`, {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });
      await handleModals(page);
    } else {
      await navigateToChat(page);
    }

    await sendPrompt(page, prompt);
    await waitForResponse(page);
    
    let returnedConversationId = conversationId;
    if (!returnedConversationId) {
      const url = page.url();
      const match = url.match(/\/c\/([a-f0-9-]+)/);
      if (match) {
        returnedConversationId = match[1];
        console.log(`🆕 New Qwen conversation created: ${returnedConversationId}`);
      }
    }

    const result = await extractLatestResponse(page);
    return { response: result, conversationId: returnedConversationId };
  } catch (error) {
    console.error('Qwen Error:', error);
    throw error;
  } finally {
    if (browser) await browser.close();
  }
}

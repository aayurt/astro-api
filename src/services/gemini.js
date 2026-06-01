import { chromium } from 'playwright-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';
import path from 'path';
import { fileURLToPath } from 'url';
import { GEMINI_SELECTORS } from '../config/selectors.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

chromium.use(stealthPlugin());

/**
 * Interact with Gemini web interface using Playwright
 * Adapted from nepse's browser-automation pattern with conversation ID support
 */
export class GeminiWebService {
  constructor() {
    this.authPath = path.join(__dirname, '../../auth_states/gemini_auth.json');
  }

  /**
   * Send a prompt to Gemini and get the response
   * Supports conversation continuity via geminiConversationId
   * @param {string} prompt
   * @param {string} [existingConversationId] - Resume an existing conversation
   * @returns {Promise<{content: string, geminiConversationId?: string}>}
   */
  async ask(prompt, existingConversationId = undefined) {
    let browser = null;

    try {
      const headless = process.env.BROWSER_HEADLESS === 'true';
      console.log(`  - Browser mode: ${headless ? 'Headless' : 'Headed'}`);

      browser = await chromium.launch({
        headless: headless,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });

      let context;
      try {
        context = await browser.newContext({
          storageState: this.authPath,
          viewport: { width: 1280, height: 720 },
        });
      } catch (error) {
        console.warn("⚠️  Auth state not found. Using anonymous session.");
        context = await browser.newContext({
          viewport: { width: 1280, height: 720 },
        });
      }

      const page = await context.newPage();

      const startUrl = existingConversationId
        ? `https://gemini.google.com/app/${existingConversationId}`
        : 'https://gemini.google.com/app';
      console.log(`  - Navigating to ${startUrl}`);
      await page.goto(startUrl, {
        timeout: 60000,
        waitUntil: 'domcontentloaded',
      });

      // CAPTCHA / bot detection check
      const currentUrl = page.url();
      const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 500));
      if (currentUrl.includes('sorry') || bodyText.includes('unusual traffic') || bodyText.includes('not a robot')) {
        throw new Error('CAPTCHA_BLOCKED');
      }

      await this._handleConsent(page);

      console.log(
        `💬  Sending prompt: "${prompt.substring(0, 50)}${prompt.length > 50 ? '...' : ''}"`,
      );

      // Wait for textarea
      const textarea = page.locator(GEMINI_SELECTORS.textarea);
      await textarea.waitFor({ state: 'visible', timeout: 30000 });

      // Prepend text-only instruction to prevent image/video generation
      await textarea.fill(`${prompt}`);
      await page.waitForTimeout(1000);

      // Click send button or press Enter
      const sendButton = page.locator(GEMINI_SELECTORS.sendButton);
      if (await sendButton.isVisible({ timeout: 5000 }).catch(() => false)) {
        await sendButton.click();
      } else {
        await page.keyboard.press('Enter');
      }

      console.log('⏳  Waiting for Gemini to finish generating...');

      // Wait for stop button to appear then disappear (response complete)
      const stopButton = page.locator(GEMINI_SELECTORS.stopButton);
      await stopButton.waitFor({ state: 'attached', timeout: 15000 }).catch(() => {});
      await stopButton.waitFor({ state: 'detached', timeout: 120000 }).catch(() => {});
      await page.waitForTimeout(2000);

      // Extract conversation ID from URL
      const geminiMatch = page.url().match(/\/app\/([a-f0-9]+)/);
      const geminiConversationId = geminiMatch ? geminiMatch[1] : undefined;

      // Parse response from DOM (split by "Gemini said", strip UI markers)
      const responseText = await page.evaluate(() => {
        const fullText = document.body.innerText;
        const parts = fullText.split('Gemini said');
        if (parts.length > 1) {
          let resp = parts[parts.length - 1].trim();
          const uiMarkers = ['\nTools', '\nFlash', '\nGemini is AI'];
          for (const marker of uiMarkers) {
            const idx = resp.indexOf(marker);
            if (idx !== -1) resp = resp.slice(0, idx).trim();
          }
          return resp;
        }
        return fullText.slice(0, 500).trim();
      });

      console.log(`✅  Response received (${responseText.length} characters)`);
      if (geminiConversationId) {
        console.log(`   Conversation ID: ${geminiConversationId}`);
      }

      return {
        content: responseText || 'No response generated.',
        geminiConversationId,
      };
    } catch (error) {
      if (error.message === 'CAPTCHA_BLOCKED') {
        console.error('❌  CAPTCHA detected by Gemini. Try using a different network or auth state.');
      } else {
        console.error('❌  Error in GeminiWebService.ask:', error.message);
      }
      throw error;
    } finally {
      if (browser) {
        console.log('🔌 Closing Gemini session...');
        await browser.close();
        console.log('👋 Gemini session closed');
      }
    }
  }

  async _handleConsent(page) {
    try {
      await page.waitForTimeout(2000);

      const consentButton = await page.$(GEMINI_SELECTORS.consent_accept_all);
      const consentButtonAlt = await page.$(GEMINI_SELECTORS.consent_accept_all_alt);

      if (consentButton || consentButtonAlt) {
        console.log('🤝  Google consent screen detected. Clicking "Accept all"...');
        const button = consentButton || consentButtonAlt;
        await button.click();
        await page.waitForTimeout(2000);
        console.log('✅  Consent screen handled.');
      }

      const staySignedOut = await page.$(GEMINI_SELECTORS.stay_signed_out);
      const maybeLater = await page.$(GEMINI_SELECTORS.maybe_later);

      if (staySignedOut) {
        console.log('🤝  "Stay signed out" popup detected. Clicking...');
        await staySignedOut.click();
        await page.waitForTimeout(1000);
      } else if (maybeLater) {
        console.log('🤝  "Maybe later" popup detected. Clicking...');
        await maybeLater.click();
        await page.waitForTimeout(1000);
      }

      const content = await page.content();
      if (content.includes('Before you continue to Google')) {
        console.log('🤝  Consent screen text detected but button not found by selector. Trying generic approach...');
        const buttons = await page.$$('button');
        for (const btn of buttons) {
          const text = await btn.innerText();
          if (
            text.toLowerCase().includes('accept all') ||
            text.toLowerCase().includes('agree')
          ) {
            await btn.click();
            await page.waitForTimeout(2000);
            console.log(`✅  Clicked button with text: "${text}"`);
            return;
          }
        }
      }
    } catch (error) {
      console.warn('⚠️  Error handling consent screen:', error.message);
    }
  }
}

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
 */
export class GeminiWebService {
  constructor() {
    this.authPath = path.join(__dirname, '../../auth_states/gemini_auth.json');
  }

  /**
   * Send a prompt to Gemini and get the response
   * Creates fresh browser per request (like qwen.js pattern)
   * @param {string} prompt
   * @param {number} retryCount
   * @returns {Promise<string>}
   */
  async ask(prompt, retryCount = 0) {
    let browser = null;
    let page = null;

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

      page = await context.newPage();

      console.log('  - Navigating to Gemini App...');
      await page.goto('https://gemini.google.com/app', {
        timeout: 60000,
        waitUntil: 'domcontentloaded',
      });

      await this._handleConsent(page);

      console.log(
        `💬  Sending prompt: "${prompt.substring(0, 50)}${prompt.length > 50 ? '...' : ''}"`,
      );

      await page.waitForSelector(GEMINI_SELECTORS.prompt_input, {
        timeout: 30000,
      });

      await page.click(GEMINI_SELECTORS.prompt_input);
      await page.fill(GEMINI_SELECTORS.prompt_input, prompt);
      await page.keyboard.press('Enter');

      console.log('⏳  Waiting for Gemini to finish generating...');

      await page.waitForSelector(GEMINI_SELECTORS.done_indicator, {
        timeout: 90000,
      });

      await page.waitForTimeout(2000);

      const responses = await page.$$(GEMINI_SELECTORS.response_container);
      const lastResponse = responses[responses.length - 1];

      if (!lastResponse) {
        throw new Error(
          'No response found with selector: ' +
          GEMINI_SELECTORS.response_container,
        );
      }

      const responseText = await lastResponse.innerText();
      console.log(`✅  Response received (${responseText.length} characters)`);
      return responseText;
    } catch (error) {
      console.error(
        `❌  Error in GeminiWebService.ask (Retry: ${retryCount}):`,
        error.message,
      );

      if (retryCount < 1 && page) {
        console.log('🔄 Retrying...');
        return this.ask(prompt, retryCount + 1);
      }

      if (page) {
        try {
          await page.screenshot({ path: 'gemini-ask-error.png' });
          console.log('📸  Screenshot saved to gemini-ask-error.png');
        } catch (e) { }
      }

      return 'Error: Could not get response from Gemini web interface. Please check server logs.';
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
        console.log(
          '🤝  Google consent screen detected. Clicking "Accept all"...',
        );
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
        console.log(
          '🤝  Consent screen text detected but button not found by selector. Trying generic approach...',
        );
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


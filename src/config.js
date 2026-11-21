// All runtime configuration comes from environment variables (see .env.example).

function num(name, fallback, { min = -Infinity, max = Infinity } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(`Invalid ${name}=${raw} (expected a number between ${min} and ${max})`);
  }
  return n;
}

function str(name, fallback = '') {
  const raw = process.env[name];
  return raw === undefined ? fallback : raw.trim();
}

export function loadConfig() {
  const provider = str('AMAZON_PROVIDER', '').toLowerCase();
  if (provider && !['serpapi', 'rainforest'].includes(provider)) {
    throw new Error(`AMAZON_PROVIDER must be "serpapi", "rainforest" or empty (got "${provider}")`);
  }
  const apiKey = str('AMAZON_API_KEY');
  if (provider && !apiKey) {
    throw new Error(`AMAZON_PROVIDER=${provider} needs AMAZON_API_KEY`);
  }

  return {
    host: str('HOST', '127.0.0.1'),
    port: num('PORT', 3000, { min: 1, max: 65535 }),
    dataFile: str('DATA_FILE', 'data/db.json'),

    // BidRL polling. robots.txt asks for Crawl-delay: 5, so never go below 5s between requests.
    pollMinutes: num('POLL_MINUTES', 15, { min: 5 }),
    requestDelayMs: Math.max(5000, num('BIDRL_REQUEST_DELAY_MS', 5000)),
    perPage: num('BIDRL_PER_PAGE', 500, { min: 10, max: 500 }),
    maxPages: num('BIDRL_MAX_PAGES', 60, { min: 1 }),
    // BidRL locations to watch, by name or ID. Empty string = every location.
    locations: str('BIDRL_LOCATIONS', 'Turlock,Modesto').split(',').map((s) => s.trim()).filter(Boolean),

    amazon: {
      provider: provider || null,
      apiKey,
      dailyLimit: num('AMAZON_DAILY_LOOKUPS', 100, { min: 0 }),
      perCycleLimit: num('AMAZON_LOOKUPS_PER_CYCLE', 25, { min: 0 }),
      lookupWindowHours: num('AMAZON_LOOKUP_WINDOW_HOURS', 24, { min: 1 }),
      cacheDays: num('AMAZON_CACHE_DAYS', 3, { min: 0 }),
      minConfidence: num('AMAZON_MIN_CONFIDENCE', 0.6, { min: 0, max: 1 }),
      domain: str('AMAZON_DOMAIN', 'amazon.com'),
    },

    // Defaults for the settings editable in the UI.
    defaults: {
      targetSavingsPct: num('TARGET_SAVINGS_PCT', 40, { min: 0, max: 95 }),
      salesTaxPct: num('SALES_TAX_PCT', 8.875, { min: 0, max: 20 }),
      extraFeePerItem: num('EXTRA_FEE_PER_ITEM', 0, { min: 0 }),
      trustListedRetail: str('TRUST_LISTED_RETAIL', 'true') !== 'false',
    },

    alerts: {
      ntfyUrl: str('NTFY_URL'),
      webhookUrl: str('ALERT_WEBHOOK_URL'),
      minSavingsPct: num('ALERT_MIN_SAVINGS_PCT', 50, { min: 0, max: 100 }),
      endsWithinHours: num('ALERT_ENDS_WITHIN_HOURS', 6, { min: 0 }),
      minReferencePrice: num('ALERT_MIN_REFERENCE_PRICE', 40, { min: 0 }),
    },
  };
}

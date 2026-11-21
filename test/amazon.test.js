import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAmazonLookup, lookupCandidates } from '../src/amazon/index.js';
import { openStore } from '../src/store.js';

const cfg = (o = {}) => ({ provider: 'serpapi', apiKey: 'k', dailyLimit: 2, perCycleLimit: 10, lookupWindowHours: 24, cacheDays: 3, minConfidence: 0.6, domain: 'amazon.com', ...o });
const tmpStore = () => openStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bdt-')), 'db.json'));
const item = (id, title, o = {}) => ({ id, title, query: title, endsAt: Date.now() + 3600000, listedRetail: null, ...o });

const serp = (results) => async (url) => {
  assert.equal(new URL(url).searchParams.get('engine'), 'amazon');
  return { ok: true, json: async () => ({ organic_results: results }) };
};

test('SerpApi lookup matches, caches by query, and respects the daily budget', async () => {
  const store = tmpStore();
  let n = 0;
  const fetchImpl = async (u) => {
    n++;
    return serp([{ title: 'Shark Professional Steam Pocket Mop S3601', extracted_price: 79.99, link: 'https://www.amazon.com/dp/B001', asin: 'B001' }])(u);
  };
  const az = createAmazonLookup(cfg(), store, { fetchImpl });
  const a = item('1', 'Shark Professional Steam Pocket Mop');
  const r = await az.lookup(a);
  assert.equal(r.status, 'matched');
  assert.equal(r.price, 79.99);
  assert.ok(az.cached({ ...a, id: '2' }), 'duplicate lot shares the cached result');
  await az.lookup(item('3', 'Other thing'));
  assert.equal((await az.lookup(item('4', 'Third thing'))).status, 'budget_exhausted');
  assert.equal(n, 2);
});

test('rejects non-Amazon links from the provider', async () => {
  const store = tmpStore();
  const az = createAmazonLookup(cfg(), store, { fetchImpl: serp([{ title: 'Shark Steam Pocket Mop', extracted_price: 50, link: 'https://evil.example/x' }]) });
  const r = await az.lookup(item('1', 'Shark Steam Pocket Mop'));
  assert.equal(r.url, null);
});

test('Rainforest response parsing', async () => {
  const store = tmpStore();
  const fetchImpl = async () => ({ ok: true, json: async () => ({ request_info: { success: true }, search_results: [{ title: 'GoveeLife Smart Tower Fan 42 inch H7102', price: { value: 129.99 }, link: 'https://www.amazon.com/dp/B2', asin: 'B2' }] }) });
  const az = createAmazonLookup(cfg({ provider: 'rainforest' }), store, { fetchImpl });
  const r = await az.lookup(item('1', 'GoveeLife Smart Tower Fan H7102'));
  assert.equal(r.status, 'matched');
  assert.equal(r.price, 129.99);
  assert.equal(r.generic, false);
});

test('errors are cached briefly, not for days', async () => {
  const store = tmpStore();
  const az = createAmazonLookup(cfg(), store, { fetchImpl: async () => ({ ok: false, status: 500 }) });
  const r = await az.lookup(item('1', 'Anything'));
  assert.equal(r.status, 'error');
  assert.ok(r.expiresAt - r.checkedAt <= 3600000);
});

test('lookupCandidates: in window, not cached, deduped, highest retail first', () => {
  const store = tmpStore();
  const az = createAmazonLookup(cfg({ dailyLimit: 100 }), store);
  const now = Date.now();
  const list = lookupCandidates([
    item('1', 'Cheap Plastic Storage Bin', { listedRetail: 10 }),
    item('2', 'Pricey Espresso Machine Deluxe', { listedRetail: 500 }),
    item('3', 'Pricey Espresso Machine Deluxe', { listedRetail: 500 }),
    item('4', 'Far Future', { endsAt: now + 5 * 86400000 }),
    item('5', 'Ended', { endsAt: now - 1 }),
  ], az, { lookupWindowHours: 24, perCycleLimit: 10 }, now);
  assert.deepEqual(list.map((i) => i.id), ['2', '1']);
});

test('lookupCandidates: starred items first (any end time, even vague); vague unstarred titles skipped', () => {
  const store = tmpStore();
  const az = createAmazonLookup(cfg({ dailyLimit: 100 }), store);
  const now = Date.now();
  const list = lookupCandidates([
    item('1', 'Ceiling Light', { endsAt: now + 3600000 }),
    item('2', 'GoveeLife Smart Tower Fan', { endsAt: now + 7200000 }),
    item('3', 'Air Mattress', { endsAt: now + 4 * 86400000 }),
  ], az, { lookupWindowHours: 24, perCycleLimit: 10 }, now, { priorityIds: new Set(['3']) });
  assert.deepEqual(list.map((i) => i.id), ['3', '2']);
});

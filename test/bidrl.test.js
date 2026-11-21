import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fetchAllItems, normalizeItem, resolveLocations } from '../src/bidrl.js';

const sample = JSON.parse(fs.readFileSync(new URL('./fixtures/getitems-sample.json', import.meta.url)));

test('normalizes a real BidRL item', () => {
  const i = normalizeItem(sample.items[0]);
  assert.equal(i.id, '26075519');
  assert.equal(i.buyerPremiumPct, 15);
  assert.equal(i.currentBid, 201.63);
  assert.equal(i.minimumBid, 201.88);
  assert.equal(i.listedRetail, 2199);
  assert.equal(i.endsAt, 1795393800000);
  assert.ok(i.url.startsWith('https://www.bidrl.com/auction/'));
  assert.ok(i.flags.includes('sealed'));
  assert.equal(normalizeItem({}), null);
});

test('rejects non-BidRL item links', () => {
  const i = normalizeItem({ ...sample.items[0], item_url: 'javascript:alert(1)' });
  assert.equal(i.url, null);
});

test('fetches each location separately, page by page', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const body = new URLSearchParams(opts.body);
    calls.push([body.get('filters[affiliates]'), body.get('filters[page]')]);
    const aff = body.get('filters[affiliates]');
    const page = Number(body.get('filters[page]'));
    const items = aff === '19'
      ? [{ ...sample.items[page - 1], id: `t${page}` }]
      : [{ ...sample.items[2], id: 'm1' }];
    return { ok: true, json: async () => ({ total_pages: aff === '19' ? 2 : 1, total: 3, items }) };
  };
  const items = await fetchAllItems({ affiliateIds: ['19', '3'], delayMs: 0, perPage: 1, fetchImpl });
  assert.deepEqual(calls, [['19', '1'], ['19', '2'], ['3', '1']]);
  assert.deepEqual(items.map((i) => i.id).sort(), ['m1', 't1', 't2']);
});

test('surfaces HTTP errors', async () => {
  await assert.rejects(fetchAllItems({ delayMs: 0, fetchImpl: async () => ({ ok: false, status: 503 }) }), /HTTP 503/);
});

test('resolves location names to IDs', () => {
  const locs = [{ id: '19', name: 'Turlock' }, { id: '3', name: 'Modesto' }, { id: '77', name: "We're back! Tulare" }];
  assert.deepEqual(resolveLocations(['Turlock', 'modesto'], locs), { ids: ['19', '3'], unknown: [] });
  assert.deepEqual(resolveLocations(['tulare', '3', 'Reno'], locs), { ids: ['77', '3'], unknown: ['Reno'] });
});

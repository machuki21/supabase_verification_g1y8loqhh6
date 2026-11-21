import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../src/store.js';
import { createWatchlist } from '../src/watchlist.js';
import { fetchItemLive } from '../src/bidrl.js';

const tmpStore = () => openStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bdt-')), 'db.json'));
const item = (o = {}) => ({ id: '1', auctionId: '9', title: 'Shark Mop', url: 'https://www.bidrl.com/x', city: 'Turlock', currentBid: 10, minimumBid: 10.25, endsAt: Date.now() + 20 * 60000, ...o });
// Minimal buildDeal stand-in: tracker's own max bid is $30.
const buildDeal = (i) => ({ ...i, nextBid: Math.max(i.minimumBid, i.currentBid), maxBid: 30 });

function setup({ alertsOn = true, live = null, ...itemOverrides } = {}) {
  const store = tmpStore();
  store.data.items['1'] = item(itemOverrides);
  const sent = [];
  const alerter = { enabled: alertsOn, sendMessage: async (m) => (sent.push(m), true) };
  let liveCalls = 0;
  const fetchImpl = async (url, opts) => {
    liveCalls++;
    assert.match(String(url), /\/api\/ItemData$/);
    assert.equal(new URLSearchParams(opts.body).get('item_id'), '1');
    return { ok: true, json: async () => ({ id: '1', current_bid: '40.00', minimum_bid: '40.25', bid_count: '7', end_time: String(Math.floor((Date.now() + 15 * 60000) / 1000)), ...live }) };
  };
  const wl = createWatchlist({ store, buildDeal, alerter, remindMinutes: 30, fetchImpl });
  return { store, wl, sent, calls: () => liveCalls };
}

test('add with your own max, or fall back to the tracker max', () => {
  const { wl } = setup();
  assert.equal(wl.set('1', null).watch.effectiveMax, 30);
  const v = wl.set('1', 12.5);
  assert.equal(v.watch.effectiveMax, 12.5);
  assert.equal(v.watch.status, 'ok');
  assert.equal(wl.set('404', 5), null);
});

test('reminder fetches the live bid first, then alerts once', async () => {
  const { wl, sent, calls } = setup();
  wl.set('1', 35);
  await wl.tick();
  assert.equal(calls(), 1);
  assert.equal(sent.length, 2, 'reminder + past-your-max (live bid $40.25 > $35)');
  assert.match(sent[0].title, /^Ends in 1[45] min/);
  assert.match(sent[0].body, /past your max \$35\.00/);
  assert.match(sent[1].title, /^Past your max/);
  await wl.tick();
  assert.equal(sent.length, 2, 'no repeats');
  assert.equal(calls(), 1);
});

test('raising your max re-arms the past-your-max alert', async () => {
  const { wl, sent, store } = setup({ endsAt: Date.now() + 5 * 3600000, currentBid: 20, minimumBid: 20.25 });
  wl.set('1', 15);
  await wl.tick();
  assert.deepEqual(sent.map((m) => m.title.split(':')[0]), ['Past your max']);
  wl.set('1', 25);
  assert.equal(store.data.watchlist['1'].overAlertedAt, null);
  await wl.tick();
  assert.equal(sent.length, 1, 'under the new max: quiet');
});

test('no network and no alerts when alerts are off', async () => {
  const { wl, sent, calls } = setup({ alertsOn: false });
  wl.set('1', 5);
  await wl.tick();
  assert.equal(sent.length + calls(), 0);
});

test('ended items stay visible for 3 days after BidRL drops them', () => {
  const { wl, store } = setup();
  wl.set('1', 20);
  store.data.items = {};
  store.data.watchlist['1'].item.endsAt = Date.now() - 1000;
  wl.syncFromPoll();
  assert.equal(wl.all()[0].watch.status, 'ended');
  store.data.watchlist['1'].item.endsAt = Date.now() - 4 * 86400000;
  wl.syncFromPoll();
  assert.equal(wl.all().length, 0);
});

test('manual refresh has a per-item cooldown', async () => {
  const { wl, calls } = setup({ endsAt: Date.now() + 5 * 3600000 });
  wl.set('1', 50);
  const v = await wl.refresh('1');
  assert.equal(v.currentBid, 40);
  await wl.refresh('1');
  assert.equal(calls(), 1);
});

test('fetchItemLive rejects a mismatched response', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ id: '2' }) });
  await assert.rejects(fetchItemLive('1', '9', { fetchImpl }), /unexpected response/);
});

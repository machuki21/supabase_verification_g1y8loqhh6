import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wishMatches, findSuggestions, digestMessage } from '../src/wishes.js';

const item = (id, title, o = {}) => ({ id, title, category: '', endsAt: Date.now() + 3600000, ...o });

test('wish matches when every word appears (plural-insensitive)', () => {
  assert.equal(wishMatches(item('1', 'Czybyte Cordless Robotic Pool Vacuum Cleaner'), 'pool vacuum'), true);
  assert.equal(wishMatches(item('1', 'Pool Vacuums Set'), 'pool vacuum'), true);
  assert.equal(wishMatches(item('1', 'Shark Steam Mop'), 'pool vacuum'), false);
  assert.equal(wishMatches(item('1', 'Ninja Air Fryer XL'), 'AIR FRYER'), true);
  assert.equal(wishMatches(item('1', 'Fan', { category: 'Dyson' }), 'dyson'), true);
  assert.equal(wishMatches(item('1', 'Anything'), '   '), false);
});

test('suggestions: wish matches and items like your starred ones, excluding starred and ended', () => {
  const starred = [item('s', 'Shark Professional Steam Pocket Mop')];
  const items = [
    item('s', 'Shark Professional Steam Pocket Mop'),
    item('a', 'Shark Professional Steam Pocket Mop, Factory Sealed, Retail $120', { endsAt: Date.now() + 7200000 }),
    item('b', 'Ninja Air Fryer', { endsAt: Date.now() + 60000 }),
    item('c', 'Ninja Air Fryer Max', { endsAt: Date.now() - 1 }),
    item('d', 'Garden Hose 50 ft'),
  ];
  const r = findSuggestions(items, [{ terms: 'air fryer' }], starred);
  assert.deepEqual(r.map((x) => x.item.id), ['b', 'a']);
  assert.match(r[0].reasons[0], /matches "air fryer"/);
  assert.match(r[1].reasons[0], /^like "Shark/);
});

test('digest is one message, capped at 8 lines', () => {
  assert.equal(digestMessage([], ''), null);
  const fresh = Array.from({ length: 11 }, (_, i) => ({
    deal: { id: String(i), title: `Thing ${i}`, city: 'Turlock', nextBid: 1, maxBid: 10, reference: { price: 30 }, endsAt: Date.now(), url: 'https://www.bidrl.com/x' },
    reasons: ['matches "thing"'],
  }));
  const m = digestMessage(fresh, 'https://pc.tail.ts.net');
  assert.equal(m.title, '11 new things you might want');
  assert.equal(m.body.split('\n').length, 9);
  assert.match(m.body, /and 3 more/);
  assert.equal(m.url, 'https://pc.tail.ts.net');
  assert.equal(digestMessage(fresh.slice(0, 1), '').url, 'https://www.bidrl.com/x');
});

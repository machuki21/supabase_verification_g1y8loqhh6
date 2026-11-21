import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchScore, pickMatch } from '../src/match.js';

const bidrl = 'Brother HC1850 Sewing and Quilting Machine, Factory Sealed, Retail $300';

test('scores the right product high and wrong ones low', () => {
  assert.ok(matchScore(bidrl, 'Brother HC1850 Computerized Sewing and Quilting Machine, 185 Built-in Stitches') >= 0.6);
  assert.ok(matchScore(bidrl, 'Brother XM2701 Sewing Machine, Lightweight') < 0.6, 'different model');
  assert.ok(matchScore(bidrl, 'Singer Heavy Duty Sewing Machine') < 0.4, 'different brand');
});

test('pickMatch takes the cheapest confident, non-sponsored result', () => {
  const r = pickMatch(bidrl, [
    { title: 'Brother XM2701 Sewing Machine', price: 99 },
    { title: 'Brother HC1850 Sewing and Quilting Machine', price: 289.99, url: 'a' },
    { title: 'Brother HC1850 Sewing Quilting Machine Bundle', price: 240, sponsored: true },
    { title: 'Brother HC1850 Computerized Sewing and Quilting Machine', price: 259.5, url: 'b' },
  ], 0.6);
  assert.equal(r.status, 'matched');
  assert.equal(r.price, 259.5);
});

test('pickMatch reports weak matches without using them', () => {
  assert.equal(pickMatch(bidrl, [{ title: 'Thread spool set 40 colors', price: 12 }], 0.6).status, 'low_confidence');
  assert.equal(pickMatch(bidrl, [{ title: 'x', price: NaN }], 0.6).status, 'no_results');
  assert.equal(pickMatch(bidrl, [], 0.6).status, 'no_results');
});

test('generic titles use the median of similar listings, not the cheapest', async () => {
  const { isSpecific } = await import('../src/match.js');
  assert.equal(isSpecific('Light Fixture'), false);
  assert.equal(isSpecific('Mobile Metal Tool Cabinet'), false);
  assert.equal(isSpecific('Brother HC1850 Sewing Machine'), true);
  const r = pickMatch('Mobile Metal Tool Cabinet', [
    { title: 'Rolling Metal Tool Cabinet on Wheels, Mobile Storage', price: 89 },
    { title: 'Mobile Tool Cabinet, Metal, 5 Drawer', price: 159 },
    { title: 'Metal Tool Cabinet Mobile Workbench Chest', price: 249 },
    { title: 'Mobile Metal Tool Cabinet Mini Organizer', price: 12 },
    { title: 'Kids toy truck', price: 5 },
  ], 0.6);
  assert.equal(r.status, 'matched');
  assert.equal(r.generic, true);
  assert.equal(r.price, 124, 'median of 12, 89, 159, 249');
  assert.equal(r.url, null);
});

test('generic titles with fewer than 3 similar listings are not trusted', () => {
  const r = pickMatch('Light Fixture', [{ title: 'LED Light Fixture', price: 30 }, { title: 'Ceiling Light Fixture', price: 60 }], 0.6);
  assert.equal(r.status, 'low_confidence');
});

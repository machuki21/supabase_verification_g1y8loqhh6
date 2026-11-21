const $ = (sel) => document.querySelector(sel);
const money = (n) => (n === null || n === undefined ? '—' : `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const SOURCE_LABEL = { amazon: 'Amazon', listed_retail: 'listed retail', manual: 'your price' };
const STATUS_LABEL = { good: 'Good deal', fair: 'Fair', over: 'Over value', no_reference: 'No price' };

const state = {
  statuses: new Set(['good', 'fair']),
  limit: 60,
  status: null,
  view: 'deals',
};

const reload = () => (state.view === 'list' ? loadList() : loadDeals());
const WATCH_TEXT = {
  ok: (d) => `Next bid ${money(d.nextBid)} is under your max ${money(d.watch.effectiveMax)}.`,
  over_max: (d) => `Next bid ${money(d.nextBid)} is past your max ${money(d.watch.effectiveMax)}. Skip it or raise your max.`,
  no_max: (d) => `Next bid ${money(d.nextBid)}. Set a max bid below.`,
  ended: (d) => `Ended. Last bid ${money(d.currentBid)}. Check "My Bids" on BidRL to see if you won.`,
};

function savedFilters() {
  try {
    return JSON.parse(localStorage.getItem('filters') || '{}');
  } catch {
    return {};
  }
}
function saveFilters() {
  try {
    localStorage.setItem(
      'filters',
      JSON.stringify({ q: $('#q').value, city: $('#city').value, endsWithin: $('#endsWithin').value, source: $('#source').value, sort: $('#sort').value, statuses: [...state.statuses] }),
    );
  } catch {
    /* storage unavailable — fine */
  }
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function timeLeft(ms) {
  const d = ms - Date.now();
  if (d <= 0) return 'ended';
  const m = Math.floor(d / 60000);
  if (m < 60) return `${m}m left`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m left`;
  return `${Math.floor(h / 24)}d ${h % 24}h left`;
}

function ago(ts) {
  if (!ts) return 'never';
  const m = Math.round((Date.now() - ts) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

// ---------- status ----------

async function loadStatus() {
  try {
    const s = await api('/api/status');
    state.status = s;
    const parts = [];
    if (s.polling) parts.push('Refreshing from BidRL…');
    else if (s.lastPoll?.ok) parts.push(`${s.itemCount.toLocaleString()} open items in ${s.locations.length ? s.locations.join(' + ') : 'all locations'} · updated ${ago(s.lastPoll.finishedAt)}`);
    else if (s.lastPoll && !s.lastPoll.ok) parts.push(`Last refresh failed: ${s.lastPoll.error}`);
    else parts.push('First refresh in progress…');
    parts.push(s.amazon.enabled ? `Amazon lookups: ${s.amazon.remainingToday}/${s.amazon.dailyLimit} left today` : 'Amazon lookups off (listed retail + your prices only)');
    if (s.alertsEnabled) parts.push(`alerts on (reminder ${s.remindMinutes} min before starred items end)`);
    $('#list-count').textContent = s.watchCount ? `(${s.watchCount})` : '';
    $('#status').textContent = parts.join(' · ');
    $('#refresh').disabled = s.polling;
  } catch (err) {
    $('#status').textContent = `Can't reach the tracker: ${err.message}`;
  }
}

// ---------- settings ----------

async function loadSettings() {
  const s = await api('/api/settings');
  const f = $('#settings');
  f.targetSavingsPct.value = s.targetSavingsPct;
  f.salesTaxPct.value = s.salesTaxPct;
  f.extraFeePerItem.value = s.extraFeePerItem;
  f.trustListedRetail.checked = s.trustListedRetail;
}

$('#settings').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.currentTarget;
  try {
    await api('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({
        targetSavingsPct: f.targetSavingsPct.value,
        salesTaxPct: f.salesTaxPct.value,
        extraFeePerItem: f.extraFeePerItem.value,
        trustListedRetail: f.trustListedRetail.checked,
      }),
    });
    $('#settings-msg').textContent = 'Saved.';
    reload();
  } catch (err) {
    $('#settings-msg').textContent = err.message;
  }
});

$('#toggle-settings').addEventListener('click', (e) => {
  const panel = $('#settings');
  panel.hidden = !panel.hidden;
  e.currentTarget.setAttribute('aria-expanded', String(!panel.hidden));
});

// ---------- deals ----------

function renderCard(d) {
  const node = $('#card-tpl').content.firstElementChild.cloneNode(true);
  const link = d.url || '#';
  node.querySelector('.thumb').href = link;
  const img = node.querySelector('img');
  if (d.image) img.src = d.image;
  else img.remove();

  const badge = node.querySelector('.badge');
  badge.textContent = STATUS_LABEL[d.status];
  badge.classList.add(d.status);
  const ends = node.querySelector('.ends');
  ends.textContent = timeLeft(d.endsAt);
  ends.title = new Date(d.endsAt).toLocaleString();
  ends.dataset.ends = d.endsAt;
  if (d.endsAt - Date.now() < 3600000) ends.classList.add('soon');
  node.querySelector('.city').textContent = [d.city, d.lotNumber && `Lot ${d.lotNumber}`].filter(Boolean).join(' · ');

  const a = node.querySelector('.title a');
  a.textContent = d.title;
  a.href = link;

  node.querySelector('.ref').textContent = d.reference ? money(d.reference.price) : '—';
  node.querySelector('.ref').title = d.reference ? `Source: ${SOURCE_LABEL[d.reference.source]}` : '';
  node.querySelector('.next').textContent = money(d.nextBid);
  node.querySelector('.max').textContent = money(d.maxBid);
  node.querySelector('.walk').textContent = money(d.walkAwayBid);

  const sav = node.querySelector('.savings');
  if (d.reference) {
    const word = d.savingsAmount >= 0 ? 'save' : 'lose';
    sav.textContent = `At the next bid you pay ${money(d.nextAllIn)} all-in (${d.buyerPremiumPct}% premium + tax) — ${word} ${money(Math.abs(d.savingsAmount))} (${d.savingsPct}%) vs ${SOURCE_LABEL[d.reference.source]}.`;
  } else {
    sav.textContent = `Next bid ${money(d.nextBid)} = ${money(d.nextAllIn)} all-in. Set a price to get a max bid.`;
  }

  const match = node.querySelector('.match');
  if (d.override) match.textContent = 'Using your price.';
  else if (d.amazon?.status === 'matched') match.textContent = `Amazon match (${Math.round(d.amazon.confidence * 100)}% title match): ${d.amazon.title}`;
  else if (d.amazon?.status === 'low_confidence') match.textContent = `Amazon's closest result was a weak match (${Math.round(d.amazon.confidence * 100)}%), not used: ${d.amazon.title} — ${money(d.amazon.price)}`;
  else if (d.amazon?.status === 'no_results') match.textContent = 'No priced Amazon results.';
  else if (d.amazon?.status === 'error') match.textContent = `Amazon lookup failed: ${d.amazon.error}`;
  else if (d.reference?.source === 'listed_retail') match.textContent = 'Price is the retail value BidRL listed. Check it against Amazon before trusting it.';
  else match.remove();

  const flags = node.querySelector('.flags');
  if (d.flags.length) {
    for (const f of d.flags) {
      const s = document.createElement('span');
      s.textContent = f;
      if (f === 'sealed') s.className = 'ok';
      flags.append(s);
    }
  } else flags.remove();

  const az = node.querySelector('.az');
  if (d.amazon?.status === 'matched' && d.amazon.url) {
    az.href = d.amazon.url;
    az.textContent = 'View on Amazon';
  } else az.href = d.amazonSearchUrl;

  node.querySelector('.set-price').addEventListener('click', async () => {
    const price = prompt(`Price new for:\n${d.title}\n\nEnter what it costs new (e.g. on Amazon):`, d.reference?.price ?? '');
    if (price === null) return;
    const url = prompt('Link to that listing (optional):', d.override?.url || '') || undefined;
    try {
      await api(`/api/items/${d.id}/override`, { method: 'POST', body: JSON.stringify({ price: Number(price.replace(/[$,]/g, '')), url }) });
      reload();
    } catch (err) {
      alert(err.message);
    }
  });
  const clear = node.querySelector('.clear-price');
  if (d.override) {
    clear.hidden = false;
    clear.addEventListener('click', async () => {
      await api(`/api/items/${d.id}/override`, { method: 'DELETE', body: '{}' }).catch((err) => alert(err.message));
      reload();
    });
  }
  const lookup = node.querySelector('.lookup');
  if (state.status?.amazon.enabled) {
    lookup.hidden = false;
    lookup.textContent = d.amazon ? 'Re-check Amazon' : 'Check Amazon';
    lookup.addEventListener('click', async () => {
      lookup.disabled = true;
      lookup.textContent = 'Checking…';
      try {
        await api(`/api/items/${d.id}/lookup`, { method: 'POST', body: '{}' });
        await Promise.all([reload(), loadStatus()]);
      } catch (err) {
        alert(err.message);
        lookup.disabled = false;
        lookup.textContent = 'Check Amazon';
      }
    });
  }
  const want = node.querySelector('.want');
  want.textContent = d.wanted ? '★ Wanted' : '☆ Want';
  want.classList.toggle('on', Boolean(d.wanted));
  want.setAttribute('aria-pressed', String(Boolean(d.wanted)));
  if (d.wanted) node.classList.add('wanted');
  want.addEventListener('click', async () => {
    want.disabled = true;
    try {
      if (d.wanted) await api(`/api/watchlist/${d.id}`, { method: 'DELETE', body: '{}' });
      else await api(`/api/watchlist/${d.id}`, { method: 'PUT', body: JSON.stringify({ maxBid: null }) });
      await Promise.all([reload(), loadStatus()]);
    } catch (err) {
      alert(err.message);
      want.disabled = false;
    }
  });

  if (d.watch) renderWatch(node, d);
  return node;
}

function renderWatch(node, d) {
  const w = d.watch;
  const box = node.querySelector('.watch');
  box.hidden = false;
  const st = box.querySelector('.watch-status');
  st.textContent = WATCH_TEXT[w.status](d);
  st.className = `watch-status ${w.status}`;

  const form = box.querySelector('.watch-max');
  const input = form.maxBid;
  if (w.maxBid !== null) input.value = w.maxBid;
  input.placeholder = d.maxBid !== null ? String(d.maxBid) : '';
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api(`/api/watchlist/${d.id}`, { method: 'PUT', body: JSON.stringify({ maxBid: input.value === '' ? null : Number(input.value) }) });
      reload();
    } catch (err) {
      alert(err.message);
    }
  });
  if (w.status === 'ended') form.remove();

  const bid = box.querySelector('.bid-btn');
  const ended = w.status === 'ended';
  bid.textContent = ended ? 'Auction ended' : w.effectiveMax !== null ? `Bid on BidRL · max ${money(w.effectiveMax)}` : 'Open on BidRL';
  if (d.url && !ended) bid.href = d.url;
  else bid.classList.add('disabled');
  if (w.status === 'over_max') {
    bid.textContent = `Open on BidRL · past your max ${money(w.effectiveMax)}`;
    bid.classList.add('muted-btn');
  }

  const copy = box.querySelector('.copy');
  if (w.effectiveMax === null || ended) copy.remove();
  else
    copy.addEventListener('click', async () => {
      const text = w.effectiveMax.toFixed(2);
      try {
        await navigator.clipboard.writeText(text);
        copy.textContent = `Copied ${text}`;
      } catch {
        prompt('Copy your max bid:', text);
      }
    });

  const upd = box.querySelector('.update');
  const when = box.querySelector('.updated');
  when.textContent = w.refreshedAt ? `bid checked ${ago(w.refreshedAt)}` : '';
  if (ended) upd.remove();
  else
    upd.addEventListener('click', async () => {
      upd.disabled = true;
      upd.textContent = 'Checking…';
      try {
        await api(`/api/watchlist/${d.id}/refresh`, { method: 'POST', body: '{}' });
        reload();
      } catch (err) {
        alert(err.message);
        upd.disabled = false;
        upd.textContent = 'Update now';
      }
    });
}

async function loadList() {
  const seq = ++loadSeq;
  let data;
  try {
    data = await api('/api/watchlist');
  } catch (err) {
    $('#summary').textContent = `Couldn't load your list: ${err.message}`;
    return;
  }
  if (seq !== loadSeq) return;
  const live = data.entries.filter((e) => e.watch.status !== 'ended').length;
  $('#summary').textContent = `${live} active, ${data.entries.length - live} ended.`;
  const grid = $('#deals');
  if (!data.entries.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'Nothing here yet. Tap ☆ Want on any item in Deals to add it.';
    grid.replaceChildren(p);
  } else grid.replaceChildren(...data.entries.map(renderCard));
  $('#more').hidden = true;
}

function setView(v) {
  state.view = v;
  $('#tab-deals').classList.toggle('on', v === 'deals');
  $('#tab-list').classList.toggle('on', v === 'list');
  $('#tab-deals').setAttribute('aria-selected', String(v === 'deals'));
  $('#tab-list').setAttribute('aria-selected', String(v === 'list'));
  $('#filters').hidden = v === 'list';
  $('#list-help').hidden = v !== 'list';
  try {
    localStorage.setItem('view', v);
  } catch {
    /* fine */
  }
  reload();
}
$('#tab-deals').addEventListener('click', () => setView('deals'));
$('#tab-list').addEventListener('click', () => setView('list'));

let loadSeq = 0;
async function loadDeals() {
  const seq = ++loadSeq;
  const params = new URLSearchParams({ limit: state.limit, sort: $('#sort').value });
  if ($('#q').value.trim()) params.set('q', $('#q').value.trim());
  if ($('#city').value) params.set('city', $('#city').value);
  if ($('#endsWithin').value) params.set('endsWithin', $('#endsWithin').value);
  if ($('#source').value) params.set('source', $('#source').value);
  if (state.statuses.size) params.set('status', [...state.statuses].join(','));

  let data;
  try {
    data = await api(`/api/deals?${params}`);
  } catch (err) {
    $('#summary').textContent = `Couldn't load deals: ${err.message}`;
    return;
  }
  if (seq !== loadSeq) return;

  for (const chip of document.querySelectorAll('.chip')) chip.querySelector('b').textContent = data.counts[chip.dataset.status] ?? 0;

  const sel = $('#city');
  const current = sel.value;
  const cities = Object.entries(data.cities).sort((a, b) => b[1] - a[1]);
  sel.replaceChildren(new Option('All locations', ''), ...cities.map(([c, n]) => new Option(`${c} (${n})`, c)));
  sel.value = cities.some(([c]) => c === current) ? current : '';

  const s = data.settings;
  $('#summary').textContent = `${data.total.toLocaleString()} matching items. Max bid = ${s.targetSavingsPct}% under the new price, all-in with buyer's premium and ${s.salesTaxPct}% tax${s.extraFeePerItem ? ` + $${s.extraFeePerItem} per item` : ''}.`;

  const grid = $('#deals');
  if (!data.deals.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = state.status?.itemCount ? 'No items match these filters.' : 'Waiting for the first refresh from BidRL…';
    grid.replaceChildren(p);
  } else grid.replaceChildren(...data.deals.map(renderCard));
  $('#more').hidden = data.total <= data.deals.length;
}

// ---------- wiring ----------

function restoreFilters() {
  const f = savedFilters();
  if (f.q) $('#q').value = f.q;
  for (const k of ['endsWithin', 'source', 'sort']) if (f[k]) $(`#${k}`).value = f[k];
  if (f.city) $('#city').append(new Option(f.city, f.city, true, true));
  if (Array.isArray(f.statuses)) state.statuses = new Set(f.statuses);
  for (const chip of document.querySelectorAll('.chip')) chip.classList.toggle('on', state.statuses.has(chip.dataset.status));
}

const onFilter = () => {
  state.limit = 60;
  saveFilters();
  loadDeals();
};
let qTimer;
$('#q').addEventListener('input', () => {
  clearTimeout(qTimer);
  qTimer = setTimeout(onFilter, 250);
});
for (const id of ['#city', '#endsWithin', '#source', '#sort']) $(id).addEventListener('change', onFilter);
$('#status-chips').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  const s = chip.dataset.status;
  state.statuses.has(s) ? state.statuses.delete(s) : state.statuses.add(s);
  chip.classList.toggle('on');
  onFilter();
});
$('#more').addEventListener('click', () => {
  state.limit += 60;
  loadDeals();
});
$('#refresh').addEventListener('click', async () => {
  try {
    await api('/api/refresh', { method: 'POST', body: '{}' });
  } catch (err) {
    alert(err.message);
  }
  loadStatus();
});

// Keep countdowns ticking; reload data every minute (the server polls BidRL on its own schedule).
setInterval(() => {
  for (const el of document.querySelectorAll('.ends[data-ends]')) {
    el.textContent = timeLeft(Number(el.dataset.ends));
    el.classList.toggle('soon', Number(el.dataset.ends) - Date.now() < 3600000);
  }
}, 30000);
setInterval(() => {
  loadStatus();
  reload();
}, 60000);

restoreFilters();
await loadStatus();
let startView = 'deals';
try {
  startView = localStorage.getItem('view') === 'list' ? 'list' : 'deals';
} catch {
  /* fine */
}
await loadSettings();
setView(startView);

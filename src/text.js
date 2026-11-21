const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', reg: '®', trade: '™', copy: '©', deg: '°' };

export function decodeEntities(s) {
  if (!s) return '';
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code) => {
    if (code[0] === '#') {
      const cp = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return NAMED[code.toLowerCase()] ?? m;
  });
}

export function stripHtml(s) {
  return decodeEntities(String(s || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

const MONEY = '\\$\\s?(\\d{1,3}(?:,\\d{3})+(?:\\.\\d{1,2})?|\\d+(?:\\.\\d{1,2})?)';
const RETAIL_RE = new RegExp(`\\b(?:retail(?:s| price| value)?|msrp|list price|reg(?:ular)?\\.? price|original price|orig\\.? price)\\b\\s*(?:is|of|at|for)?\\s*[:=~-]?\\s*${MONEY}`, 'i');

/** Retail price the listing claims, e.g. "…, Retail $2,199". Returns null if none or implausible. */
export function parseListedRetail(...texts) {
  for (const t of texts) {
    const m = RETAIL_RE.exec(t || '');
    if (m) {
      const v = Number(m[1].replace(/,/g, ''));
      if (Number.isFinite(v) && v >= 1 && v <= 100000) return v;
    }
  }
  return null;
}

const RISK_WORDS = [
  ['untested', /\buntested\b/i],
  ['damaged', /\bdamage[ds]?\b/i],
  ['broken', /\bbroken\b/i],
  ['missing parts', /\bmissing\b/i],
  ['for parts', /\bfor parts\b|\bparts only\b/i],
  ['as-is', /\bas[- ]is\b/i],
  ['used', /\bused\b/i],
  ['open box', /\bopen(ed)?[- ]box\b/i],
  ['cosmetic wear', /\bscratch(es|ed)?\b|\bdent(s|ed)?\b/i],
  ['incomplete', /\bincomplete\b/i],
];

/** Condition flags found in the listing; "sealed" is the only positive one. */
export function conditionFlags(...texts) {
  const t = texts.filter(Boolean).join(' ');
  const flags = RISK_WORDS.filter(([, re]) => re.test(t)).map(([name]) => name);
  if (/\bfactory sealed\b|\bnew in (the )?box\b|\bbrand new\b|\bsealed\b/i.test(t)) flags.unshift('sealed');
  return flags;
}

const NOISE_RE = [
  new RegExp(`,?\\s*\\b(?:retail(?:s| price| value)?|msrp|list price)\\b\\s*[:=~-]?\\s*${MONEY}`, 'gi'),
  /,?\s*\b(?:factory sealed|new in (?:the )?box|brand new|open(?:ed)?[- ]box|untested|as[- ]is|sealed|value pack of)\b/gi,
  /\(\s*\)/g,
];

/** Listing title with auction boilerplate removed — what we'd type into Amazon search. */
export function searchQuery(title) {
  let q = decodeEntities(title);
  for (const re of NOISE_RE) q = q.replace(re, ' ');
  q = q.replace(/[|*"]+/g, ' ').replace(/\s+/g, ' ').replace(/^[\s,.-]+|[\s,.-]+$/g, '');
  const words = q.split(' ');
  return words.slice(0, 14).join(' ');
}

const STOP = new Set(['a', 'an', 'and', 'the', 'of', 'for', 'with', 'in', 'to', 'by', 'on', 'or', 'w', 'x', 'pack', 'count', 'ct', 'set', 'new', 'inch', 'in.', 'oz', 'fl', 'size']);

export function tokens(s) {
  return decodeEntities(s)
    .toLowerCase()
    .replace(/[®™©]/g, '')
    .replace(/(\d),(\d)/g, '$1$2')
    .split(/[^a-z0-9.]+/)
    .map((t) => t.replace(/^\.+|\.+$/g, ''))
    .filter((t) => t && !STOP.has(t));
}

export function cacheKey(query) {
  return tokens(query).join(' ');
}

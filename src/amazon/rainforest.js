// Rainforest API (Traject Data) search: https://docs.trajectdata.com/rainforestapi
export async function searchRainforest(query, { apiKey, domain = 'amazon.com', fetchImpl = fetch }) {
  const url = new URL('https://api.rainforestapi.com/request');
  url.search = new URLSearchParams({ api_key: apiKey, type: 'search', amazon_domain: domain, search_term: query }).toString();
  const res = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(45000) });
  if (!res.ok) throw new Error(`Rainforest HTTP ${res.status}`);
  const data = await res.json();
  if (data.request_info && data.request_info.success === false) {
    throw new Error(`Rainforest: ${data.request_info.message || 'request failed'}`);
  }
  return (data.search_results || []).map((r) => ({
    asin: r.asin || null,
    title: r.title || '',
    price: Number(r.price?.value ?? r.prices?.[0]?.value ?? NaN),
    url: r.link || (r.asin ? `https://www.${domain}/dp/${r.asin}` : null),
    sponsored: Boolean(r.sponsored),
  }));
}

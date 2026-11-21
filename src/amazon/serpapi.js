// SerpApi Amazon Search engine: https://serpapi.com/amazon-search-api
export async function searchSerpApi(query, { apiKey, domain = 'amazon.com', fetchImpl = fetch }) {
  const url = new URL('https://serpapi.com/search.json');
  url.search = new URLSearchParams({ engine: 'amazon', k: query, amazon_domain: domain, api_key: apiKey }).toString();
  const res = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`SerpApi HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(`SerpApi: ${data.error}`);
  return (data.organic_results || []).map((r) => ({
    asin: r.asin || null,
    title: r.title || '',
    price: Number(r.extracted_price ?? r.price?.extracted_value ?? NaN),
    url: r.link_clean || r.link || (r.asin ? `https://www.${domain}/dp/${r.asin}` : null),
    sponsored: Boolean(r.sponsored),
  }));
}

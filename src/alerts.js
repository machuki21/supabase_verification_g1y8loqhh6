const money = (n) => `$${n.toFixed(2)}`;

/** Push notifications for great deals via ntfy (https://ntfy.sh) and/or a Discord/Slack-style webhook. */
export function createAlerter(cfg, { fetchImpl = fetch, log = () => {} } = {}) {
  const enabled = Boolean(cfg.ntfyUrl || cfg.webhookUrl);

  function qualifies(deal, now = Date.now()) {
    return (
      deal.status === 'good' &&
      deal.reference &&
      deal.reference.price >= cfg.minReferencePrice &&
      deal.savingsPct >= cfg.minSavingsPct &&
      deal.endsAt > now &&
      deal.endsAt - now <= cfg.endsWithinHours * 3600000
    );
  }

  async function sendMessage({ title, body, url = null, tags = 'moneybag' }) {
    if (!enabled) return false;
    const jobs = [];
    if (cfg.ntfyUrl) {
      jobs.push(
        fetchImpl(cfg.ntfyUrl, {
          method: 'POST',
          body,
          headers: { Title: title.replace(/[^\x20-\x7e]/g, ''), ...(url ? { Click: url } : {}), Tags: tags },
          signal: AbortSignal.timeout(15000),
        }),
      );
    }
    if (cfg.webhookUrl) {
      const text = `**${title}**\n${body}${url ? `\n${url}` : ''}`;
      jobs.push(
        fetchImpl(cfg.webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: text, text }),
          signal: AbortSignal.timeout(15000),
        }),
      );
    }
    const results = await Promise.allSettled(jobs);
    for (const r of results) {
      if (r.status === 'rejected') log(`Alert failed: ${r.reason?.message || r.reason}`);
      else if (!r.value.ok) log(`Alert failed: HTTP ${r.value.status}`);
    }
    return results.some((r) => r.status === 'fulfilled' && r.value.ok);
  }

  function send(deal) {
    return sendMessage({
      title: `${deal.savingsPct}% off: ${deal.title.slice(0, 80)}`,
      body:
        `Next bid ${money(deal.nextBid)} (all-in ${money(deal.nextAllIn)}) vs ${deal.reference.source.replace('_', ' ')} ${money(deal.reference.price)}.\n` +
        `Max bid ${money(deal.maxBid)} · walk away above ${money(deal.walkAwayBid)}.\n` +
        `${deal.city} · ends ${new Date(deal.endsAt).toLocaleString()}`,
      url: deal.url,
    });
  }

  return { enabled, qualifies, send, sendMessage };
}

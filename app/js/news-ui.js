let newsRedraw = () => {};

export function registerNewsRedraw(fn) {
  newsRedraw = fn;
}

export let newsItems = [];
export const newsHits = [];

export function clearNewsForToggle() {
  newsItems = [];
  newsHits.length = 0;
}

export function newsHitKey(h) {
  if (!h) return '';
  const id = h.msgId != null ? String(h.msgId) : '';
  return `${h.t}:${id}:${(h.title || '').slice(0, 64)}`;
}

export function pickNewsHit(mx, my, headlinesOn, lastLayout) {
  if (!headlinesOn || !lastLayout) return null;
  const otop = lastLayout.ohlcTop + 2;
  const obot = lastLayout.ohlcBottom - 2;
  if (my < otop || my > obot || mx < lastLayout.pL || mx > lastLayout.xRight) return null;
  let best = null;
  let bestD = 10;
  for (const h of newsHits) {
    const d = Math.abs(mx - h.x);
    if (d < bestD) {
      bestD = d;
      best = h;
    }
  }
  return best;
}

function newsTipEl() {
  return document.getElementById('news-tip');
}

export function showNewsTip(title, url, macro, clientX, clientY) {
  const tip = newsTipEl();
  if (!tip) return;
  tip.hidden = false;
  tip.replaceChildren();
  const card = document.createElement('div');
  card.className = 'mirrorly-tip-card';
  const head = document.createElement('div');
  head.className = 'mirrorly-tip-mark';
  head.textContent = macro ? 'Macro · BTC tape' : 'Headline';
  const tEl = document.createElement('div');
  tEl.className = 'mirrorly-tip-news-body';
  tEl.textContent = title;
  card.append(head, tEl);
  if (url) {
    const a = document.createElement('a');
    a.className = 'mirrorly-tip-link';
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = 'Open link';
    card.appendChild(a);
  }
  tip.appendChild(card);
  const pad = 12;
  const tw = Math.min(440, Math.max(300, window.innerWidth - 2 * pad));
  let left = clientX + 16;
  let top = clientY + 16;
  left = Math.max(pad, Math.min(left, window.innerWidth - tw - pad));
  top = Math.max(pad, Math.min(top, window.innerHeight - 80));
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
  tip.style.width = `${tw}px`;
  tip.style.maxHeight = 'none';
}

export function hideNewsTip() {
  const tip = newsTipEl();
  if (tip) tip.hidden = true;
}

export async function fetchNews(headlinesOn) {
  if (!headlinesOn) return;
  try {
    const r = await fetch('/api/news', { cache: 'no-store' });
    if (!r.ok) return;
    const j = await r.json();
    newsItems = Array.isArray(j.items) ? j.items : [];
    newsRedraw();
  } catch (_e) {
    /* ignore */
  }
}

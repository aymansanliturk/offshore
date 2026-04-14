// Cloudflare Pages Function — functions/api/digest.js
//
// Fetches RSS feeds from dedicated offshore wind news sources server-side.
// No API key required. Categorises articles by keyword matching.
// Three sources are tried in parallel; any that fail are silently skipped.

const SOURCES = [
  {
    name: 'Offshore Wind Biz',
    url: 'https://www.offshorewind.biz/tag/denmark/feed/',
  },
  {
    name: 'Google News',
    url: 'https://news.google.com/rss/search?q=%22offshore+wind%22+denmark&hl=en-US&gl=US&ceid=US:en',
  },
  {
    name: 'Recharge News',
    url: 'https://rechargenews.com/tag/offshore-wind/feed/',
  },
];

// ── Categorisation keywords ───────────────────────────────────────────────────
// 'projects' is the default when no other category scores higher.

const CATEGORY_KEYWORDS = {
  approvals: [
    'permit', 'licens', 'approval', 'approved', 'consent',
    'authorization', 'authorisation', 'environmental assessment',
    'eia', 'planning permission', 'planning consent',
    'granted', 'cleared', 'rejected', 'refused', 'clearance',
  ],
  legislation: [
    'legislation', 'law ', 'regulation', 'policy', 'directive',
    'parliament', 'government', 'minister', 'ministry',
    'european commission', 'eu ', 'treaty', 'reform',
    'bill ', 'amendment', 'voted', 'vote ', 'ruling', 'decree',
  ],
  infrastructure: [
    'cable', 'substation', 'foundation', 'monopile', 'jacket',
    'transformer', 'hvdc', 'interconnect', 'array cable',
    'export cable', 'installation vessel', 'harbour', 'harbor',
    'maintenance', 'decommission', 'grid connection',
    'converter station', 'jack-up', 'cabling',
  ],
};

// ── XML helpers ───────────────────────────────────────────────────────────────

function extractTag(xml, tag) {
  const cdata = new RegExp(
    `<${tag}>[\\s]*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>[\\s]*<\\/${tag}>`, 'i',
  );
  let m = xml.match(cdata);
  if (m) return m[1].trim();

  const plain = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i');
  m = xml.match(plain);
  return m ? m[1].trim() : '';
}

function extractLink(xml) {
  // Standard <link>URL</link>
  let m = xml.match(/<link>([^<\s][^<]*)<\/link>/i);
  if (m) return m[1].trim();

  // CDATA link
  m = xml.match(/<link><!\[CDATA\[(.*?)\]\]><\/link>/i);
  if (m) return m[1].trim();

  // <guid isPermaLink="true">URL</guid>
  m = xml.match(/<guid[^>]*isPermaLink="true"[^>]*>(https?:\/\/[^<]+)<\/guid>/i);
  if (m) return m[1].trim();

  // <guid>https://…</guid>
  m = xml.match(/<guid[^>]*>(https?:\/\/[^<]+)<\/guid>/i);
  if (m) return m[1].trim();

  return '';
}

function stripHtml(html, maxLen = 220) {
  const text = html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen).replace(/\s\S*$/, '') + '…';
}

function parseItems(xml, defaultSource) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    const title = stripHtml(extractTag(block, 'title'), 160);
    const link  = extractLink(block);
    if (!title || !link) continue;

    // Google News items carry <source url="…">Publisher Name</source>
    const srcTag = block.match(/<source[^>]*>([^<]+)<\/source>/i);
    const source = srcTag ? srcTag[1].trim() : defaultSource;

    items.push({
      title,
      url:         link,
      description: stripHtml(extractTag(block, 'description')),
      source,
      pubDate:     extractTag(block, 'pubDate'),
    });
  }
  return items;
}

// ── Categorisation ────────────────────────────────────────────────────────────

function categorize(title, description) {
  const text = `${title} ${description}`.toLowerCase();
  const scores = { approvals: 0, legislation: 0, infrastructure: 0 };
  for (const [cat, kws] of Object.entries(CATEGORY_KEYWORDS)) {
    for (const kw of kws) if (text.includes(kw)) scores[cat]++;
  }
  let best = 'projects', bestScore = 0;
  for (const [cat, score] of Object.entries(scores)) {
    if (score > bestScore) { bestScore = score; best = cat; }
  }
  return best;
}

// ── Deduplication ─────────────────────────────────────────────────────────────

function dedup(items) {
  const kept = [];
  for (const item of items) {
    const words = new Set(
      item.title.toLowerCase().split(/\W+/).filter(w => w.length > 3),
    );
    const isDupe = kept.some(k => {
      const kWords = new Set(k.title.toLowerCase().split(/\W+/).filter(w => w.length > 3));
      const shared = [...words].filter(w => kWords.has(w)).length;
      return shared / Math.max(words.size, kWords.size, 1) > 0.6;
    });
    if (!isDupe) kept.push(item);
  }
  return kept;
}

// ── URL safety ────────────────────────────────────────────────────────────────

function safeUrl(url) {
  try {
    const u = new URL(url);
    return (u.protocol === 'http:' || u.protocol === 'https:') ? url : null;
  } catch { return null; }
}

// ── Source fetch ──────────────────────────────────────────────────────────────

async function fetchSource(source) {
  try {
    const res = await fetch(source.url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OffshoreWindDigest/1.0)' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    return parseItems(await res.text(), source.name);
  } catch {
    return [];
  }
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function onRequest() {
  const results = await Promise.all(SOURCES.map(fetchSource));
  const sourcesLive = results.filter(r => r.length > 0).length;

  // Merge, sort newest-first, deduplicate
  const items = dedup(
    results.flat().sort((a, b) => new Date(b.pubDate || 0) - new Date(a.pubDate || 0)),
  );

  const digest = {
    date: new Date().toLocaleDateString('en-US', {
      month: 'long', day: 'numeric', year: 'numeric',
    }),
    sourcesLive,
    infrastructure: [],
    legislation:    [],
    approvals:      [],
    projects:       [],
  };

  for (const item of items) {
    const cat = categorize(item.title, item.description);
    digest[cat].push({
      title:       item.title,
      url:         safeUrl(item.url) || '',
      description: item.description,
      source:      item.source,
      pubDate:     item.pubDate,
    });
  }

  return new Response(JSON.stringify(digest), {
    headers: { 'Content-Type': 'application/json' },
  });
}

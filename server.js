const express = require('express');
const cors = require('cors');
const cheerio = require('cheerio');

const app = express();
app.use(cors());
app.use(express.json());

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// ─── Helper: Summarize text with Claude ───────────────────────────────────────
async function summarizeWithClaude(articleText, title = '') {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system: `You are an expert article analyst. Given article content, produce a concise analysis.
Respond ONLY in this JSON format (no markdown, no backticks):
{
  "title": "Article title (use given title or infer from content)",
  "summary": "3-5 sentence summary capturing the core message",
  "takeaways": ["emoji + key takeaway", "emoji + key takeaway", "emoji + key takeaway", "emoji + key takeaway"],
  "readTime": "estimated read time like '4 min read'"
}`,
      messages: [
        {
          role: 'user',
          content: `Title: ${title}\n\nArticle content:\n${articleText.slice(0, 6000)}`,
        },
      ],
    }),
  });

  const data = await response.json();
  if (!data.content) {
    console.error('Claude API error:', JSON.stringify(data));
    throw new Error(data.error?.message || 'Claude API returned no content');
  }
  const text = data.content.map((b) => b.text || '').join('');
  return JSON.parse(text.trim());
}

// ─── Helper: Scrape article text from a URL ───────────────────────────────────
async function scrapeArticle(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
    },
  });
  const html = await response.text();
  const $ = cheerio.load(html);

  $('script, style, nav, footer, header, aside, .ad, .ads, .advertisement, .sidebar, .menu').remove();

  const title =
    $('h1').first().text().trim() ||
    $('meta[property="og:title"]').attr('content') ||
    $('title').text().trim() || '';

  const selectors = ['article', '[role="main"]', '.article-body', '.post-content', '.entry-content', '.story-body', 'main'];
  let articleText = '';
  for (const sel of selectors) {
    const el = $(sel);
    if (el.length) {
      articleText = el.text().replace(/\s+/g, ' ').trim();
      if (articleText.length > 200) break;
    }
  }
  if (!articleText || articleText.length < 200) {
    articleText = $('body').text().replace(/\s+/g, ' ').trim();
  }

  return { title, text: articleText };
}

// ─── Helper: Fetch RSS feed ───────────────────────────────────────────────────
async function fetchRSS(feedUrl) {
  const response = await fetch(feedUrl);
  const xml = await response.text();
  const $ = cheerio.load(xml, { xmlMode: true });

  const items = [];
  $('item, entry').each((_, el) => {
    const $el = $(el);
    const link = $el.find('link').first().text().trim() || $el.find('link').attr('href') || '';
    const title = $el.find('title').first().text().trim();
    const pubDate = $el.find('pubDate, published, updated').first().text().trim();
    const description = $el.find('description, summary, content').first().text()
      .replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (link && title) items.push({ title, link, pubDate, description });
  });

  return items.slice(0, 20);
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────

app.post('/summarize-url', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });
  try {
    const { title, text } = await scrapeArticle(url);
    if (text.length < 100) return res.status(422).json({ error: 'Could not extract enough text.' });
    const result = await summarizeWithClaude(text, title);
    res.json({ ...result, url });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Failed to scrape or summarize.' });
  }
});

app.post('/summarize-text', async (req, res) => {
  const { text, title } = req.body;
  if (!text) return res.status(400).json({ error: 'Text is required' });
  try {
    const result = await summarizeWithClaude(text, title || '');
    res.json(result);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Failed to summarize text.' });
  }
});

app.post('/fetch-rss', async (req, res) => {
  const { feedUrl } = req.body;
  if (!feedUrl) return res.status(400).json({ error: 'feedUrl is required' });
  try {
    const articles = await fetchRSS(feedUrl);
    res.json({ articles });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Failed to fetch RSS feed.' });
  }
});

app.post('/summarize-rss-item', async (req, res) => {
  const { url, title } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });
  try {
    const { text } = await scrapeArticle(url);
    const result = await summarizeWithClaude(text, title || '');
    res.json({ ...result, url });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Failed to summarize.' });
  }
});

app.get('/health', (_, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`ArticleLens backend running on port ${PORT}`));

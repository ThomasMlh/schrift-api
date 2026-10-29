/**
 * Official summon banners, read from the in-game news of each summon (m_gacha_group.news_id). The news
 * page is fetched once from urahara-shop, which serves the game news, then archived on the FTP outside
 * the public bucket: later syncs read the archive. The page links the 960x320 banner of the news,
 * published per client language at the same path.
 */
import { PRIMARY_LANGUAGE } from './source.js';

const NEWS_FTP_PATH = () => process.env.GAME_NEWS_FTP_PATH || '/game-news';
const NEWS_SOURCE_URL = () => process.env.GAME_NEWS_SOURCE_URL || 'https://urahara-shop.red/DataLoad/game/news';
const FETCH_TIMEOUT_MS = 30000;
const PNG_SIGNATURE = '89504e47';

const BANNER_PATTERN = /https:\/\/prod-web-game\d+\.akamaized\.net\/[a-z]{2}\/generated_image\/\d+\/News\/\d+\/banner_image_[0-9a-f]+\.png/;

export const newsArchivePath = (newsId, language = PRIMARY_LANGUAGE) => `${NEWS_FTP_PATH()}/${language}/${newsId}.html`;

export const newsSourceUrl = (newsId, language = PRIMARY_LANGUAGE) => (
  `${NEWS_SOURCE_URL()}?lang=${language}&path=${encodeURIComponent(`news/view?id=${newsId}`)}`
);

// Banner of the news in a language: the page links the one of its own language, the others share its path
export const newsBannerUrl = (html, language) => {
  const match = BANNER_PATTERN.exec(html ?? '');
  return match ? match[0].replace(/\.net\/[a-z]{2}\/generated_image\//, `.net/${language}/generated_image/`) : null;
};

const fetchWithTimeout = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status} pour ${url}`), { status: response.status });
  return response;
};

// News page from the FTP archive, fetched and archived when it is not there yet
export const readSummonNews = async (ftp, newsId) => {
  const path = newsArchivePath(newsId);
  try {
    return (await ftp.downloadBuffer(path)).toString('utf8');
  } catch (err) {
    if (err.status !== 404) throw err;
  }
  const html = await (await fetchWithTimeout(newsSourceUrl(newsId))).text();
  if (!html.includes('news-view')) throw new Error(`Annonce ${newsId} introuvable`);
  await ftp.uploadBuffer(Buffer.from(html, 'utf8'), path);
  return html;
};

// PNG at the URL, null when the language has no such banner (the server then redirects to an error page)
export const downloadNewsBanner = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'manual' });
  if (!response.ok) return null;
  const buffer = Buffer.from(await response.arrayBuffer());
  return buffer.subarray(0, 4).toString('hex') === PNG_SIGNATURE ? buffer : null;
};

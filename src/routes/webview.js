import express from 'express';
import { requireAdmin, requireDb } from '../middleware/auth.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

/**
 * Proxy for the Bleach Brave Souls web views (announcements, history, help…).
 *
 * The HTML is rendered by game-gl.bleach-bravesouls.com and requires:
 *   - a valid X-WEB-VIEW-TOKEN cookie (content lock, expires)
 *   - static headers (world, device, platform, language…)
 * Assets (CSS/JS/images) are public on the Akamai CDN and loaded directly by the browser, so ONLY
 * the HTML document is proxied.
 *
 * The token (captured from the game) is PERSISTED in MongoDB (webview_config collection,
 * _id="default") and updated through PUT /api/webview/_admin/token (admin).
 */

const APP_HOST = 'game-gl.bleach-bravesouls.com';
const COLLECTION = 'webview_config';
const CONFIG_ID = 'default';

// Allowed web view routes (first segment). Everything else is rejected to avoid an open proxy to
// the account API (player/*, etc.).
const ALLOWED_PREFIXES = new Set([
  'news', 'help', 'information',
  'evolved_character_list', 'team_battle_reward', 'gacha_rate', 'static',
]);

const SUPPORTED_LANGS = new Set(['fr', 'en', 'ja', 'ko', 'th']);

// Stable, non-secret fields: defaults, overridden by Mongo.
const DEFAULTS = {
  world: process.env.BBS_WORLD || 'gl',
  bundleVersion: process.env.BBS_BUNDLE_VERSION || '18.0.10',
  clientOs: process.env.BBS_CLIENT_OS || 'WINDOWS',
  platform: process.env.BBS_PLATFORM || 'STEAM',
  timezone: process.env.BBS_TIMEZONE || 'Europe/Paris',
  defaultLang: process.env.BBS_DEFAULT_LANG || 'fr',
  userAgent: process.env.BBS_USER_AGENT
    || '/BleachBraveSouls/i:com.klab.bleach.prod/u:2022.3.67f2/'
       + 'd:CUSTOM/o:Windows 11 (10.0.26200) 64bit/m:/e:s/',
  token: process.env.BBS_WEBVIEW_TOKEN || '',
  deviceId: process.env.BBS_DEVICE_ID || '',
};

/** Effective config = defaults + Mongo document. */
const getConfig = async (db) => {
  const doc = await db.collection(COLLECTION).findOne({ _id: CONFIG_ID });
  return { ...DEFAULTS, ...(doc || {}) };
};

const appHeaders = (cfg, lang) => ({
  'Cookie': `X-WEB-VIEW-TOKEN=${cfg.token}`,
  'X-WORLD': cfg.world,
  'X-DEVICE-ID': cfg.deviceId,
  'X-PLATFORM': cfg.platform,
  'X-CLIENT-OS': cfg.clientOs,
  'X-CLIENT-TIMEZONE': cfg.timezone,
  'X-BUNDLE-VERSION': cfg.bundleVersion,
  'X-LANGUAGE': lang,
  'User-Agent': cfg.userAgent,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
});

const BASE = '/api/webview';

/** Rewrites internal navigation links so they stay within the proxy. */
const rewriteHtml = (html, lang) => html.replace(/Transition\('\/([^']*)'\)/g, (_m, path) => {
  const sep = path.includes('?') ? '&' : '?';
  return `Transition('${BASE}/${path}${sep}lang=${lang}')`;
});

/** Heuristic: is the token-locked content present? */
const looksAuthenticated = (html) =>
  /news-view-title|_news-index-flick-item|_news-history|common-main-img/.test(html);

router.use(requireDb);

// PUT save or update the token (persisted in Mongo)
router.put('/_admin/token', requireAdmin, express.json(), async (req, res) => {
  const { token, deviceId, world, bundleVersion, userAgent } = req.body || {};
  if (!token || typeof token !== 'string') {
    return res.status(400).json({ success: false, message: 'token requis' });
  }
  const set = { token: token.trim(), updatedAt: new Date().toISOString() };
  if (deviceId) set.deviceId = String(deviceId).trim();
  if (world) set.world = String(world).trim();
  if (bundleVersion) set.bundleVersion = String(bundleVersion).trim();
  if (userAgent) set.userAgent = String(userAgent);

  await req.db.collection(COLLECTION).updateOne(
    { _id: CONFIG_ID }, { $set: set }, { upsert: true },
  );

  // Live check, to report right away whether the token works
  const cfg = await getConfig(req.db);
  let authenticated = null;
  try {
    const r = await fetch(`https://${APP_HOST}/news/index`, {
      headers: appHeaders(cfg, cfg.defaultLang),
    });
    authenticated = looksAuthenticated(await r.text());
  } catch { authenticated = null; }

  res.json({
    success: true,
    message: 'Token enregistre',
    updatedAt: set.updatedAt,
    authenticated,
  });
});

// GET token status with a live check
router.get('/_admin/status', requireAdmin, async (req, res) => {
  const cfg = await getConfig(req.db);
  const mask = (t) => (t ? `${t.slice(0, 6)}…(${t.length})` : '(vide)');
  let live = null;
  try {
    const r = await fetch(`https://${APP_HOST}/news/index`, {
      headers: appHeaders(cfg, cfg.defaultLang),
    });
    const body = await r.text();
    live = { status: r.status, authenticated: looksAuthenticated(body), bytes: body.length };
  } catch (e) {
    live = { error: e.message };
  }
  res.json({
    success: true,
    config: {
      token: mask(cfg.token),
      deviceId: mask(cfg.deviceId),
      world: cfg.world,
      bundleVersion: cfg.bundleVersion,
      updatedAt: cfg.updatedAt || null,
    },
    live,
  });
});

// Proxy. Express 5 named wildcard (req.params.splat is an array of segments)
router.get('/*splat', async (req, res) => {
  const cfg = await getConfig(req.db);
  if (!cfg.token || !cfg.deviceId) {
    return res.status(503).json({
      success: false,
      message: 'Proxy non configure : definis le token via PUT /api/webview/_admin/token',
    });
  }

  const splat = req.params.splat;
  const path = (Array.isArray(splat) ? splat.join('/') : splat) || 'news/index';
  const firstSeg = path.split('/')[0];
  if (!ALLOWED_PREFIXES.has(firstSeg)) {
    return res.status(403).json({ success: false, message: `Route non autorisee: ${firstSeg}` });
  }

  let lang = (req.query.lang || cfg.defaultLang).toString();
  if (!SUPPORTED_LANGS.has(lang)) lang = cfg.defaultLang;

  const params = new URLSearchParams(req.query);
  params.delete('lang');
  const qs = params.toString();
  const target = `https://${APP_HOST}/${path}${qs ? `?${qs}` : ''}`;

  try {
    const upstream = await fetch(target, { headers: appHeaders(cfg, lang) });
    const ct = upstream.headers.get('content-type') || '';
    const body = await upstream.text();

    if (upstream.status === 200 && ct.includes('text/html')) {
      if (!looksAuthenticated(body)) {
        logger.warn(`[webview] token probablement expire (${path})`);
      }
      res.set('Content-Type', 'text/html; charset=UTF-8');
      return res.status(200).send(rewriteHtml(body, lang));
    }
    res.status(upstream.status);
    if (ct) res.set('Content-Type', ct);
    return res.send(body);
  } catch (e) {
    logger.error('[webview] erreur proxy:', e.message);
    return res.status(502).json({ success: false, message: 'Erreur proxy amont' });
  }
});

export default router;

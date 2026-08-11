import express from 'express';
import { requireAdmin, requireDb } from '../middleware/auth.js';

const router = express.Router();

/**
 * Proxy des WebViews de Bleach Brave Souls (annonces, historique, aide…).
 *
 * Le HTML est rendu par game-gl.bleach-bravesouls.com et necessite :
 *   - un cookie X-WEB-VIEW-TOKEN valide (verrou du contenu, expire)
 *   - des en-tetes statiques (monde, appareil, plateforme, langue…)
 * Les assets (CSS/JS/images) sont publics sur le CDN Akamai : le navigateur
 * les charge directement, on ne proxifie donc QUE le document HTML.
 *
 * Le token (capture depuis le jeu) est PERSISTE dans MongoDB (collection
 * webview_config, doc _id="default") et mis a jour via
 *   PUT /api/webview/_admin/token  (admin).
 */

const APP_HOST = 'game-gl.bleach-bravesouls.com';
const COLLECTION = 'webview_config';
const CONFIG_ID = 'default';

// Routes webview autorisees (1er segment). Tout le reste est refuse pour eviter
// un proxy ouvert vers l'API compte (player/*, etc.).
const ALLOWED_PREFIXES = new Set([
  'news', 'help', 'information',
  'evolved_character_list', 'team_battle_reward', 'gacha_rate', 'static',
]);

const SUPPORTED_LANGS = new Set(['fr', 'en', 'ja', 'ko', 'th']);

// Champs stables (non secrets) : valeurs par defaut, surchargees par Mongo.
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

/** Config effective = defauts + document Mongo. */
async function getConfig(db) {
  const doc = await db.collection(COLLECTION).findOne({ _id: CONFIG_ID });
  return { ...DEFAULTS, ...(doc || {}) };
}

function appHeaders(cfg, lang) {
  return {
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
  };
}

const BASE = '/api/webview';

/** Reecrit les liens de navigation internes pour rester dans le proxy. */
function rewriteHtml(html, lang) {
  return html.replace(/Transition\('\/([^']*)'\)/g, (_m, path) => {
    const sep = path.includes('?') ? '&' : '?';
    return `Transition('${BASE}/${path}${sep}lang=${lang}')`;
  });
}

/** Heuristique : le contenu verrouille par le token est-il present ? */
function looksAuthenticated(html) {
  return /news-view-title|_news-index-flick-item|_news-history|common-main-img/
    .test(html);
}

router.use(requireDb);

// ----------------------------------------------------------------- admin
// Enregistre / met a jour le token (persiste dans Mongo).
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

  // verif live immediate pour dire tout de suite si le token est bon
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

// Etat du token + verification live.
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

// ----------------------------------------------------------------- proxy
// Express 5 : wildcard nomme (req.params.splat = tableau de segments)
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
        console.warn(`[webview] token probablement expire (${path})`);
      }
      res.set('Content-Type', 'text/html; charset=UTF-8');
      return res.status(200).send(rewriteHtml(body, lang));
    }
    res.status(upstream.status);
    if (ct) res.set('Content-Type', ct);
    return res.send(body);
  } catch (e) {
    console.error('[webview] erreur proxy:', e.message);
    return res.status(502).json({ success: false, message: 'Erreur proxy amont' });
  }
});

export default router;

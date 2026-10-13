import express from 'express';
import jwt from 'jsonwebtoken';
import { requireDb } from '../middleware/auth.js';
import { authLimiter } from '../middleware/rateLimit.js';
import { upsertPrimaryAccount, deriveMirrorFields, buildGuildRoles } from '../utils/bbsAccounts.js';
import players from '../assets/joueurs.json' with { type: "json" };
import { logger } from '../utils/logger.js';

const router = express.Router();

// In-memory Discord token cache
const tokenCache = new Map();
// Recent user data cache (avoids repeated Discord API calls)
const userDataCache = new Map();

// Drops expired tokens from the cache
const cleanExpiredTokens = () => {
    const now = Date.now();
    for (const [discordId, tokenData] of tokenCache.entries()) {
        if (tokenData.expires_at <= now) {
            tokenCache.delete(discordId);
        }
    }
    // User data is kept for 5 minutes
    for (const [discordId, userData] of userDataCache.entries()) {
        if (userData.cached_at + (5 * 60 * 1000) <= now) {
            userDataCache.delete(discordId);
        }
    }
};

// Clean the cache every 10 minutes
setInterval(cleanExpiredTokens, 10 * 60 * 1000);

router.use(requireDb);

// Discord OAuth configuration, read lazily (after dotenv.config())
const getDiscordConfig = () => ({
    DISCORD_CLIENT_ID: process.env.DISCORD_CLIENT_ID,
    DISCORD_CLIENT_SECRET: process.env.DISCORD_CLIENT_SECRET,
    DISCORD_REDIRECT_URI: process.env.DISCORD_REDIRECT_URI,
    JWT_SECRET: process.env.JWT_SECRET,
    ADMIN_DISCORD_IDS: process.env.ADMIN_DISCORD_IDS ? process.env.ADMIN_DISCORD_IDS.split(',') : [],
    DISCORD_GUILD_ID: process.env.DISCORD_GUILD_ID
});

// Exchanges a code for a Discord access token. redirectUri is omitted for the Activity flow
// (embedded SDK, no browser redirect) and required for the web flow.
const exchangeCodeForToken = async ({ code, redirectUri }) => {
    const { DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET } = getDiscordConfig();

    const params = {
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code: code,
    };
    if (redirectUri) {
        params.redirect_uri = redirectUri;
    }

    const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams(params),
    });

    if (!tokenResponse.ok) {
        const errorData = await tokenResponse.text();
        logger.error('❌ Erreur Discord API:', errorData);
        logger.error('❌ Status:', tokenResponse.status);
        logger.error('❌ Headers:', Object.fromEntries(tokenResponse.headers.entries()));
        return {
            ok: false,
            status: 400,
            body: {
                success: false,
                message: 'Erreur lors de l\'échange du code',
                details: errorData,
                status: tokenResponse.status
            }
        };
    }

    return { ok: true, tokenData: await tokenResponse.json() };
};

// Everything after obtaining a valid Discord access token: user info, ban/guild checks, Mongo
// upsert and JWT issuance. Shared by the web flow (/discord/callback) and the Activity flow
// (/discord/activity-callback).
const completeDiscordLogin = async (req, tokenData) => {
    try {
        const { JWT_SECRET, ADMIN_DISCORD_IDS, DISCORD_GUILD_ID } = getDiscordConfig();

        const userResponse = await fetch('https://discord.com/api/users/@me', {
            headers: {
                'Authorization': `Bearer ${tokenData.access_token}`,
            },
        });

        if (!userResponse.ok) {
            const errorData = await userResponse.text();
            logger.error('❌ Erreur récupération utilisateur:', errorData);
            return {
                ok: false,
                status: 400,
                body: {
                    success: false,
                    message: 'Erreur lors de la récupération des données utilisateur',
                    details: errorData
                }
            };
        }

        const userData = await userResponse.json();

        // Cache the new token (the initial exchange always happens)
        tokenCache.set(userData.id, {
            access_token: tokenData.access_token,
            refresh_token: tokenData.refresh_token,
            expires_at: Date.now() + (tokenData.expires_in * 1000),
            discord_id: userData.id
        });
        logger.info('💾 Token Discord mis en cache pour', userData.username);

        const activeToken = tokenData.access_token;

        // Connections and guilds, cached to avoid repeated calls
        let connections = [];
        let guilds = [];
        
        const cachedUserData = userDataCache.get(userData.id);
        const now = Date.now();
        
        if (cachedUserData && (cachedUserData.cached_at + (5 * 60 * 1000)) > now) {
            // Use cached data when it is less than 5 minutes old
            logger.info('🔄 Utilisation des données utilisateur en cache pour', userData.username);
            connections = cachedUserData.connections;
            guilds = cachedUserData.guilds;
        } else {
            try {
                const connectionsResponse = await fetch('https://discord.com/api/users/@me/connections', {
                    headers: {
                        'Authorization': `Bearer ${activeToken}`,
                    },
                });
                if (connectionsResponse.ok) {
                    connections = await connectionsResponse.json();
                }
            } catch (error) {
                logger.warn('⚠️ Impossible de récupérer les connexions utilisateur:', error);
            }

            const guildsResponse = await fetch('https://discord.com/api/users/@me/guilds', {
                headers: {
                    'Authorization': `Bearer ${activeToken}`,
                },
            });

            if (guildsResponse.ok) {
                guilds = await guildsResponse.json();
            }

            userDataCache.set(userData.id, {
                connections,
                guilds,
                cached_at: now
            });
            logger.info('💾 Données utilisateur mises en cache pour', userData.username);
        }

        const isAdmin = ADMIN_DISCORD_IDS.includes(userData.id);

        const existingUser = await req.db.collection('users').findOne({ discord_id: userData.id });

        // 1. Banned users are rejected
        if (existingUser?.is_banned) {
            logger.warn('⛔ Utilisateur banni:', userData.username);
            return {
                ok: false,
                status: 403,
                body: {
                    success: false,
                    message: 'Votre compte a été banni.',
                    reason: existingUser.ban_reason || null
                }
            };
        }

        // 2. The user must be a member of the required Discord server
        const isAuthorized = DISCORD_GUILD_ID
            ? guilds.some(g => g.id === DISCORD_GUILD_ID)
            : true;

        if (!isAuthorized) {
            logger.warn('⛔ Utilisateur non autorisé (guild manquante):', userData.username);
            return {
                ok: false,
                status: 403,
                body: {
                    success: false,
                    message: 'Vous n\'êtes pas autorisé à vous connecter. Vous devez être membre du serveur Discord.'
                }
            };
        }
        
        let playerInfo = null;
        if (players.joueurs && Array.isArray(players.joueurs)) {
            playerInfo = players.joueurs.find(p => p.id_discord === userData.id);
        }

        let guildeInfo = null;
        if (playerInfo && playerInfo.guilde) {
            // Look the guild up by name
            const extractGuildName = playerInfo.guilde.split(' ')[1];
            guildeInfo = await req.db.collection('guildes').findOne({
                name: extractGuildName
            });
        }

        let roleInfo = null;
        if (playerInfo && playerInfo.statut) {
            roleInfo = playerInfo.statut.toLowerCase();
        }

        // The "main" bbs account keeps its historical meaning: once linked (manually or from the external
        // roster) it is never overwritten by playerInfo on later logins. Alt accounts are only managed from
        // the admin (users routes).
        const bbsId = existingUser?.bbs_id || playerInfo?.id_bbs || null;
        const bbsName = existingUser?.bbs_name || playerInfo?.pseudo_bbs || null;
        const guildeId = existingUser?.guilde_id || guildeInfo?._id?.toString() || null;
        const role = existingUser?.role || roleInfo || null;
        const bbsAccounts = upsertPrimaryAccount(existingUser?.bbs_accounts, { bbsId, bbsName, guildeId, role });
        const mirror = deriveMirrorFields(bbsAccounts);

        // Create or update the user. Discord tokens are NOT stored in the database.
        const user = {
            discord_id: userData.id,
            username: userData.username,
            global_name: userData.global_name,
            discriminator: userData.discriminator,
            avatar: userData.avatar,
            email: userData.email,
            locale: userData.locale,
            flags: userData.flags,
            premium_type: userData.premium_type,
            public_flags: userData.public_flags,
            banner: userData.banner,
            banner_color: userData.banner_color,
            accent_color: userData.accent_color,
            connections: connections,
            bbs_accounts: bbsAccounts,
            bbs_id: mirror.bbs_id,
            bbs_name: mirror.bbs_name,
            guilde_id: mirror.guilde_id,
            role: mirror.role,
            is_admin: isAdmin,
            is_authorized: isAuthorized,
            last_login: new Date()
        };

        await req.db.collection('users').updateOne(
            { discord_id: userData.id },
            { $set: user },
            { upsert: true }
        );

        // Re-read the user to get its _id
        const savedUser = await req.db.collection('users').findOne({ discord_id: userData.id });

        // JWT with a minimal payload (the rest lives in the database)
        const jwtPayload = {
            _id: savedUser._id,
            discord_id: userData.id,
            is_admin: isAdmin,
            role: user.role,
            guilde_id: user.guilde_id,
            guild_roles: buildGuildRoles(bbsAccounts),
        };

        const jwtToken = jwt.sign(jwtPayload, JWT_SECRET, { expiresIn: '24h' });
        const refreshToken = jwt.sign({ _id: savedUser._id, discord_id: userData.id, type: 'refresh' }, JWT_SECRET, { expiresIn: '7d' });

        // Store the hashed refresh token
        const crypto = await import('crypto');
        const refreshTokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
        await req.db.collection('users').updateOne(
            { discord_id: userData.id },
            { $set: { refresh_token_hash: refreshTokenHash } }
        );

        return {
            ok: true,
            body: {
                success: true,
                token: jwtToken,
                refreshToken,
                user: {
                    global_name: userData.global_name,
                    isAuthorized: isAuthorized
                }
            }
        };

    } catch (error) {
        logger.error('❌ Erreur lors de l\'authentification Discord:', error);
        return {
            ok: false,
            status: 500,
            body: { success: false, message: 'Erreur serveur lors de l\'authentification' }
        };
    }
};

// POST exchange an authorization code for a token (web flow, browser redirect)
router.post('/discord/callback', authLimiter, async (req, res) => {
    const { code } = req.body;
    const { DISCORD_REDIRECT_URI } = getDiscordConfig();

    if (!code) {
        return res.status(400).json({ success: false, message: 'Code d\'autorisation manquant' });
    }

    // Always use the server-side redirect_uri
    const exchange = await exchangeCodeForToken({ code, redirectUri: DISCORD_REDIRECT_URI });
    if (!exchange.ok) {
        return res.status(exchange.status).json(exchange.body);
    }

    const result = await completeDiscordLogin(req, exchange.tokenData);
    return res.status(result.ok ? 200 : result.status).json(result.body);
});

// POST exchange an authorization code for a token (Discord Activity flow, embedded SDK).
// No redirect_uri: the code comes from discordSdk.commands.authorize(), not a browser redirect.
router.post('/discord/activity-callback', authLimiter, async (req, res) => {
    const { code } = req.body;

    if (!code) {
        return res.status(400).json({ success: false, message: 'Code d\'autorisation manquant' });
    }

    const exchange = await exchangeCodeForToken({ code, redirectUri: undefined });
    if (!exchange.ok) {
        return res.status(exchange.status).json(exchange.body);
    }

    const result = await completeDiscordLogin(req, exchange.tokenData);
    if (!result.ok) {
        return res.status(result.status).json(result.body);
    }

    // Needed by the client for discordSdk.commands.authenticate({ access_token })
    return res.status(200).json({
        ...result.body,
        discord_access_token: exchange.tokenData.access_token
    });
});

// POST refresh the JWT with a refresh token
router.post('/refresh', authLimiter, async (req, res) => {
    try {
        const { refreshToken } = req.body;
        const { JWT_SECRET } = getDiscordConfig();

        if (!refreshToken) {
            return res.status(400).json({ success: false, message: 'Refresh token requis' });
        }

        let decoded;
        try {
            decoded = jwt.verify(refreshToken, JWT_SECRET);
        } catch {
            return res.status(401).json({ success: false, message: 'Refresh token invalide ou expiré' });
        }

        if (decoded.type !== 'refresh') {
            return res.status(401).json({ success: false, message: 'Token invalide' });
        }

        // The refresh token must match the stored one
        const crypto = await import('crypto');
        const refreshTokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
        const user = await req.db.collection('users').findOne({ discord_id: decoded.discord_id, refresh_token_hash: refreshTokenHash });

        if (!user) {
            return res.status(401).json({ success: false, message: 'Refresh token révoqué' });
        }

        const newToken = jwt.sign({
            _id: user._id,
            discord_id: user.discord_id,
            is_admin: user.is_admin,
            role: user.role,
            guilde_id: user.guilde_id,
            guild_roles: buildGuildRoles(user.bbs_accounts),
        }, JWT_SECRET, { expiresIn: '24h' });

        res.json({ success: true, token: newToken });
    } catch (error) {
        logger.error('❌ Erreur refresh token:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

// GET the logged-in user's information
router.get('/me', async (req, res) => {
    try {
        const { JWT_SECRET } = getDiscordConfig();
        const token = req.headers.authorization?.replace('Bearer ', '');

        if (!token) {
            return res.status(401).json({ success: false, message: 'Token manquant' });
        }

        const decoded = jwt.verify(token, JWT_SECRET);

        const user = await req.db.collection('users').findOne({ discord_id: decoded.discord_id });

        if (!user) {
            return res.status(404).json({ success: false, message: 'Utilisateur non trouvé' });
        }

        res.json({
            success: true,
            user: {
                id: user._id,
                discord_id: user.discord_id,
                username: user.username,
                global_name: user.global_name,
                avatar: user.avatar,
                banner: user.banner,
                isAdmin: user.is_admin,
                lastLogin: user.last_login,
                guilde_id: user.guilde_id,
                role: user.role,
                bbs_id: user.bbs_id,
                bbs_name: user.bbs_name,
                bbs_accounts: user.bbs_accounts || [],
                guild_roles: buildGuildRoles(user.bbs_accounts),
                isAuthorized: user.is_authorized
            }
        });

    } catch (error) {
        if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
            return res.status(401).json({ success: false, message: 'Token invalide ou expiré' });
        }
        logger.error('Erreur lors de la récupération des infos utilisateur:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

// POST logout
router.post('/logout', async (req, res) => {
    try {
        const { JWT_SECRET } = getDiscordConfig();
        const token = req.headers.authorization?.replace('Bearer ', '');

        if (token) {
            const decoded = jwt.verify(token, JWT_SECRET);
            // Record the logout time and revoke the refresh token
            await req.db.collection('users').updateOne(
                { discord_id: decoded.discord_id },
                { $set: { last_logout: new Date(), refresh_token_hash: null } }
            );
        }

        res.json({ success: true, message: 'Déconnexion réussie' });
    } catch (error) {
        // Logout is confirmed even when the token is invalid
        res.json({ success: true, message: 'Déconnexion réussie' });
    }
});

// Debug routes (disabled in production)
if (process.env.NODE_ENV !== 'production') {
    router.post('/debug-token', async (req, res) => {
        try {
            const { token } = req.body;
            const { JWT_SECRET } = getDiscordConfig();

            if (!token) {
                return res.status(400).json({ success: false, message: 'Token requis dans le body' });
            }

            let decoded = null;
            let isValid = false;
            let error = null;

            try {
                decoded = jwt.verify(token, JWT_SECRET);
                isValid = true;
            } catch (err) {
                error = err.message;
                try {
                    decoded = jwt.decode(token);
                } catch (decodeErr) {
                    decoded = null;
                }
            }

            const now = Math.floor(Date.now() / 1000);

            res.json({
                success: true,
                debug: {
                    isValid,
                    error,
                    decoded,
                    currentTime: now,
                    currentTimeISO: new Date().toISOString(),
                    tokenExpired: decoded && decoded.exp ? decoded.exp < now : null,
                    timeUntilExpiry: decoded && decoded.exp ? decoded.exp - now : null
                }
            });

        } catch (error) {
            logger.error('Erreur lors du debug du token:', error);
            res.status(500).json({ success: false, message: 'Erreur serveur' });
        }
    });

    router.get('/debug/discord-config', (req, res) => {
        try {
            const { DISCORD_CLIENT_ID, DISCORD_REDIRECT_URI, ADMIN_DISCORD_IDS } = getDiscordConfig();

            res.json({
                success: true,
                config: {
                    hasClientId: !!DISCORD_CLIENT_ID,
                    clientIdPreview: DISCORD_CLIENT_ID ? `${DISCORD_CLIENT_ID.substring(0, 8)}...` : null,
                    redirectUri: DISCORD_REDIRECT_URI,
                    adminCount: ADMIN_DISCORD_IDS ? ADMIN_DISCORD_IDS.length : 0,
                }
            });
        } catch (error) {
            logger.error('Erreur lors du debug de la config Discord:', error);
            res.status(500).json({ success: false, message: 'Erreur serveur' });
        }
    });
}

export default router;
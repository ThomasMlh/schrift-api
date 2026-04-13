import express from 'express';
import jwt from 'jsonwebtoken';
import { requireDb } from '../middleware/auth.js';
import players from '../assets/joueurs.json' with { type: "json" };

const router = express.Router();

// Cache pour les tokens Discord (en mémoire)
const tokenCache = new Map();
// Cache pour les données utilisateur récentes (évite les appels API répétés)
const userDataCache = new Map();

// Fonction pour nettoyer le cache des tokens expirés
const cleanExpiredTokens = () => {
    const now = Date.now();
    for (const [discordId, tokenData] of tokenCache.entries()) {
        if (tokenData.expires_at <= now) {
            tokenCache.delete(discordId);
        }
    }
    // Nettoyer aussi le cache des données utilisateur (garde 5 minutes)
    for (const [discordId, userData] of userDataCache.entries()) {
        if (userData.cached_at + (5 * 60 * 1000) <= now) {
            userDataCache.delete(discordId);
        }
    }
};

// Nettoyer le cache toutes les 10 minutes
setInterval(cleanExpiredTokens, 10 * 60 * 1000);

// Middleware pour toutes les routes auth
router.use(requireDb);

// Configuration Discord OAuth - Les variables seront définies après dotenv.config()
const getDiscordConfig = () => ({
    DISCORD_CLIENT_ID: process.env.DISCORD_CLIENT_ID,
    DISCORD_CLIENT_SECRET: process.env.DISCORD_CLIENT_SECRET,
    DISCORD_REDIRECT_URI: process.env.DISCORD_REDIRECT_URI,
    JWT_SECRET: process.env.JWT_SECRET,
    ADMIN_DISCORD_IDS: process.env.ADMIN_DISCORD_IDS ? process.env.ADMIN_DISCORD_IDS.split(',') : [],
    DISCORD_GUILD_ID: process.env.DISCORD_GUILD_ID
});

// Route pour échanger le code d'autorisation contre un token
router.post('/discord/callback', async (req, res) => {
    try {
        const { code } = req.body;
        const { DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, DISCORD_REDIRECT_URI, JWT_SECRET, ADMIN_DISCORD_IDS, DISCORD_GUILD_ID } = getDiscordConfig();

        if (!code) {
            return res.status(400).json({ success: false, message: 'Code d\'autorisation manquant' });
        }

        // Toujours utiliser la redirect_uri configurée côté serveur (sécurité)
        const finalRedirectUri = DISCORD_REDIRECT_URI;

        // Échanger le code contre un access token
        const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
                client_id: DISCORD_CLIENT_ID,
                client_secret: DISCORD_CLIENT_SECRET,
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: finalRedirectUri, // ✅ Utiliser la bonne redirect_uri
            }),
        });

        if (!tokenResponse.ok) {
            const errorData = await tokenResponse.text();
            console.error('❌ Erreur Discord API:', errorData);
            console.error('❌ Status:', tokenResponse.status);
            console.error('❌ Headers:', Object.fromEntries(tokenResponse.headers.entries()));
            return res.status(400).json({
                success: false,
                message: 'Erreur lors de l\'échange du code',
                details: errorData,
                status: tokenResponse.status
            });
        }

        const tokenData = await tokenResponse.json();

        // Récupérer les informations de l'utilisateur avec plus de détails
        const userResponse = await fetch('https://discord.com/api/users/@me', {
            headers: {
                'Authorization': `Bearer ${tokenData.access_token}`,
            },
        });

        if (!userResponse.ok) {
            const errorData = await userResponse.text();
            console.error('❌ Erreur récupération utilisateur:', errorData);
            return res.status(400).json({
                success: false,
                message: 'Erreur lors de la récupération des données utilisateur',
                details: errorData
            });
        }

        const userData = await userResponse.json();

        // Mettre en cache le nouveau token (toujours faire l'échange initial)
        tokenCache.set(userData.id, {
            access_token: tokenData.access_token,
            refresh_token: tokenData.refresh_token,
            expires_at: Date.now() + (tokenData.expires_in * 1000),
            discord_id: userData.id
        });
        console.log('💾 Token Discord mis en cache pour', userData.username);

        // Utiliser le token pour les appels API subséquents
        const activeToken = tokenData.access_token;

        // Récupérer les connexions et guildes (avec cache pour éviter les appels répétés)
        let connections = [];
        let guilds = [];
        
        const cachedUserData = userDataCache.get(userData.id);
        const now = Date.now();
        
        if (cachedUserData && (cachedUserData.cached_at + (5 * 60 * 1000)) > now) {
            // Utiliser les données en cache si elles ont moins de 5 minutes
            console.log('🔄 Utilisation des données utilisateur en cache pour', userData.username);
            connections = cachedUserData.connections;
            guilds = cachedUserData.guilds;
        } else {
            // Récupérer les nouvelles données
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
                console.warn('⚠️ Impossible de récupérer les connexions utilisateur:', error);
            }

            const guildsResponse = await fetch('https://discord.com/api/users/@me/guilds', {
                headers: {
                    'Authorization': `Bearer ${activeToken}`,
                },
            });

            if (guildsResponse.ok) {
                guilds = await guildsResponse.json();
            }

            // Mettre en cache les données utilisateur
            userDataCache.set(userData.id, {
                connections,
                guilds,
                cached_at: now
            });
            console.log('💾 Données utilisateur mises en cache pour', userData.username);
        }

        // Vérifier si l'utilisateur est administrateur
        const isAdmin = ADMIN_DISCORD_IDS.includes(userData.id);

        const existingUser = await req.db.collection('users').findOne({ discord_id: userData.id });

        // 1. Vérifier si l'utilisateur est banni
        if (existingUser?.is_banned) {
            console.warn('⛔ Utilisateur banni:', userData.username);
            return res.status(403).json({
                success: false,
                message: 'Votre compte a été banni.',
                reason: existingUser.ban_reason || null
            });
        }

        // 2. Vérifier si l'utilisateur fait partie de la guild requise
        const isAuthorized = DISCORD_GUILD_ID
            ? guilds.some(g => g.id === DISCORD_GUILD_ID)
            : true;

        if (!isAuthorized) {
            console.warn('⛔ Utilisateur non autorisé (guild manquante):', userData.username);
            return res.status(403).json({
                success: false,
                message: 'Vous n\'êtes pas autorisé à vous connecter. Vous devez être membre du serveur Discord.'
            });
        }
        
        let playerInfo = null;
        if (players.joueurs && Array.isArray(players.joueurs)) {
            playerInfo = players.joueurs.find(p => p.id_discord === userData.id);
        }

        let guildeInfo = null;
        if (playerInfo && playerInfo.guilde) {
            // Chercher la guilde par son name
            const extractGuildName = playerInfo.guilde.split(' ')[1];
            guildeInfo = await req.db.collection('guildes').findOne({
                name: extractGuildName
            });
        }

        let roleInfo = null;
        if (playerInfo && playerInfo.statut) {
            roleInfo = playerInfo.statut.toLowerCase();
        }

        // Créer ou mettre à jour l'utilisateur en base de données
        // Note: les tokens Discord ne sont PAS stockés en DB (sécurité)
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
            bbs_id: existingUser?.bbs_id || playerInfo?.id_bbs || null,
            bbs_name: existingUser?.bbs_name || playerInfo?.pseudo_bbs || null,
            guilde_id: existingUser?.guilde_id || guildeInfo?._id?.toString() || null,
            role: existingUser?.role || roleInfo || null,
            is_admin: isAdmin,
            is_authorized: isAuthorized,
            last_login: new Date()
        };

        // Upsert utilisateur
        const updateResult = await req.db.collection('users').updateOne(
            { discord_id: userData.id },
            { $set: user },
            { upsert: true }
        );

        // Récupérer l'utilisateur mis à jour pour avoir son _id
        const savedUser = await req.db.collection('users').findOne({ discord_id: userData.id });

        // Créer un JWT (payload minimal, les infos supplémentaires sont en DB)
        const jwtPayload = {
            _id: savedUser._id,
            discord_id: userData.id,
            is_admin: isAdmin,
            role: user.role,
            guilde_id: user.guilde_id,
        };

        const jwtToken = jwt.sign(jwtPayload, JWT_SECRET, { expiresIn: '24h' });
        const refreshToken = jwt.sign({ _id: savedUser._id, discord_id: userData.id, type: 'refresh' }, JWT_SECRET, { expiresIn: '7d' });

        // Stocker le refresh token hashé en DB
        const crypto = await import('crypto');
        const refreshTokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
        await req.db.collection('users').updateOne(
            { discord_id: userData.id },
            { $set: { refresh_token_hash: refreshTokenHash } }
        );

        res.json({
            success: true,
            token: jwtToken,
            refreshToken,
            user: {
                global_name: userData.global_name,
                isAuthorized: isAuthorized
            }
        });

    } catch (error) {
        console.error('❌ Erreur lors de l\'authentification Discord:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur lors de l\'authentification' });
    }
});

// Route pour rafraîchir le JWT via refresh token
router.post('/refresh', async (req, res) => {
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

        // Vérifier que le refresh token correspond à celui en DB
        const crypto = await import('crypto');
        const refreshTokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
        const user = await req.db.collection('users').findOne({ discord_id: decoded.discord_id, refresh_token_hash: refreshTokenHash });

        if (!user) {
            return res.status(401).json({ success: false, message: 'Refresh token révoqué' });
        }

        // Générer un nouveau JWT
        const newToken = jwt.sign({
            _id: user._id,
            discord_id: user.discord_id,
            is_admin: user.is_admin,
            role: user.role,
            guilde_id: user.guilde_id,
        }, JWT_SECRET, { expiresIn: '24h' });

        res.json({ success: true, token: newToken });
    } catch (error) {
        console.error('❌ Erreur refresh token:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

// Route pour récupérer les informations de l'utilisateur connecté
router.get('/me', async (req, res) => {
    try {
        const { JWT_SECRET } = getDiscordConfig();
        const token = req.headers.authorization?.replace('Bearer ', '');

        if (!token) {
            return res.status(401).json({ success: false, message: 'Token manquant' });
        }

        const decoded = jwt.verify(token, JWT_SECRET);

        // Récupérer les infos utilisateur depuis la base
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
                isAuthorized: user.is_authorized
            }
        });

    } catch (error) {
        if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
            return res.status(401).json({ success: false, message: 'Token invalide ou expiré' });
        }
        console.error('Erreur lors de la récupération des infos utilisateur:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

// Route pour se déconnecter
router.post('/logout', async (req, res) => {
    try {
        const { JWT_SECRET } = getDiscordConfig();
        const token = req.headers.authorization?.replace('Bearer ', '');

        if (token) {
            const decoded = jwt.verify(token, JWT_SECRET);
            // Optionnel: marquer le token comme invalide en base (blacklist)
            // ou mettre à jour la dernière déconnexion
            await req.db.collection('users').updateOne(
                { discord_id: decoded.discord_id },
                { $set: { last_logout: new Date(), refresh_token_hash: null } }
            );
        }

        res.json({ success: true, message: 'Déconnexion réussie' });
    } catch (error) {
        // Même si le token est invalide, on confirme la déconnexion
        res.json({ success: true, message: 'Déconnexion réussie' });
    }
});

// Routes de debug (désactivées en production)
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
            console.error('Erreur lors du debug du token:', error);
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
            console.error('Erreur lors du debug de la config Discord:', error);
            res.status(500).json({ success: false, message: 'Erreur serveur' });
        }
    });
}

export default router;
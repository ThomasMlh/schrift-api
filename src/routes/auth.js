import express from 'express';
import jwt from 'jsonwebtoken';
import { requireDb } from '../middleware/auth.js';

const router = express.Router();

// Middleware pour toutes les routes auth
router.use(requireDb);

// Configuration Discord OAuth - Les variables seront définies après dotenv.config()
const getDiscordConfig = () => ({
    DISCORD_CLIENT_ID: process.env.DISCORD_CLIENT_ID,
    DISCORD_CLIENT_SECRET: process.env.DISCORD_CLIENT_SECRET,
    DISCORD_REDIRECT_URI: process.env.DISCORD_REDIRECT_URI,
    JWT_SECRET: process.env.JWT_SECRET,
    ADMIN_DISCORD_IDS: process.env.ADMIN_DISCORD_IDS ? process.env.ADMIN_DISCORD_IDS.split(',') : []
});

// Route pour échanger le code d'autorisation contre un token
router.post('/discord/callback', async (req, res) => {
    try {
        const { code, redirect_uri } = req.body; // ✅ Récupérer aussi redirect_uri
        const { DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, DISCORD_REDIRECT_URI, JWT_SECRET, ADMIN_DISCORD_IDS } = getDiscordConfig();

        if (!code) {
            return res.status(400).json({ success: false, message: 'Code d\'autorisation manquant' });
        }

        // Utiliser la redirect_uri du frontend ou fallback sur celle de l'env
        const finalRedirectUri = redirect_uri || DISCORD_REDIRECT_URI;

        // console.log('🔍 DEBUG OAuth - Code:', code);
        // console.log('🔍 DEBUG OAuth - Redirect URI frontend:', redirect_uri);
        // console.log('🔍 DEBUG OAuth - Redirect URI env:', DISCORD_REDIRECT_URI);
        // console.log('🔍 DEBUG OAuth - Redirect URI finale:', finalRedirectUri);

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

        // Récupérer les connexions de l'utilisateur (Steam, Spotify, etc.) si le scope est accordé
        let connections = [];
        try {
            const connectionsResponse = await fetch('https://discord.com/api/users/@me/connections', {
                headers: {
                    'Authorization': `Bearer ${tokenData.access_token}`,
                },
            });
            if (connectionsResponse.ok) {
                connections = await connectionsResponse.json();
            }
        } catch (error) {
            console.warn('⚠️ Impossible de récupérer les connexions utilisateur:', error);
        }

        // Vérifier si l'utilisateur est administrateur
        const isAdmin = ADMIN_DISCORD_IDS.includes(userData.id);

        // Récupérer les guildes de l'utilisateur si nécessaire
        const guildsResponse = await fetch('https://discord.com/api/users/@me/guilds', {
            headers: {
                'Authorization': `Bearer ${tokenData.access_token}`,
            },
        });

        let guilds = [];
        if (guildsResponse.ok) {
            guilds = await guildsResponse.json();
        }

        // Vérifier si l'utilisateur existe déjà pour conserver sa guilde/rôle
        const existingUser = await req.db.collection('users').findOne({ discord_id: userData.id });

        // Créer ou mettre à jour l'utilisateur en base de données
        const user = {
            discord_id: userData.id,
            username: userData.username,
            global_name: userData.global_name, // Nom d'affichage Discord
            discriminator: userData.discriminator,
            avatar: userData.avatar,
            email: userData.email,
            // Informations étendues
            locale: userData.locale, // Langue de l'utilisateur
            flags: userData.flags, // Badges Discord
            premium_type: userData.premium_type, // Nitro status
            public_flags: userData.public_flags,
            banner: userData.banner, // Bannière de profil
            banner_color: userData.banner_color,
            accent_color: userData.accent_color,
            // Données de connexion
            connections: connections,
            // Informations de guilde (conserver les valeurs existantes ou mettre null)
            guilde_id: existingUser?.guilde_id || null,
            role: existingUser?.role || null,
            // Autres données
            is_admin: isAdmin,
            guilds: guilds,
            last_login: new Date(),
            access_token: tokenData.access_token,
            refresh_token: tokenData.refresh_token,
            token_expires: new Date(Date.now() + tokenData.expires_in * 1000)
        };

        // Upsert utilisateur
        const updateResult = await req.db.collection('users').updateOne(
            { discord_id: userData.id },
            { $set: user },
            { upsert: true }
        );
        
        // Récupérer l'utilisateur mis à jour pour avoir son _id
        const savedUser = await req.db.collection('users').findOne({ discord_id: userData.id });
        
        // Créer un JWT
        const jwtPayload = {
            userId: userData.id,
            username: userData.username,
            global_name: userData.global_name,
            discord_id: userData.id,
            guilde_id: user.guilde_id,
            role: user.role,
            avatar: userData.avatar,
            isAdmin: isAdmin,
            exp: Math.floor(Date.now() / 1000) + (7 * 24 * 60 * 60) // 7 jours
        };

        const jwtToken = jwt.sign(jwtPayload, JWT_SECRET);

        res.json({
            success: true,
            token: jwtToken,
            user: {
                id: savedUser._id,
                username: userData.username,
                global_name: userData.global_name,
                discord_id: userData.id,
                guilde_id: user.guilde_id,
                role: user.role,
                avatar: userData.avatar,
                isAdmin: isAdmin
            }
        });

    } catch (error) {
        console.error('❌ Erreur lors de l\'authentification Discord:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur lors de l\'authentification', error: error.message });
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
        const user = await req.db.collection('users').findOne({ discord_id: decoded.userId });
        
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
                isAdmin: user.is_admin,
                lastLogin: user.last_login,
                guilde_id: user.guilde_id,
                role: user.role
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
                { discord_id: decoded.userId },
                { $set: { last_logout: new Date() } }
            );
        }

        res.json({ success: true, message: 'Déconnexion réussie' });
    } catch (error) {
        // Même si le token est invalide, on confirme la déconnexion
        res.json({ success: true, message: 'Déconnexion réussie' });
    }
});

// Route pour déboguer les tokens JWT
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
            // Essayons de décoder sans vérifier la signature pour voir le contenu
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
                hasJwtSecret: !!JWT_SECRET,
                jwtSecretLength: JWT_SECRET ? JWT_SECRET.length : 0,
                tokenExpired: decoded && decoded.exp ? decoded.exp < now : null,
                timeUntilExpiry: decoded && decoded.exp ? decoded.exp - now : null
            }
        });

    } catch (error) {
        console.error('Erreur lors du debug du token:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

// Route de debug pour vérifier la configuration Discord
router.get('/debug/discord-config', (req, res) => {
    try {
        const { DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, DISCORD_REDIRECT_URI, JWT_SECRET, ADMIN_DISCORD_IDS } = getDiscordConfig();
        
        res.json({
            success: true,
            config: {
                hasClientId: !!DISCORD_CLIENT_ID,
                clientIdPreview: DISCORD_CLIENT_ID ? `${DISCORD_CLIENT_ID.substring(0, 8)}...` : null,
                hasClientSecret: !!DISCORD_CLIENT_SECRET,
                clientSecretLength: DISCORD_CLIENT_SECRET ? DISCORD_CLIENT_SECRET.length : 0,
                redirectUri: DISCORD_REDIRECT_URI,
                hasJwtSecret: !!JWT_SECRET,
                jwtSecretLength: JWT_SECRET ? JWT_SECRET.length : 0,
                adminCount: ADMIN_DISCORD_IDS ? ADMIN_DISCORD_IDS.length : 0,
                envVars: {
                    NODE_ENV: process.env.NODE_ENV,
                    hasDiscordClientId: !!process.env.DISCORD_CLIENT_ID,
                    hasDiscordClientSecret: !!process.env.DISCORD_CLIENT_SECRET,
                    hasDiscordRedirectUri: !!process.env.DISCORD_REDIRECT_URI,
                    hasJwtSecret: !!process.env.JWT_SECRET,
                    hasAdminIds: !!process.env.ADMIN_DISCORD_IDS
                }
            }
        });
    } catch (error) {
        console.error('Erreur lors du debug de la config Discord:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

export default router;
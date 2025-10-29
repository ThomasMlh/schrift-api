import express from 'express';
import { cleanObject } from '../utils/cleaners.js';
import { requireAdmin, requireDb } from '../middleware/auth.js';

const router = express.Router();

// Middleware pour toutes les routes characters
router.use(requireDb);

// Route pour ajouter plusieurs personnages
router.post('/', requireAdmin, async (req, res) => {
    try {
        const characters = req.body;
        if (!Array.isArray(characters)) {
            return res.status(400).json({ success: false, message: 'Payload invalide, un tableau de personnages est requis' });
        }

        // Nettoyer et valider les données
        const sanitizedCharacters = [];

        for (const char of characters) {
            const cleanedChar = cleanObject(char);

            // Ignorer les entrées sans nom de recherche
            if (!cleanedChar["Nom de recherche"] || !cleanedChar["Nom de recherche"].trim()) {
                continue;
            }

            const searchName = cleanedChar["Nom de recherche"].toLowerCase().replace(/[^\w\sàâäéèêëïîôöùûüÿç]/g, '').trim();

            // Vérifier si le personnage existe déjà en base
            const existingCharacter = await req.db.collection('characters').findOne({ search_name: searchName });
            if (existingCharacter) {
                continue;
            }

            let cancel_resistance;

            switch (cleanedChar["Annulation résistance Rouge/Bleue"]) {
                case 'Annul. Res. Bleue':
                    cancel_resistance = 'B';
                    break;
                case 'Annul. Res. Rouge':
                    cancel_resistance = 'R';
                    break;
                case 'Range Nullify':
                    cancel_resistance = 'range';
                    break;
                default:
                    cancel_resistance = null;
            }

            sanitizedCharacters.push({
                name: cleanedChar["Nom personnage"] || '',
                search_name: searchName,
                link: cleanedChar["Link"] || '',
                artwork: cleanedChar["URL Artwork"] || '',
                attack_url: cleanedChar["URL ATK"] || '',
                affinity: cleanedChar["Affinité"] || '',
                categories: [cleanedChar["Catégorie 1"] || '', cleanedChar["Catégorie 2"] || ''].filter(Boolean),
                killers: [cleanedChar["Killer 1"] || '', cleanedChar["Killer 2"] || ''].filter(Boolean),
                soul_traits: [cleanedChar["Soul Trait 1"] || '', cleanedChar["Soul Trait 2"] || ''].filter(Boolean),
                soul_traits_ex: cleanedChar["Ex Soul Traits"] || '',
                attack_type: cleanedChar["Attaques Rouges ou Bleues"] === 'Attaques B' ? 'B' : 'R',
                release_date: cleanedChar["Date sortie"] || null,
                resurrection_release: cleanedChar["Date résurrection"] || null,
                portail: cleanedChar["Portail"] || '',
                nad: cleanedChar["NAD ou SAD"] === 'NAD' ? 'NAD' : false,
                sad: cleanedChar["NAD ou SAD"] === 'SAD' ? 'SAD' : false,
                banner: cleanedChar["Bannière"] || '',
                banner_url: cleanedChar["URL Bannière"] || '',
                stats: {
                    end: cleanedChar["END"] || null,
                    atk: cleanedChar["ATK"] || null,
                    def: cleanedChar["DEF"] || null,
                    cct: cleanedChar["CCT"] || null,
                    pre: cleanedChar["PRE"] || null,
                },
                immunities: [cleanedChar["Immunité 1"] || '', cleanedChar["Immunité 2"] || '', cleanedChar["Immunité 3"] || ''].filter(Boolean),
                cancel_resistance,
            });
        }

        if (sanitizedCharacters.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Aucun personnage valide à insérer (doublons ou données manquantes)'
            });
        }

        const result = await req.db.collection('characters').insertMany(sanitizedCharacters);
        res.json({
            insertedIds: result.insertedIds,
            insertedCount: result.insertedCount,
            message: `${result.insertedCount} personnages ajoutés avec succès`
        });
    } catch (error) {
        console.error('Erreur lors de l\'insertion des personnages:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur', error: error.message });
    }
});

// Route pour ajouter un seul personnage
router.post('/single', async (req, res) => {
    try {
        const character = cleanObject(req.body);

        if (!character["Nom de recherche"] || !character["Nom de recherche"].trim()) {
            return res.status(400).json({
                success: false,
                message: 'Le nom de recherche est requis'
            });
        }

        const searchName = character["Nom de recherche"].toLowerCase().replace(/[^\w\sàâäéèêëïîôöùûüÿç]/g, '').trim();

        // Vérifier si le personnage existe déjà
        const existingCharacter = await req.db.collection('characters').findOne({ search_name: searchName });
        if (existingCharacter) {
            return res.status(409).json({
                success: false,
                message: 'Un personnage avec ce nom de recherche existe déjà'
            });
        }

        const sanitizedCharacter = {
            name: character["Nom personnage"] || '',
            search_name: searchName,
            link: character["Link"] || '',
            artwork: character["URL Artwork"] || '',
            affinity: character["Affinité"] || '',
            categories: [character["Catégorie 1"] || '', character["Catégorie 2"] || ''].filter(Boolean),
            killers: [character["Killer 1"] || '', character["Killer 2"] || ''].filter(Boolean),
            soul_traits: [character["Soul Trait 1"] || '', character["Soul Trait 2"] || ''].filter(Boolean),
            soul_traits_ex: character["Ex Soul Traits"] || '',
            attack_type: character["Attaques Rouges ou Bleues"] || '',
        };

        const result = await req.db.collection('characters').insertOne(sanitizedCharacter);
        res.json({
            insertedId: result.insertedId,
            message: `Personnage ${character["Nom personnage"]} ajouté avec succès`
        });
    } catch (error) {
        console.error('Erreur lors de l\'insertion du personnage:', error);
        res.status(500).json({ success: false, message: 'Erreur serveur', error: error.message });
    }
});

// Route pour récupérer tous les personnages avec filtres combinés et pagination
router.get('/', async (req, res) => {
    try {
        // Paramètres de pagination avec valeurs par défaut
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50; // 50 par page par défaut
        const skip = (page - 1) * limit;

        // Limiter le nombre max par page pour éviter les abus
        const maxLimit = 200;
        const actualLimit = Math.min(limit, maxLimit);

        // Paramètres de filtrage
        const { affinity, category, killer, search, attack_type } = req.query;

        // Construire la requête de filtrage
        const query = {};

        // Filtre par affinité
        if (affinity && affinity.trim()) {
            query.affinity = { $regex: new RegExp(affinity.trim(), 'i') };
        }

        // Filtre par catégorie (recherche dans le tableau)
        if (category && category.trim()) {
            query.categories = { $regex: new RegExp(category.trim(), 'i') };
        }

        // Filtre par killer (recherche exacte dans le tableau)
        if (killer && killer.trim()) {
            const killerTerm = killer.trim();
            // Échapper les caractères spéciaux de regex pour une recherche littérale exacte
            const escapedTerm = killerTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            query.killers = { $regex: new RegExp(`^${escapedTerm}$`, 'i') };
        }

        // Filtre par type d'attaque (R pour Rouge, B pour Bleue)
        if (attack_type && attack_type.trim()) {
            query.attack_type = attack_type.trim().toUpperCase();
        }

        // Filtre par recherche textuelle
        if (search && search.trim()) {
            const searchTerm = search.toLowerCase().replace(/[^\w\sàâäéèêëïîôöùûüÿç]/g, '').trim();
            query.$or = [
                { search_name: { $regex: searchTerm, $options: 'i' } },
                { name: { $regex: searchTerm, $options: 'i' } }
            ];
        }

        // Récupérer les personnages et les trier côté application
        const characters = await req.db.collection('characters')
            .find(query)
            .skip(skip)
            .limit(actualLimit)
            .toArray();

        // Trier les personnages par date de sortie (format DD/MM/YYYY)
        characters.sort((a, b) => {
            // Fonction pour convertir DD/MM/YYYY en Date
            const parseDate = (dateStr) => {
                if (!dateStr || dateStr === null) return new Date(0); // Très ancien si pas de date
                
                // Si c'est déjà un objet Date
                if (dateStr instanceof Date) return dateStr;
                
                // Si c'est au format DD/MM/YYYY
                if (typeof dateStr === 'string' && dateStr.includes('/')) {
                    const [day, month, year] = dateStr.split('/');
                    return new Date(year, month - 1, day); // month - 1 car les mois sont indexés à partir de 0
                }
                
                // Sinon essayer de parser directement
                return new Date(dateStr);
            };

            const dateA = parseDate(a["release_date"]);
            const dateB = parseDate(b["release_date"]);
            
            // Tri décroissant (plus récents en premier) - RETOUR VERSION ORIGINALE
            const dateDiff = dateB.getTime() - dateA.getTime();
            
            // Si les dates sont identiques, trier par nom
            if (dateDiff === 0) {
                const nameA = a.name || '';
                const nameB = b.name || '';
                return nameA.localeCompare(nameB);
            }
            
            return dateDiff;
        });

        const totalCount = await req.db.collection('characters').countDocuments(query);

        const totalPages = Math.ceil(totalCount / actualLimit);

        res.json({
            data: characters,
            pagination: {
                currentPage: page,
                totalPages,
                totalCount,
                hasNextPage: page < totalPages,
                hasPrevPage: page > 1,
                itemsPerPage: actualLimit,
                itemsOnPage: characters.length
            },
            // Retourner les filtres actifs pour le frontend
            activeFilters: {
                affinity: affinity || null,
                category: category || null,
                killer: killer || null,
                attack_type: attack_type || null,
                search: search || null
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Erreur serveur', error: error.message });
    }
});

// Route pour rechercher des personnages avec pagination
router.get('/search', async (req, res) => {
    try {
        const { q, page = 1, limit = 20 } = req.query;
        if (!q || !q.trim()) {
            return res.status(400).json({ success: false, message: 'Paramètre de recherche requis' });
        }

        const searchTerm = q.toLowerCase().replace(/[^\w\sàâäéèêëïîôöùûüÿç]/g, '').trim();
        const skip = (parseInt(page) - 1) * parseInt(limit);
        const actualLimit = Math.min(parseInt(limit), 100); // Max 100 pour la recherche

        const searchQuery = {
            $or: [
                { search_name: { $regex: searchTerm, $options: 'i' } },
                { name: { $regex: searchTerm, $options: 'i' } }
            ]
        };

        // Récupérer les personnages et les trier côté application
        const characters = await req.db.collection('characters')
            .find(searchQuery)
            .skip(skip)
            .limit(actualLimit)
            .toArray();

        // Trier les personnages par date de sortie (format DD/MM/YYYY)
        characters.sort((a, b) => {
            // Fonction pour convertir DD/MM/YYYY en Date
            const parseDate = (dateStr) => {
                if (!dateStr || dateStr === null) return new Date(0); // Très ancien si pas de date
                
                // Si c'est déjà un objet Date
                if (dateStr instanceof Date) return dateStr;
                
                // Si c'est au format DD/MM/YYYY
                if (typeof dateStr === 'string' && dateStr.includes('/')) {
                    const [day, month, year] = dateStr.split('/');
                    return new Date(year, month - 1, day); // month - 1 car les mois sont indexés à partir de 0
                }
                
                // Sinon essayer de parser directement
                return new Date(dateStr);
            };

            const dateA = parseDate(a["release_date"]);
            const dateB = parseDate(b["release_date"]);
            
            // Tri décroissant (plus récents en premier) - RETOUR VERSION ORIGINALE
            const dateDiff = dateB.getTime() - dateA.getTime();
            
            // Si les dates sont identiques, trier par nom
            if (dateDiff === 0) {
                const nameA = a.name || a["Nom personnage"] || '';
                const nameB = b.name || b["Nom personnage"] || '';
                return nameA.localeCompare(nameB);
            }
            
            return dateDiff;
        });

        const totalCount = await req.db.collection('characters').countDocuments(searchQuery);

        const totalPages = Math.ceil(totalCount / actualLimit);

        res.json({
            
            pagination: {
                currentPage: parseInt(page),
                totalPages,
                totalCount,
                hasNextPage: parseInt(page) < totalPages,
                hasPrevPage: parseInt(page) > 1,
                itemsPerPage: actualLimit,
                itemsOnPage: characters.length
            },
            searchTerm: q
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Erreur serveur', error: error.message });
    }
});

// Route pour récupérer seulement les noms et IDs (ultra-léger pour autocomplete)
router.get('/names', async (req, res) => {
    try {
        const characters = await req.db.collection('characters')
            .find({}, {
                projection: {
                    name: 1,
                    search_name: 1,
                    _id: 1
                }
            })
            .sort({ name: 1 })
            .toArray();

        res.json(characters);
    } catch (error) {
        res.status(500).json({ success: false, message: 'Erreur serveur', error: error.message });
    }
});

// Route admin pour créer les index (à utiliser une seule fois)
router.post('/admin/create-indexes', async (req, res) => {
    try {
        // Créer les index pour optimiser les performances
        await Promise.all([
            // Index texte pour la recherche
            req.db.collection('characters').createIndex({
                "search_name": "text",
                "name": "text"
            }),
            // Index pour search_name
            req.db.collection('characters').createIndex({ "search_name": 1 }),
            // Index pour l'affinité
            req.db.collection('characters').createIndex({ "affinity": 1 }),
            // Index composé
            req.db.collection('characters').createIndex({
                "affinity": 1,
                "search_name": 1
            }),
            // Index pour les catégories
            req.db.collection('characters').createIndex({ "categories": 1 }),
            // Index pour les killers
            req.db.collection('characters').createIndex({ "killers": 1 }),
            // Nouveaux index pour les champs ajoutés
            req.db.collection('characters').createIndex({ "release_date": 1 }),
            req.db.collection('characters').createIndex({ "rarity": 1 }),
            req.db.collection('characters').createIndex({ "status": 1 })
        ]);

        res.json({
            success: true,
            message: 'Index créés avec succès pour optimiser les performances'
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Erreur lors de la création des index',
            error: error.message
        });
    }
});

export default router;
import express from "express";
import { ObjectId } from "mongodb";
import { cleanObject } from "../utils/cleaners.js";
import { requireAdmin, requireDb } from "../middleware/auth.js";
import { syncCharactersFromSFTP, uploadImagesBatch } from "../services/characterSync.js";
import { convertDateToFormat, reorderCharactersByReleaseDate } from "../utils/characterHelpers.js";
import { parsePaginationParams, buildPaginationMeta } from "../utils/pagination.js";
import { logger } from '../utils/logger.js';
import { sendStatusCodeError } from '../utils/httpErrors.js';

const router = express.Router();

// Middleware pour toutes les routes characters
router.use(requireDb);

// Route pour ajouter plusieurs personnages
router.post("/", requireAdmin, async (req, res) => {
  try {
    const characters = req.body;
    if (!Array.isArray(characters)) {
      return res.status(400).json({
        success: false,
        message: "Payload invalide, un tableau de personnages est requis"
      });
    }

    // Nettoyer et valider les données
    const sanitizedCharacters = [];

    for (const char of characters) {
      const cleanedChar = cleanObject(char);

      // Ignorer les entrées sans nom de recherche
      if (
        !cleanedChar["Nom de recherche"] ||
        !cleanedChar["Nom de recherche"].trim()
      ) {
        continue;
      }

      const searchName = cleanedChar["Nom de recherche"]
        .replace(/[^\w\sàâäéèêëïîôöùûüÿç]/g, "")
        .trim();

      // Vérifier si le personnage existe déjà en base
      const existingCharacter = await req.db
        .collection("characters")
        .findOne({ search_name: searchName });
      if (existingCharacter) {
        continue;
      }

      const CANCEL_RESISTANCE_MAP = {
        "Annul. Res. Bleue": "B",
        "Annul. Res. Rouge": "R",
        "Range Nullify": "range"
      };

      // Gérer les killers depuis le champ "Killers" (avec split) ou depuis Killer 1/2
      let killers = [];
      if (cleanedChar["Killers"] && cleanedChar["Killers"].trim()) {
        killers = cleanedChar["Killers"]
          .split(",")
          .map((k) => k.trim())
          .filter(Boolean);
      } else {
        killers = [
          cleanedChar["Killer 1"] || "",
          cleanedChar["Killer 2"] || ""
        ].filter(Boolean);
      }

      let categories = [];
      if (cleanedChar["Catégories"] && cleanedChar["Catégories"].trim()) {
        categories = cleanedChar["Catégories"]
          .split(",")
          .map((c) => c.trim())
          .filter(Boolean);
      } else {
        categories = [
          cleanedChar["Catégorie 1"] || "",
          cleanedChar["Catégorie 2"] || ""
        ].filter(Boolean);
      }

      let soul_traits = [];
      if (cleanedChar["Soul Traits"] && cleanedChar["Soul Traits"].trim()) {
        soul_traits = cleanedChar["Soul Traits"]
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      } else {
        soul_traits = [
          cleanedChar["Soul Trait 1"] || "",
          cleanedChar["Soul Trait 2"] || ""
        ].filter(Boolean);
      }

      let ex_soul_traits = [];
      if (
        cleanedChar["Ex Soul Traits"] &&
        cleanedChar["Ex Soul Traits"].trim()
      ) {
        ex_soul_traits = cleanedChar["Ex Soul Traits"]
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      } else {
        ex_soul_traits = [
          cleanedChar["Ex Soul Trait 1"] || "",
          cleanedChar["Ex Soul Trait 2"] || ""
        ].filter(Boolean);
      }

      let bannerDoc = await req.db.collection("banners").findOne({
        $or: [
          { name: cleanedChar["Loterie"] },
          { url: cleanedChar["URL Portail"] },
          { portail: cleanedChar["Portail"] }
        ]
      });

      const banner_id = bannerDoc ? bannerDoc._id : null;

      sanitizedCharacters.push({
        name: cleanedChar["Nom personnage"] || "",
        search_name: searchName,
        link: cleanedChar["Link"] || "",
        artwork: cleanedChar["URL Artwork"] || "",
        attack_url: cleanedChar["URL ATK"] || "",
        phrase_url: cleanedChar["URL Phrase"] || "",
        affinity: cleanedChar["Affinité"] || "",
        categories: categories,
        killers: killers,
        soul_traits: soul_traits,
        ex_soul_traits: ex_soul_traits,
        attack_type:
          cleanedChar["Attaques Rouges ou Bleues"] === "Attaques B" ? "B" : "R",
        release_date: convertDateToFormat(cleanedChar["Date sortie"]),
        resurrection_release: convertDateToFormat(
          cleanedChar["Date résurrection"]
        ),
        portail: cleanedChar["Portail"] || "",
        lottery: cleanedChar["Loterie"] || "",
        nad: cleanedChar["NAD ou SAD"] === "NAD" ? "NAD" : false,
        sad: cleanedChar["NAD ou SAD"] === "SAD" ? "SAD" : false,
        version: cleanedChar["Version"] || "",
        version_name: cleanedChar["Nom version"] || "",
        banner: cleanedChar["Loterie"] || "",
        banner_url: cleanedChar["URL Portail"] || "",
        banner_id,
        stats: {
          end: cleanedChar["END"] || null,
          atk: cleanedChar["ATK"] || null,
          def: cleanedChar["DEF"] || null,
          cct: cleanedChar["CCT"] || null,
          pre: cleanedChar["PRE"] || null
        },
        alterations: {},
        immunities: [
          cleanedChar["Immunité 1"] || "",
          cleanedChar["Immunité 2"] || "",
          cleanedChar["Immunité 3"] || ""
        ].filter(Boolean),
        cancel_resistance:
          CANCEL_RESISTANCE_MAP[
            cleanedChar["Annulation résistance Rouge/Bleue"]
          ] || null
      });
    }

    if (sanitizedCharacters.length === 0) {
      return res.status(400).json({
        success: false,
        message:
          "Aucun personnage valide à insérer (doublons ou données manquantes)"
      });
    }

    const result = await req.db
      .collection("characters")
      .insertMany(sanitizedCharacters);
    res.json({
      insertedIds: result.insertedIds,
      insertedCount: result.insertedCount,
      message: `${result.insertedCount} personnages ajoutés avec succès`
    });
  } catch (error) {
    logger.error("Erreur lors de l'insertion des personnages:", error);
    res.status(500).json({
      success: false,
      message: "Erreur serveur",
      error: error.message
    });
  }
});

router.get("/", async (req, res) => {
  try {
    const { page, limit, skip } = parsePaginationParams(req.query);

    // Paramètres de filtrage
    const { affinity, category, killer, search, attack_type } = req.query;

    // Construire la requête de filtrage
    const query = {};

    // Filtre par affinité
    if (affinity && affinity.trim()) {
      query.affinity = { $regex: new RegExp(affinity.trim(), "i") };
    }

    // Filtre par catégorie (recherche dans le tableau)
    if (category && category.trim()) {
      query.categories = { $regex: new RegExp(category.trim(), "i") };
    }

    // Filtre par killer (recherche exacte dans le tableau)
    if (killer && killer.trim()) {
      query.killers = { $regex: new RegExp(killer.trim(), "i") };
    }

    // Filtre par type d'attaque (R pour Rouge, B pour Bleue)
    if (attack_type && attack_type.trim()) {
      query.attack_type = attack_type.trim().toUpperCase();
    }

    // Filtre par recherche textuelle
    if (search && search.trim()) {
      const searchTerm = search
        .toLowerCase()
        .replace(/[^\w\sàâäéèêëïîôöùûüÿç]/g, "")
        .trim();

      // Chercher les bannières correspondantes pour inclure leurs personnages
      const matchingBanners = await req.db
        .collection("banners")
        .find({
          $or: [
            { name: { $regex: searchTerm, $options: "i" } },
            { portail: { $regex: searchTerm, $options: "i" } }
          ]
        })
        .project({ _id: 1 })
        .toArray();
      const bannerIds = matchingBanners.map((b) => b._id);

      query.$or = [
        { search_name: { $regex: searchTerm, $options: "i" } },
        { name: { $regex: searchTerm, $options: "i" } },
        { version: { $regex: searchTerm, $options: "i" } },
        ...(bannerIds.length > 0 ? [{ banner_id: { $in: bannerIds } }] : [])
      ];
    }

    // Récupérer les personnages triés par sort_order croissant (0 = plus récent)
    const characters = await req.db
      .collection("characters")
      .find(query)
      .sort({ sort_order: 1, release_date: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();

    const totalCount = await req.db
      .collection("characters")
      .countDocuments(query);

    res.json({
      data: characters,
      pagination: buildPaginationMeta(page, limit, totalCount, characters.length),
      activeFilters: {
        affinity: affinity || null,
        category: category || null,
        killer: killer || null,
        attack_type: attack_type || null,
        search: search || null
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Erreur serveur",
      error: error.message
    });
  }
});

// GET valeurs distinctes pour killers, catégories, affinités
router.get("/meta", async (req, res) => {
  try {
    const [killers, categories, affinities] = await Promise.all([
      req.db.collection('characters').distinct('killers', { killers: { $exists: true, $ne: '' } }),
      req.db.collection('characters').distinct('categories', { categories: { $exists: true, $ne: '' } }),
      req.db.collection('characters').distinct('affinity', { affinity: { $exists: true, $ne: '' } }),
    ]);

    res.json({
      success: true,
      killers: killers.filter(Boolean).sort(),
      categories: categories.filter(Boolean).sort(),
      affinities: affinities.filter(Boolean).sort(),
    });
  } catch (error) {
    logger.error('Erreur lors de la récupération des métadonnées:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur', error: error.message });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const character = await req.db
      .collection("characters")
      .findOne({ _id: new ObjectId(req.params.id) });
    if (!character) {
      return res
        .status(404)
        .json({ success: false, message: "Personnage non trouvé" });
    }
    res.json({ success: true, data: character });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Erreur serveur",
      error: error.message
    });
  }
});

router.get("/search", async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || !q.trim()) {
      return res
        .status(400)
        .json({ success: false, message: "Paramètre de recherche requis" });
    }

    const { page, limit, skip } = parsePaginationParams(req.query, 20, 100);
    const searchTerm = q
      .toLowerCase()
      .replace(/[^\w\sàâäéèêëïîôöùûüÿç]/g, "")
      .trim();

    // Chercher les bannières correspondantes pour inclure leurs personnages
    const matchingBanners = await req.db
      .collection("banners")
      .find({
        $or: [
          { name: { $regex: searchTerm, $options: "i" } },
          { portail: { $regex: searchTerm, $options: "i" } }
        ]
      })
      .project({ _id: 1 })
      .toArray();
    const bannerIds = matchingBanners.map((b) => b._id);

    const searchQuery = {
      $or: [
        { search_name: { $regex: searchTerm, $options: "i" } },
        { name: { $regex: searchTerm, $options: "i" } },
        { version: { $regex: searchTerm, $options: "i" } },
        ...(bannerIds.length > 0 ? [{ banner_id: { $in: bannerIds } }] : [])
      ]
    };

    // Récupérer les personnages triés par sort_order croissant (0 = plus récent)
    const characters = await req.db
      .collection("characters")
      .find(searchQuery)
      .sort({ sort_order: 1, release_date: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();

    const totalCount = await req.db
      .collection("characters")
      .countDocuments(searchQuery);

    res.json({
      data: characters,
      pagination: buildPaginationMeta(page, limit, totalCount, characters.length),
      searchTerm: q
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Erreur serveur",
      error: error.message
    });
  }
});

router.get("/names", async (req, res) => {
  try {
    const characters = await req.db
      .collection("characters")
      .find(
        {},
        {
          projection: {
            name: 1,
            search_name: 1,
            _id: 1
          }
        }
      )
      .sort({ name: 1 })
      .toArray();

    res.json(characters);
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Erreur serveur",
      error: error.message
    });
  }
});

router.post("/admin/create-indexes", async (req, res) => {
  try {
    // Créer les index pour optimiser les performances
    await Promise.all([
      // Index texte pour la recherche
      req.db.collection("characters").createIndex({
        search_name: "text",
        name: "text"
      }),
      // Index pour search_name
      req.db.collection("characters").createIndex({ search_name: 1 }),
      // Index pour l'affinité
      req.db.collection("characters").createIndex({ affinity: 1 }),
      // Index composé
      req.db.collection("characters").createIndex({
        affinity: 1,
        search_name: 1
      }),
      // Index pour les catégories
      req.db.collection("characters").createIndex({ categories: 1 }),
      // Index pour les killers
      req.db.collection("characters").createIndex({ killers: 1 }),
      // Nouveaux index pour les champs ajoutés
      req.db.collection("characters").createIndex({ release_date: 1 }),
      req.db.collection("characters").createIndex({ rarity: 1 }),
      req.db.collection("characters").createIndex({ status: 1 })
    ]);

    res.json({
      success: true,
      message: "Index créés avec succès pour optimiser les performances"
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Erreur lors de la création des index",
      error: error.message
    });
  }
});

// Route pour mettre à jour les personnages via SFTP
router.post("/update", requireAdmin, async (req, res) => {
  try {
    const result = await syncCharactersFromSFTP(req.db, { uploadImages: req.body?.uploadImages === true });
    res.json({ success: true, ...result });
  } catch (error) {
    sendStatusCodeError(res, error, "Erreur serveur lors de la synchronisation", "❌ Erreur lors de la mise à jour via SFTP:");
  }
});

// Route pour uploader les images par batch

// Route pour uploader les images par batch (évite les timeouts Vercel)
router.post("/update/images", requireAdmin, async (req, res) => {
  try {
    const result = await uploadImagesBatch(req.db, req.body?.batchSize);
    res.json({ success: true, ...result });
  } catch (error) {
    sendStatusCodeError(res, error, "Erreur serveur lors de l'upload des images", "❌ Erreur upload images batch:");
  }
});


router.post("/admin/reorder-by-date", requireAdmin, async (req, res) => {
  try {
    const reorderStats = await reorderCharactersByReleaseDate(req.db);

    res.json({
      success: true,
      message: `Réorganisation manuelle terminée: ${reorderStats.updated} personnages mis à jour`,
      statistics: reorderStats
    });
  } catch (error) {
    logger.error("❌ Erreur lors de la réorganisation manuelle:", error);
    res.status(500).json({
      success: false,
      message: "Erreur lors de la réorganisation des personnages",
      error: error.message
    });
  }
});

export default router;

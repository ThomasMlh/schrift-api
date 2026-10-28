import express from "express";
import { ObjectId } from "mongodb";
import { cleanObject } from "../utils/cleaners.js";
import { requireAdmin, requireDb } from "../middleware/auth.js";
import { syncCharactersFromSFTP, uploadImagesBatch } from "../services/characterSync.js";
import { syncCharactersFromGame, TRAIT_FILTERS_SETTING } from "../services/gameDb/gameSync.js";
import { computeStatMax, convertDateToFormat, reorderCharactersByReleaseDate } from "../utils/characterHelpers.js";
import { parsePaginationParams, buildPaginationMeta } from "../utils/pagination.js";
import { logger } from '../utils/logger.js';
import { sendStatusCodeError } from '../utils/httpErrors.js';
import { ensureIndexes } from '../services/dbIndexes.js';

const router = express.Router();

// Query parameter -> group of `filters` on the character
const FILTER_GROUP_PARAMS = { soul_traits: 'link', ex_skills: 'ex', skills: 'skill', special: 'special', destruction: 'destruction' };
const FILTER_GROUPS = Object.values(FILTER_GROUP_PARAMS);

router.use(requireDb);

// POST add several characters
router.post("/", requireAdmin, async (req, res) => {
  try {
    const characters = req.body;
    if (!Array.isArray(characters)) {
      return res.status(400).json({
        success: false,
        message: "Payload invalide, un tableau de personnages est requis"
      });
    }

    const sanitizedCharacters = [];

    for (const char of characters) {
      const cleanedChar = cleanObject(char);

      // Skip entries without a search name
      if (
        !cleanedChar["Nom de recherche"] ||
        !cleanedChar["Nom de recherche"].trim()
      ) {
        continue;
      }

      const searchName = cleanedChar["Nom de recherche"]
        .replace(/[^\w\sàâäéèêëïîôöùûüÿç]/g, "")
        .trim();

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

      // Killers come from the "Killers" field (comma separated) or from Killer 1/2
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

    const { affinity, category, killer, search, attack_type, traits, resurrection } = req.query;

    const query = {};
    const listOf = (value) => String(value ?? '').split(',').map((t) => t.trim()).filter(Boolean);

    // Several values (comma separated): the character matches one of them
    const affinities = listOf(affinity);
    if (affinities.length > 0) query.affinity = { $in: affinities };
    const categoryList = listOf(category);
    if (categoryList.length > 0) query.categories = { $in: categoryList };
    // A killer also covers its "+" version, like the game filter
    const killerList = listOf(killer);
    if (killerList.length > 0) query.killers = { $in: killerList.flatMap((k) => [k, `${k} +`]) };

    // Attack type (R = red, B = blue)
    if (attack_type && attack_type.trim()) {
      query.attack_type = attack_type.trim().toUpperCase();
    }

    // Game ability types (comma separated): the character must have all of them
    const traitList = listOf(traits);
    if (traitList.length > 0) query.filter_types = { $all: traitList };
    // Same within one group of the game's filter (soul trait, EX skills, skills, special effects, elimination
    // bonus); <param>_match=any only asks for one of them, like the game's "partial match"
    const groupFilters = {};
    for (const [param, group] of Object.entries(FILTER_GROUP_PARAMS)) {
      const list = listOf(req.query[param]);
      if (list.length > 0) {
        const anyOf = req.query[`${param}_match`] === 'any';
        query[`filters.${group}`] = anyOf ? { $in: list } : { $all: list };
        groupFilters[param] = list;
        if (anyOf) groupFilters[`${param}_match`] = 'any';
      }
    }

    if (resurrection === '1') query.resurrection = { $type: 'object' };
    else if (resurrection === '0') query.resurrection = { $not: { $type: 'object' } };

    // Text search
    if (search && search.trim()) {
      const searchTerm = search
        .toLowerCase()
        .replace(/[^\w\sàâäéèêëïîôöùûüÿç]/g, "")
        .trim();

      // Include characters featured in matching game summons
      const matchingBanners = await req.db
        .collection("banners")
        .find({ name: { $regex: searchTerm, $options: "i" } })
        .project({ gacha_group_id: 1 })
        .toArray();
      const summonIds = matchingBanners.map((b) => b.gacha_group_id).filter(Boolean);

      query.$or = [
        { search_name: { $regex: searchTerm, $options: "i" } },
        { name: { $regex: searchTerm, $options: "i" } },
        { version: { $regex: searchTerm, $options: "i" } },
        { version_name: { $regex: searchTerm, $options: "i" } },
        { "game_version.fr": { $regex: searchTerm, $options: "i" } },
        ...(summonIds.length > 0 ? [{ "banners.gacha_group_id": { $in: summonIds } }] : [])
      ];
    }

    // Sorted by ascending sort_order (0 = most recent)
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
        traits: traitList,
        ...groupFilters,
        resurrection: resurrection ?? null,
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

// GET distinct killers, categories and affinities
router.get("/meta", async (req, res) => {
  try {
    const [killers, categories, affinities, statDocs, presentTypes, traitFilters, ...presentByGroup] = await Promise.all([
      req.db.collection('characters').distinct('killers', { killers: { $exists: true, $ne: '' } }),
      req.db.collection('characters').distinct('categories', { categories: { $exists: true, $ne: '' } }),
      req.db.collection('characters').distinct('affinity', { affinity: { $exists: true, $ne: '' } }),
      req.db.collection('characters').find({ stats: { $exists: true } }, { projection: { stats: 1 } }).toArray(),
      req.db.collection('characters').distinct('filter_types'),
      req.db.collection('app_settings').findOne({ _id: TRAIT_FILTERS_SETTING }),
      ...FILTER_GROUPS.map((group) => req.db.collection('characters').distinct(`filters.${group}`)),
    ]);
    // Per group of the game's filter, only the entries some character has
    const presentIn = Object.fromEntries(FILTER_GROUPS.map((group, i) => [group, new Set(presentByGroup[i])]));
    const categoriesFor = (group) => (traitFilters?.categories ?? [])
      .map((category) => ({ ...category, types: category.types.filter((t) => presentIn[group].has(t.type)) }))
      .filter((category) => category.types.length > 0);
    const filterGroups = {
      link: categoriesFor('link'),
      ex: categoriesFor('ex'),
      skill: categoriesFor('skill'),
      special: (traitFilters?.special ?? []).filter((t) => presentIn.special.has(t.type)),
      destruction: (traitFilters?.destruction ?? []).filter((t) => presentIn.destruction.has(t.type)),
    };
    // Only the ability types some character has
    const present = new Set(presentTypes);
    const traitCategories = (traitFilters?.categories ?? [])
      .map((category) => ({ ...category, types: category.types.filter((t) => present.has(t.type)) }))
      .filter((category) => category.types.length > 0);

    res.json({
      success: true,
      killers: killers.filter(Boolean).sort(),
      categories: categories.filter(Boolean).sort(),
      affinities: affinities.filter(Boolean).sort(),
      stat_max: computeStatMax(statDocs),
      trait_filters: traitCategories,
      filter_groups: filterGroups,
    });
  } catch (error) {
    logger.error('Erreur lors de la récupération des métadonnées:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur', error: error.message });
  }
});

// GET the full, lightweight character catalog (player albums): no pagination, only the fields a
// thumbnail grid needs. Declared before /:id.
router.get("/catalog", async (req, res) => {
  try {
    const characters = await req.db
      .collection("characters")
      .find({}, { projection: { name: 1, search_name: 1, version: 1, affinity: 1, attack_type: 1, killers: 1, categories: 1 } })
      .sort({ sort_order: 1, release_date: -1 })
      .toArray();

    res.json({ success: true, data: characters });
  } catch (error) {
    logger.error('Erreur lors de la récupération du catalogue des personnages:', error);
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

    // Include characters featured in matching game summons
    const matchingBanners = await req.db
      .collection("banners")
      .find({ name: { $regex: searchTerm, $options: "i" } })
      .project({ gacha_group_id: 1 })
      .toArray();
    const summonIds = matchingBanners.map((b) => b.gacha_group_id).filter(Boolean);

    const searchQuery = {
      $or: [
        { search_name: { $regex: searchTerm, $options: "i" } },
        { name: { $regex: searchTerm, $options: "i" } },
        { version: { $regex: searchTerm, $options: "i" } },
        ...(summonIds.length > 0 ? [{ "banners.gacha_group_id": { $in: summonIds } }] : [])
      ]
    };

    // Sorted by ascending sort_order (0 = most recent)
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

// Kept for existing callers: creates every index, characters included
router.post("/admin/create-indexes", requireAdmin, async (req, res) => {
  try {
    const result = await ensureIndexes(req.db);
    res.json({ success: true, message: "Index créés avec succès pour optimiser les performances", ...result });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Erreur lors de la création des index",
      error: error.message
    });
  }
});

// POST update characters from the SFTP source (dryRun: report what would change, write nothing)
router.post("/update", requireAdmin, async (req, res) => {
  try {
    const result = await syncCharactersFromSFTP(req.db, {
      uploadImages: req.body?.uploadImages === true,
      dryRun: req.body?.dryRun === true,
    });
    res.json({ success: true, ...result });
  } catch (error) {
    sendStatusCodeError(res, error, "Erreur serveur lors de la synchronisation", "❌ Erreur lors de la mise à jour via SFTP:");
  }
});


// POST { dryRun }: sync from the game master tables (simulation by default)
router.post("/game-sync", requireAdmin, async (req, res) => {
  try {
    res.json({ success: true, ...(await syncCharactersFromGame(req.db, { dryRun: req.body?.dryRun !== false })) });
  } catch (error) {
    sendStatusCodeError(res, error, "Erreur serveur lors de la synchronisation avec les tables du jeu", "❌ Erreur synchro tables du jeu:");
  }
});


// POST upload images in batches (avoids Vercel timeouts)
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

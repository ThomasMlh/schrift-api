import express from "express";
import { ObjectId } from "mongodb";
import { cleanObject } from "../utils/cleaners.js";
import { requireAdmin, requireDb } from "../middleware/auth.js";
import { SFTPClient } from "../utils/database.js";
import { FTPUploader } from "../utils/ftp.js";
import { notifyDiscord } from "../utils/notifyDiscord.js";

const router = express.Router();

function convertDateToFormat(dateValue) {
  if (!dateValue) return null;

  if (
    typeof dateValue === "string" &&
    /^\d{2}\/\d{2}\/\d{4}$/.test(dateValue)
  ) {
    return dateValue;
  }

  if (
    typeof dateValue === "number" ||
    (typeof dateValue === "string" && /^\d+$/.test(dateValue))
  ) {
    const timestamp =
      typeof dateValue === "string" ? parseInt(dateValue) : dateValue;
    const date = new Date(timestamp);

    if (isNaN(date.getTime())) return dateValue;

    const day = String(date.getDate()).padStart(2, "0");
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const year = date.getFullYear();

    return `${day}/${month}/${year}`;
  }

  return dateValue;
}

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
    console.error("Erreur lors de l'insertion des personnages:", error);
    res.status(500).json({
      success: false,
      message: "Erreur serveur",
      error: error.message
    });
  }
});

router.get("/", async (req, res) => {
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
      .limit(actualLimit)
      .toArray();

    const totalCount = await req.db
      .collection("characters")
      .countDocuments(query);

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
    res.status(500).json({
      success: false,
      message: "Erreur serveur",
      error: error.message
    });
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
    const { q, page = 1, limit = 20 } = req.query;
    if (!q || !q.trim()) {
      return res
        .status(400)
        .json({ success: false, message: "Paramètre de recherche requis" });
    }

    const searchTerm = q
      .toLowerCase()
      .replace(/[^\w\sàâäéèêëïîôöùûüÿç]/g, "")
      .trim();
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const actualLimit = Math.min(parseInt(limit), 100); // Max 100 pour la recherche

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
      .limit(actualLimit)
      .toArray();

    const totalCount = await req.db
      .collection("characters")
      .countDocuments(searchQuery);

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
    // Fichier fixe à télécharger
    const filename = "/modules/database.json";

    // Configuration SFTP depuis les variables d'environnement
    const sftpConfig = {
      host: process.env.SFTP_HOST,
      username: process.env.SFTP_USERNAME,
      password: process.env.SFTP_PASSWORD,
      port: parseInt(process.env.SFTP_PORT) || 22,
      readyTimeout: parseInt(process.env.SFTP_TIMEOUT) || 30000, // Augmenté à 30s
      retries: parseInt(process.env.SFTP_RETRIES) || 3, // Augmenté à 3 tentatives
      // Options d'authentification supplémentaires
      algorithms: {
        cipher: [
          "aes128-ctr",
          "aes192-ctr",
          "aes256-ctr",
          "aes128-gcm",
          "aes256-gcm"
        ],
        hmac: ["hmac-sha2-256", "hmac-sha2-512", "hmac-sha1"],
        kex: [
          "ecdh-sha2-nistp256",
          "ecdh-sha2-nistp384",
          "ecdh-sha2-nistp521",
          "diffie-hellman-group14-sha256"
        ]
      },
      // Tentative avec différentes méthodes d'authentification
      tryKeyboard: true
      // debug: (msg) => console.log('🔍 SFTP Debug:', msg) // Désactivé temporairement
    };

    // Ajouter la clé privée si elle existe
    if (process.env.SFTP_PRIVATE_KEY) {
      sftpConfig.privateKey = process.env.SFTP_PRIVATE_KEY;
      delete sftpConfig.password; // Utiliser la clé privée plutôt que le mot de passe
    }

    // Validation de la configuration SFTP
    if (!sftpConfig.host || !sftpConfig.username) {
      return res.status(500).json({
        success: false,
        message:
          "Configuration SFTP incomplète. Vérifiez les variables d'environnement SFTP_HOST et SFTP_USERNAME"
      });
    }

    if (!sftpConfig.password && !sftpConfig.privateKey) {
      return res.status(500).json({
        success: false,
        message:
          "Authentification SFTP manquante. Définissez SFTP_PASSWORD ou SFTP_PRIVATE_KEY"
      });
    }

    let sftpClient;
    let fileContent;

    try {
      // Connexion SFTP
      sftpClient = new SFTPClient();

      await sftpClient.connect(sftpConfig);

      // Vérifier si le fichier existe
      try {
        const exists = await sftpClient.client.exists(filename);
        if (!exists) {
          throw new Error(
            `Le fichier ${filename} n'existe pas sur le serveur SFTP`
          );
        }
      } catch (existsError) {
        console.warn(
          "⚠️ Impossible de vérifier l'existence du fichier:",
          existsError.message
        );
        // Continuer quand même, certains serveurs SFTP ne supportent pas exists()
      }

      const buffer = await sftpClient.client.get(filename);
      fileContent = buffer.toString("utf8");
    } catch (sftpError) {
      console.error("❌ Erreur SFTP détaillée:", {
        message: sftpError.message,
        code: sftpError.code,
        stack: sftpError.stack
      });
      return res.status(500).json({
        success: false,
        message: "Erreur lors de la connexion SFTP ou du téléchargement",
        error: sftpError.message,
        details: sftpError.code ? `Code d'erreur: ${sftpError.code}` : null
      });
    } finally {
      // Déconnexion SFTP
      if (sftpClient) {
        try {
          await sftpClient.disconnect();
          console.log("🔌 Déconnexion SFTP effectuée");
        } catch (disconnectError) {
          console.warn(
            "⚠️ Erreur lors de la déconnexion SFTP:",
            disconnectError
          );
        }
      }
    }

    // Traitement du contenu du fichier
    let characters;
    try {
      // Essayer de parser en JSON
      characters = JSON.parse(fileContent);
    } catch (parseError) {
      // Si ce n'est pas du JSON, essayer de traiter comme CSV ou autre format
      try {
        // Ici vous pourriez ajouter d'autres parsers (CSV, XML, etc.)
        characters = parseCSV(fileContent);
      } catch (csvError) {
        return res.status(400).json({
          success: false,
          message: "Format de fichier non supporté. JSON ou CSV attendu.",
          error: parseError.message
        });
      }
    }

    if (!Array.isArray(characters)) {
      return res.status(400).json({
        success: false,
        message: "Le fichier doit contenir un tableau de personnages"
      });
    }

    // Connexion FTP pour upload des images
    let ftpUploader = null;
    try {
      ftpUploader = new FTPUploader();
      await ftpUploader.connect();
      console.log("📁 FTP connecté pour upload des images");
    } catch (ftpErr) {
      console.warn("⚠️ Impossible de se connecter au FTP images:", ftpErr.message);
      // On continue sans FTP, les images ne seront pas uploadées
    }

    // Statistiques de traitement
    let insertedCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;
    let imagesUploaded = 0;
    let bannersCreated = 0;
    const errors = [];

    // Traitement de chaque personnage
    for (const [index, char] of characters.entries()) {
      try {
        const cleanedChar = cleanObject(char);

        // Ignorer les entrées sans nom de recherche
        if (
          !cleanedChar["Nom de recherche"] ||
          !cleanedChar["Nom de recherche"].trim()
        ) {
          skippedCount++;
          continue;
        }

        const searchName = cleanedChar["Nom de recherche"]
          .replace(/[^\w\sàâäéèêëïîôöùûüÿç]/g, "")
          .trim();

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

        let immunities = [];
        if (cleanedChar["Immunités"] && cleanedChar["Immunités"].trim()) {
          immunities = cleanedChar["Immunités"]
            .split(",")
            .map((i) => i.trim())
            .filter(Boolean);
        } else {
          immunities = [
            cleanedChar["Immunité 1"] || "",
            cleanedChar["Immunité 2"] || "",
            cleanedChar["Immunité 3"] || ""
          ].filter(Boolean);
        }

        let bannerDoc = await req.db.collection("banners").findOne({
          name: cleanedChar["Loterie"],
          portail: cleanedChar["Portail"]
        });

        // Si la bannière n'existe pas, la créer et uploader l'image
        if (!bannerDoc && cleanedChar["Loterie"] && cleanedChar["Portail"]) {
          const newBanner = {
            name: cleanedChar["Loterie"],
            portail: cleanedChar["Portail"],
            url: cleanedChar["URL Portail"] || "",
          };
          const bannerInsertResult = await req.db.collection("banners").insertOne(newBanner);
          bannerDoc = { _id: bannerInsertResult.insertedId, ...newBanner };
          bannersCreated++;

          // Upload de l'image de la bannière sur le FTP
          if (ftpUploader && cleanedChar["URL Portail"]) {
            const bannerRemotePath = `/bucket.bbs-schrift.fr/banners/${bannerDoc._id}.png`;
            const bannerUploaded = await ftpUploader.downloadAndUpload(
              cleanedChar["URL Portail"],
              bannerRemotePath
            );
            if (bannerUploaded) {
              console.log(`🖼️ Bannière uploadée: ${bannerDoc._id}.png`);
              imagesUploaded++;
            }
          }
        }

        const banner_id = bannerDoc ? bannerDoc._id : null;

        const characterData = {
          name: cleanedChar["Nom personnage"] || "",
          search_name: searchName,
          affinity: cleanedChar["Affinité"] || "",
          rarity: cleanedChar["Rareté"] || "",
          categories: categories,
          killers: killers,
          soul_traits: soul_traits,
          ex_soul_traits: ex_soul_traits,
          attack_type:
            cleanedChar["Attaques Rouges ou Bleues"] === "Attaques B"
              ? "B"
              : "R",
          release_date: convertDateToFormat(cleanedChar["Date sortie"]),
          resurrection_release: convertDateToFormat(
            cleanedChar["Date résurrection"]
          ),
          nad: cleanedChar["NAD ou SAD"] === "NAD" ? "NAD" : false,
          sad: cleanedChar["NAD ou SAD"] === "SAD" ? "SAD" : false,
          version: cleanedChar["Version"] || "",
          version_name: cleanedChar["Nom version"] || "",
          banner_id,
          stats: {
            end: cleanedChar["END"] || null,
            atk: cleanedChar["ATK"] || null,
            def: cleanedChar["DEF"] || null,
            cct: cleanedChar["CCT"] || null,
            pre: cleanedChar["PRE"] || null
          },
          immunities: immunities,
          cancel_resistance:
            CANCEL_RESISTANCE_MAP[
              cleanedChar["Annulation résistance Rouge/Bleue"]
            ] || null,
          updated_at: new Date()
        };

        // Vérifier si le personnage existe déjà
        const existingCharacter = await req.db
          .collection("characters")
          .findOne({ search_name: searchName });

        let characterId;

        if (existingCharacter) {
          // Mettre à jour le personnage existant
          await req.db
            .collection("characters")
            .updateOne({ search_name: searchName }, { $set: characterData });
          characterId = existingCharacter._id;
          updatedCount++;
        } else {
          // Créer un nouveau personnage
          characterData.created_at = new Date();
          const insertResult = await req.db
            .collection("characters")
            .insertOne(characterData);
          characterId = insertResult.insertedId;
          insertedCount++;
        }

        // Upload des images du personnage sur le FTP
        if (ftpUploader && characterId) {
          const imageFields = [
            { field: "Link", remotePath: `/bucket.bbs-schrift.fr/characters/thumb/${characterId}.png` },
            { field: "URL Artwork", remotePath: `/bucket.bbs-schrift.fr/characters/artwork/${characterId}.png` },
            { field: "URL Phrase", remotePath: `/bucket.bbs-schrift.fr/characters/phrase/${characterId}.png` },
            { field: "URL ATK", remotePath: `/bucket.bbs-schrift.fr/characters/attack/${characterId}.png` },
          ];

          for (const img of imageFields) {
            const imageUrl = cleanedChar[img.field];
            if (!imageUrl) continue;

            // Si le personnage existait déjà, vérifier si l'image existe sur le FTP
            if (existingCharacter) {
              const exists = await ftpUploader.fileExists(img.remotePath);
              if (exists) continue;
            }

            const uploaded = await ftpUploader.downloadAndUpload(imageUrl, img.remotePath);
            if (uploaded) {
              imagesUploaded++;
            }
          }
        }
      } catch (charError) {
        errors.push({
          index: index + 1,
          character:
            char["Nom personnage"] || char["Nom de recherche"] || "Inconnu",
          error: charError.message
        });
        skippedCount++;
      }
    }

    // Déconnexion FTP
    if (ftpUploader) {
      try {
        await ftpUploader.disconnect();
      } catch (ftpDisconnectErr) {
        console.warn("⚠️ Erreur déconnexion FTP:", ftpDisconnectErr.message);
      }
    }

    // Vérification finale des personnages créés
    if (insertedCount > 0) {
      const recentlyCreated = await req.db
        .collection("characters")
        .find({ created_at: { $gte: new Date(Date.now() - 60000) } }) // Créés dans la dernière minute
        .sort({ created_at: -1 })
        .limit(10)
        .toArray();
    }

    // Tri automatique des personnages par date de sortie après synchronisation
    let reorderStats = null;
    try {
      reorderStats = await reorderCharactersByReleaseDate(req.db);
    } catch (reorderError) {
      console.error(
        "⚠️ Erreur lors du tri automatique (non bloquant):",
        reorderError
      );
      // On continue même si le tri échoue, ce n'est pas bloquant
    }

    const responseMessage = `Synchronisation terminée: ${insertedCount} personnages créés, ${updatedCount} mis à jour, ${bannersCreated} bannières créées, ${imagesUploaded} images uploadées${
        reorderStats
          ? ` - Tri automatique: ${reorderStats.updated} personnages réorganisés`
          : ""
      }`;
    const responseStats = {
        totalProcessed: characters.length,
        inserted: insertedCount,
        updated: updatedCount,
        skipped: skippedCount,
        bannersCreated: bannersCreated,
        imagesUploaded: imagesUploaded,
        errors: errors.length,
        reorderStats: reorderStats || null
      };

    // --- Notification Discord (non bloquante) ---
    notifyDiscord("character_update", {
      message: responseMessage,
      statistics: responseStats
    });

    res.json({
      success: true,
      message: responseMessage,
      statistics: responseStats,
      errors: errors.length > 0 ? errors.slice(0, 10) : [] // Limiter à 10 erreurs pour éviter une réponse trop lourde
    });
  } catch (error) {
    console.error("❌ Erreur lors de la mise à jour via SFTP:", error);
    res.status(500).json({
      success: false,
      message: "Erreur serveur lors de la synchronisation",
      error: error.message
    });
  }
});

function parseCSV(csvContent) {
  const lines = csvContent.split("\n").filter((line) => line.trim());
  if (lines.length < 2) {
    throw new Error(
      "Fichier CSV invalide: au moins une ligne d'en-tête et une ligne de données requises"
    );
  }

  const headers = lines[0].split(",").map((h) => h.trim().replace(/"/g, ""));
  const characters = [];

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(",").map((v) => v.trim().replace(/"/g, ""));
    if (values.length !== headers.length) {
      console.warn(`Ligne ${i + 1} ignorée: nombre de colonnes incorrect`);
      continue;
    }

    const character = {};
    headers.forEach((header, index) => {
      character[header] = values[index] || "";
    });
    characters.push(character);
  }

  return characters;
}

async function reorderCharactersByReleaseDate(db) {
  // Récupérer tous les personnages
  const allCharacters = await db.collection("characters").find({}).toArray();

  // Fonction pour convertir DD/MM/YYYY en Date
  const parseDate = (dateStr) => {
    if (!dateStr || dateStr === null) return new Date("1900-01-01"); // Très ancien par défaut

    // Si c'est déjà un objet Date
    if (dateStr instanceof Date) return dateStr;

    // Si c'est au format DD/MM/YYYY
    if (typeof dateStr === "string" && dateStr.includes("/")) {
      const [day, month, year] = dateStr.split("/");
      return new Date(year, month - 1, day);
    }

    // Sinon essayer de parser directement
    const parsedDate = new Date(dateStr);
    return isNaN(parsedDate.getTime()) ? new Date("1900-01-01") : parsedDate;
  };

  // Trier les personnages par date de sortie
  const sortedCharacters = allCharacters.sort((a, b) => {
    const dateA = parseDate(a.release_date);
    const dateB = parseDate(b.release_date);

    // Tri décroissant (plus récents en premier)
    const dateDiff = dateB.getTime() - dateA.getTime();

    // Si les dates sont identiques, trier par nom
    if (dateDiff === 0) {
      const nameA = a.name || "";
      const nameB = b.name || "";
      return nameA.localeCompare(nameB);
    }

    return dateDiff;
  });

  // Ajouter un champ sort_order basé sur la position dans le tri
  const bulkOps = sortedCharacters.map((char, index) => ({
    updateOne: {
      filter: { _id: char._id },
      update: {
        $set: {
          sort_order: index,
          sort_date_parsed: parseDate(char.release_date),
          updated_at: new Date()
        }
      }
    }
  }));

  const bulkResult = await db.collection("characters").bulkWrite(bulkOps);

  return {
    totalCharacters: allCharacters.length,
    updated: bulkResult.modifiedCount,
    firstCharacter:
      sortedCharacters[0]?.name +
      " (" +
      sortedCharacters[0]?.release_date +
      ")",
    lastCharacter:
      sortedCharacters[sortedCharacters.length - 1]?.name +
      " (" +
      sortedCharacters[sortedCharacters.length - 1]?.release_date +
      ")"
  };
}

router.post("/admin/reorder-by-date", requireAdmin, async (req, res) => {
  try {
    const reorderStats = await reorderCharactersByReleaseDate(req.db);

    res.json({
      success: true,
      message: `Réorganisation manuelle terminée: ${reorderStats.updated} personnages mis à jour`,
      statistics: reorderStats
    });
  } catch (error) {
    console.error("❌ Erreur lors de la réorganisation manuelle:", error);
    res.status(500).json({
      success: false,
      message: "Erreur lors de la réorganisation des personnages",
      error: error.message
    });
  }
});

export default router;

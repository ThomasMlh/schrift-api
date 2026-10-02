import express from 'express';
import { ObjectId } from 'mongodb';
import { optionalAuth } from '../../middleware/auth.js';
import { notifyDiscord } from '../../utils/notifyDiscord.js';
import { getUserDisplayName } from '../../utils/nameMatching.js';
import { logger } from '../../utils/logger.js';
import { enrichWithUser, enrichWithRotation, enrichTeamWithCharacters } from './enrich.js';

const router = express.Router();

// POST /builds - Créer une nouvelle team
router.post('/', optionalAuth, async (req, res) => {
  try {
    const { rotation_id, description, team } = req.body;

    // Récupérer le user_id depuis le token et trouver l'_id MongoDB
    let user_id = null;
    if (req.user?.userId || req.user?.discord_id) {
      const userIdentifier = req.user?.userId || req.user?.discord_id;

      // Chercher l'utilisateur pour récupérer son _id MongoDB
      let user;
      if (ObjectId.isValid(userIdentifier)) {
        user = await req.db.collection('users').findOne({ _id: new ObjectId(userIdentifier) });
      } else {
        user = await req.db.collection('users').findOne({ discord_id: userIdentifier });
      }

      if (user) {
        user_id = user._id.toString();
      }
    }

    // Validation des champs obligatoires
    if (!rotation_id) {
      return res.status(400).json({
        success: false,
        message: 'Le rotation_id est obligatoire'
      });
    }

    if (!team || !Array.isArray(team) || team.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'La team est obligatoire et doit contenir au moins un personnage'
      });
    }

    // Vérifier que la rotation existe
    try {
      const rotation = await req.db.collection('rotations').findOne({
        _id: new ObjectId(rotation_id)
      });

      if (!rotation) {
        return res.status(404).json({
          success: false,
          message: 'Rotation non trouvée'
        });
      }
    } catch (error) {
      return res.status(400).json({
        success: false,
        message: 'Format de rotation_id invalide'
      });
    }

    // Validation de la structure de la team
    for (const member of team) {
      if (!member.id_character) {
        return res.status(400).json({
          success: false,
          message: 'Chaque membre de la team doit avoir un id_character'
        });
      }

      if (!member.position || member.position < 1 || member.position > 3) {
        return res.status(400).json({
          success: false,
          message: 'Chaque membre doit avoir une position entre 1 et 3'
        });
      }

      // Vérifier que le personnage existe
      try {
        const character = await req.db.collection('characters').findOne({
          _id: new ObjectId(member.id_character)
        });

        if (!character) {
          return res.status(404).json({
            success: false,
            message: `Personnage avec l'ID ${member.id_character} non trouvé`
          });
        }
      } catch (error) {
        return res.status(400).json({
          success: false,
          message: `Format d'ID de personnage invalide: ${member.id_character}`
        });
      }

      // Valider les links si présents
      if (member.links && Array.isArray(member.links)) {
        if (member.links.length > 3) {
          return res.status(400).json({
            success: false,
            message: 'Chaque membre ne peut avoir que 3 links maximum'
          });
        }

        for (const link of member.links) {
          if (!link.id_character) {
            return res.status(400).json({
              success: false,
              message: 'Chaque link doit avoir un id_character'
            });
          }

          // Vérifier que le personnage du link existe
          try {
            const linkCharacter = await req.db.collection('characters').findOne({
              _id: new ObjectId(link.id_character)
            });

            if (!linkCharacter) {
              return res.status(404).json({
                success: false,
                message: `Personnage du link avec l'ID ${link.id_character} non trouvé`
              });
            }
          } catch (error) {
            return res.status(400).json({
              success: false,
              message: `Format d'ID de personnage du link invalide: ${link.id_character}`
            });
          }
        }
      }

      // Valider les skills si présents (max 2 skills par personnage)
      if (member.skills && Array.isArray(member.skills)) {
        if (member.skills.length > 2) {
          return res.status(400).json({
            success: false,
            message: 'Chaque membre ne peut avoir que 2 skills maximum'
          });
        }

        for (const skillId of member.skills) {
          // Vérifier que le skill existe
          try {
            const skill = await req.db.collection('skills').findOne({
              _id: new ObjectId(skillId)
            });

            if (!skill) {
              return res.status(404).json({
                success: false,
                message: `Skill avec l'ID ${skillId} non trouvé`
              });
            }
          } catch (error) {
            return res.status(400).json({
              success: false,
              message: `Format d'ID de skill invalide: ${skillId}`
            });
          }
        }
      }

      // Valider les accessories si présents (max 3 accessories par personnage)
      if (member.accessories && Array.isArray(member.accessories)) {
        if (member.accessories.length > 3) {
          return res.status(400).json({
            success: false,
            message: 'Chaque membre ne peut avoir que 3 accessories maximum'
          });
        }

        for (const accessory of member.accessories) {
          if (!accessory.id_accessory) {
            return res.status(400).json({
              success: false,
              message: 'Chaque accessory doit avoir un id_accessory'
            });
          }

          // Vérifier que l'accessory existe
          try {
            const accessoryDoc = await req.db.collection('accessories').findOne({
              _id: new ObjectId(accessory.id_accessory)
            });

            if (!accessoryDoc) {
              return res.status(404).json({
                success: false,
                message: `Accessory avec l'ID ${accessory.id_accessory} non trouvé`
              });
            }
          } catch (error) {
            return res.status(400).json({
              success: false,
              message: `Format d'ID d'accessory invalide: ${accessory.id_accessory}`
            });
          }

          // Vérifier le subeffect si présent
          if (accessory.id_subeffect) {
            try {
              const subeffect = await req.db.collection('accessories_subeffect').findOne({
                _id: new ObjectId(accessory.id_subeffect)
              });

              if (!subeffect) {
                return res.status(404).json({
                  success: false,
                  message: `Subeffect avec l'ID ${accessory.id_subeffect} non trouvé`
                });
              }
            } catch (error) {
              return res.status(400).json({
                success: false,
                message: `Format d'ID de subeffect invalide: ${accessory.id_subeffect}`
              });
            }
          }
        }
      }
    }

    // Créer le build
    const newBuild = {
      rotation_id: rotation_id,
      description: description || '',
      isValid: false, // Toujours false par défaut
      user_id: user_id,
      team: team,
      created_at: new Date(),
      updated_at: new Date()
    };

    const result = await req.db.collection('builds').insertOne(newBuild);

    // Récupérer le build créé avec enrichissement
    const createdBuild = await req.db.collection('builds').findOne({
      _id: result.insertedId
    });

    const enrichedTeam = await enrichTeamWithCharacters(createdBuild.team, req.db);
    const enrichedBuild = await enrichWithUser(createdBuild, req.db);
    const enrichedWithRotation = await enrichWithRotation(enrichedBuild, req.db);

    // Notification Discord — attendue avant la réponse.
    try {
      const rotation = enrichedWithRotation.rotation;
      await notifyDiscord('build_proposal', {
        action: 'proposal',
        proposed_by: enrichedBuild.user ? getUserDisplayName(enrichedBuild.user) : 'Anonyme',
        description: newBuild.description,
        killer: rotation?.killer || '',
        attack: rotation?.attack || '',
        team_size: enrichedTeam.length
      });
    } catch (notifErr) {
      logger.error('[builds/create] Erreur notification Discord (non bloquant):', notifErr.message);
    }

    res.status(201).json({
      success: true,
      message: 'Build créé avec succès',
      data: {
        ...enrichedWithRotation,
        team: enrichedTeam
      }
    });
  } catch (error) {
    logger.error('Erreur lors de la création du build:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur serveur lors de la création du build'
    });
  }
});

export default router;

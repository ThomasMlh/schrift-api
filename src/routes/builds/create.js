import express from 'express';
import { ObjectId } from 'mongodb';
import { optionalAuth } from '../../middleware/auth.js';
import { notifyDiscord } from '../../utils/notifyDiscord.js';
import { getUserDisplayName } from '../../utils/nameMatching.js';
import { logger } from '../../utils/logger.js';
import { enrichWithUser, enrichWithRotation, enrichTeamWithCharacters } from './enrich.js';
import { parseBuildResult } from './result.js';

const router = express.Router();

// POST /builds - create a build
router.post('/', optionalAuth, async (req, res) => {
  try {
    const { rotation_id, description, team } = req.body;

    // Resolve the author's MongoDB _id from the token
    let user_id = null;
    if (req.user?.userId || req.user?.discord_id) {
      const userIdentifier = req.user?.userId || req.user?.discord_id;

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

    // Optional result (score, times)
    const { values: buildResult, error: resultError } = parseBuildResult(req.body);
    if (resultError) {
      return res.status(400).json({ success: false, message: resultError });
    }

    // Required fields
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

    // Team structure
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

      // At most 2 skills per character
      if (member.skills && Array.isArray(member.skills)) {
        if (member.skills.length > 2) {
          return res.status(400).json({
            success: false,
            message: 'Chaque membre ne peut avoir que 2 skills maximum'
          });
        }

        for (const skillId of member.skills) {
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

      // At most 3 accessories per character
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

    const newBuild = {
      rotation_id: rotation_id,
      description: description || '',
      isValid: false, // Builds are validated by an admin
      user_id: user_id,
      team: team,
      score: buildResult.score ?? null,
      time_normal_wave: buildResult.time_normal_wave ?? null,
      time_extra_wave: buildResult.time_extra_wave ?? null,
      screenshot: null,
      created_at: new Date(),
      updated_at: new Date()
    };

    const result = await req.db.collection('builds').insertOne(newBuild);

    const createdBuild = await req.db.collection('builds').findOne({
      _id: result.insertedId
    });

    const enrichedTeam = await enrichTeamWithCharacters(createdBuild.team, req.db);
    const enrichedBuild = await enrichWithUser(createdBuild, req.db);
    const enrichedWithRotation = await enrichWithRotation(enrichedBuild, req.db);

    // Discord notification, awaited before responding.
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

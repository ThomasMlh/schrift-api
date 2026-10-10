import express from 'express';
import { ObjectId } from 'mongodb';
import { requireAdmin, optionalAuth, validateObjectIdParam } from '../../middleware/auth.js';
import { logger } from '../../utils/logger.js';
import { enrichWithUser, enrichWithRotation, enrichTeamWithCharacters } from './enrich.js';
import { parseBuildResult } from './result.js';

const router = express.Router();

// PATCH /builds/:id - Mettre à jour un build
router.patch('/:id', optionalAuth, validateObjectIdParam('id'), async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    // Vérifier que le build existe
    const existingBuild = await req.db.collection('builds').findOne({
      _id: new ObjectId(id)
    });

    if (!existingBuild) {
      return res.status(404).json({
        success: false,
        message: 'Build non trouvé'
      });
    }

    // Vérifier que l'utilisateur a le droit de modifier ce build
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Authentification requise'
      });
    }

    // Récupérer l'ID MongoDB de l'utilisateur courant
    let currentUserId = null;
    const userIdentifier = req.user?.userId || req.user?.discord_id;

    if (userIdentifier) {
      let user;
      if (ObjectId.isValid(userIdentifier)) {
        user = await req.db.collection('users').findOne({ _id: new ObjectId(userIdentifier) });
      } else {
        user = await req.db.collection('users').findOne({ discord_id: userIdentifier });
      }

      if (user) {
        currentUserId = user._id.toString();
      }
    }

    // Seul le propriétaire ou un admin peut modifier
    const isOwner = existingBuild.user_id === currentUserId;
    const isAdmin = req.user.is_admin === true;

    if (!isOwner && !isAdmin) {
      return res.status(403).json({
        success: false,
        message: 'Vous n\'avez pas la permission de modifier ce build'
      });
    }

    // Valider les champs si présents
    if (updates.rotation_id) {
      try {
        const rotation = await req.db.collection('rotations').findOne({
          _id: new ObjectId(updates.rotation_id)
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
    }

    if (updates.team && Array.isArray(updates.team)) {
      // Valider la structure de la team
      for (const member of updates.team) {
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

        // Valider les skills si présents
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
    }

    const { values: result, error: resultError } = parseBuildResult(updates);
    if (resultError) {
      return res.status(400).json({ success: false, message: resultError });
    }

    // Seuls les champs modifiables sont enregistrés (la capture passe par /:id/screenshot,
    // l'auteur et la validation ne se changent pas ici)
    const setFields = { ...result, updated_at: new Date() };
    for (const field of ['rotation_id', 'description', 'team']) {
      if (field in updates) setFields[field] = updates[field];
    }

    // Forcer isValid à false si ce n'est pas un admin qui modifie
    if (!isAdmin) {
      setFields.isValid = false;
    }

    await req.db.collection('builds').updateOne(
      { _id: new ObjectId(id) },
      { $set: setFields }
    );

    // Récupérer le build mis à jour
    const updatedBuild = await req.db.collection('builds').findOne({
      _id: new ObjectId(id)
    });

    const enrichedTeam = await enrichTeamWithCharacters(updatedBuild.team, req.db);
    const enrichedBuild = await enrichWithUser(updatedBuild, req.db);
    const enrichedWithRotation = await enrichWithRotation(enrichedBuild, req.db);

    res.json({
      success: true,
      message: 'Build mis à jour avec succès',
      data: {
        ...enrichedWithRotation,
        team: enrichedTeam
      }
    });
  } catch (error) {
    logger.error('Erreur lors de la mise à jour du build:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur serveur lors de la mise à jour du build'
    });
  }
});

// PATCH /builds/:id/validate - Valider un build (admin seulement)
router.patch('/:id/validate', requireAdmin, validateObjectIdParam('id'), async (req, res) => {
  try {
    const { id } = req.params;
    const { isValid } = req.body;

    if (typeof isValid !== 'boolean') {
      return res.status(400).json({
        success: false,
        message: 'Le champ isValid doit être un booléen'
      });
    }

    const result = await req.db.collection('builds').updateOne(
      { _id: new ObjectId(id) },
      {
        $set: {
          isValid: isValid,
          validated_at: new Date(),
          validated_by: req.user.userId || req.user.discord_id,
          updated_at: new Date()
        }
      }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({
        success: false,
        message: 'Build non trouvé'
      });
    }

    // Récupérer le build mis à jour
    const updatedBuild = await req.db.collection('builds').findOne({
      _id: new ObjectId(id)
    });

    const enrichedTeam = await enrichTeamWithCharacters(updatedBuild.team, req.db);
    const enrichedBuild = await enrichWithUser(updatedBuild, req.db);
    const enrichedWithRotation = await enrichWithRotation(enrichedBuild, req.db);

    res.json({
      success: true,
      message: `Build ${isValid ? 'validé' : 'invalidé'} avec succès`,
      data: {
        ...enrichedWithRotation,
        team: enrichedTeam
      }
    });
  } catch (error) {
    logger.error('Erreur lors de la validation du build:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur serveur lors de la validation du build'
    });
  }
});

export default router;

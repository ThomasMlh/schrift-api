import express from 'express';
import jwt from 'jsonwebtoken';
import { ObjectId } from 'mongodb';
import { requireDb, requireAdmin } from '../middleware/auth.js';

const router = express.Router();

// Middleware pour toutes les routes builds
router.use(requireDb);

// Middleware pour extraire l'utilisateur du token (optionnel)
const extractUser = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');

    if (token) {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      req.user = decoded;
    }
  } catch (error) {
    // Si le token est invalide, on continue sans utilisateur
    req.user = null;
  }
  next();
};

// Helper function pour enrichir avec les données utilisateur
const enrichWithUser = async (build, db) => {
  if (!build || !build.user_id) return build;

  try {
    let user;
    
    // Essayer d'abord comme ObjectId MongoDB
    if (ObjectId.isValid(build.user_id)) {
      user = await db.collection('users').findOne(
        { _id: new ObjectId(build.user_id) },
        { projection: { discord_id: 1, username: 1, global_name: 1, bbs_name: 1, avatar: 1, is_admin: 1 } }
      );
    }
    
    // Sinon, essayer comme discord_id
    if (!user) {
      user = await db.collection('users').findOne(
        { discord_id: build.user_id },
        { projection: { discord_id: 1, username: 1, global_name: 1, bbs_name: 1, avatar: 1, is_admin: 1 } }
      );
    }

    return {
      ...build,
      user: user || null
    };
  } catch (error) {
    return {
      ...build,
      user: null
    };
  }
};

// Helper function pour enrichir avec les données de la rotation
const enrichWithRotation = async (build, db) => {
  if (!build || !build.rotation_id) return build;

  try {
    const rotation = await db.collection('rotations').findOne(
      { _id: new ObjectId(build.rotation_id) },
      { projection: { killer: 1, attack: 1, alteration: 1, start_date: 1, end_date: 1, cycle_id: 1 } }
    );

    return {
      ...build,
      rotation: rotation || null
    };
  } catch (error) {
    return {
      ...build,
      rotation: null
    };
  }
};

// Helper function pour enrichir une team avec les données des personnages
const enrichTeamWithCharacters = async (team, db) => {
  if (!team || !Array.isArray(team)) return [];

  const enrichedTeam = [];

  for (const member of team) {
    if (!member.id_character) {
      enrichedTeam.push(member);
      continue;
    }

    // Récupérer les infos du personnage principal
    const character = await db.collection('characters').findOne(
      { _id: new ObjectId(member.id_character) },
      { projection: { name: 1, image: 1, rarity: 1, element: 1, affinity: 1 } }
    );

    // Enrichir les links avec soul_traits
    const enrichedLinks = [];
    if (Array.isArray(member.links)) {
      for (const link of member.links) {
        if (!link.id_character) {
          enrichedLinks.push(link);
          continue;
        }

        const linkCharacter = await db.collection('characters').findOne(
          { _id: new ObjectId(link.id_character) },
          { projection: { name: 1, image: 1, rarity: 1, element: 1, affinity: 1, soul_traits: 1 } }
        );

        enrichedLinks.push({
          ...link,
          character: linkCharacter || null
        });
      }
    }

    // Enrichir les skills
    const enrichedSkills = [];
    if (Array.isArray(member.skills)) {
      for (const skillId of member.skills) {
        try {
          const skill = await db.collection('skills').findOne(
            { _id: new ObjectId(skillId) },
            { projection: { name: 1 } }
          );
          if (skill) {
            enrichedSkills.push(skill);
          }
        } catch (error) {
          // Skip invalid skill IDs
          continue;
        }
      }
    }

    // Enrichir les accessories
    const enrichedAccessories = [];
    if (Array.isArray(member.accessories)) {
      for (const accessory of member.accessories) {
        try {
          const accessoryDoc = await db.collection('accessories').findOne(
            { _id: new ObjectId(accessory.id_accessory) },
            { projection: { name: 1 } }
          );

          let subeffectDoc = null;
          if (accessory.id_subeffect) {
            subeffectDoc = await db.collection('accessories_subeffect').findOne(
              { _id: new ObjectId(accessory.id_subeffect) },
              { projection: { name: 1 } }
            );
          }

          enrichedAccessories.push({
            accessory: accessoryDoc || null,
            subeffect: subeffectDoc || null
          });
        } catch (error) {
          // Skip invalid accessory IDs
          continue;
        }
      }
    }

    enrichedTeam.push({
      ...member,
      character: character || null,
      links: enrichedLinks,
      skills: enrichedSkills,
      accessories: enrichedAccessories
    });
  }

  return enrichedTeam;
};

// POST /builds - Créer une nouvelle team
router.post('/', extractUser, async (req, res) => {
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

    res.status(201).json({
      success: true,
      message: 'Build créé avec succès',
      data: {
        ...enrichedWithRotation,
        team: enrichedTeam
      }
    });
  } catch (error) {
    console.error('Erreur lors de la création du build:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur serveur lors de la création du build'
    });
  }
});

// GET /builds - Récupérer tous les builds avec filtres et pagination
router.get('/', async (req, res) => {
  try {
    const {
      rotation_id,
      isValid,
      page = 1,
      limit = 20
    } = req.query;

    // Paramètres de pagination
    const pageNumber = Math.max(1, parseInt(page, 10) || 1);
    const limitNumber = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const skip = (pageNumber - 1) * limitNumber;

    // Construction du filtre
    const filter = {};

    if (rotation_id) {
      filter.rotation_id = rotation_id;
    }

    if (isValid !== undefined) {
      filter.isValid = isValid === 'true' || isValid === true;
    }

    // Récupérer les builds
    const builds = await req.db.collection('builds')
      .find(filter)
      .sort({ created_at: -1 })
      .skip(skip)
      .limit(limitNumber)
      .toArray();

    // Enrichir chaque build avec les données des personnages et utilisateur
    const enrichedBuilds = [];
    for (const build of builds) {
      const enrichedTeam = await enrichTeamWithCharacters(build.team, req.db);
      const enrichedBuild = await enrichWithUser(build, req.db);
      const enrichedWithRotation = await enrichWithRotation(enrichedBuild, req.db);
      enrichedBuilds.push({
        ...enrichedWithRotation,
        team: enrichedTeam
      });
    }

    const totalCount = await req.db.collection('builds').countDocuments(filter);
    const totalPages = Math.ceil(totalCount / limitNumber);

    res.json({
      success: true,
      data: enrichedBuilds,
      pagination: {
        currentPage: pageNumber,
        totalPages,
        totalCount,
        hasNextPage: pageNumber < totalPages,
        hasPrevPage: pageNumber > 1,
        itemsPerPage: limitNumber,
        itemsOnPage: enrichedBuilds.length
      },
      filters: {
        rotation_id: rotation_id || null,
        isValid: isValid || null
      }
    });
  } catch (error) {
    console.error('Erreur lors de la récupération des builds:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur serveur lors de la récupération des builds'
    });
  }
});

// GET /builds/:id - Récupérer un build spécifique
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Format d\'ID invalide'
      });
    }

    const build = await req.db.collection('builds').findOne({
      _id: new ObjectId(id)
    });

    if (!build) {
      return res.status(404).json({
        success: false,
        message: 'Build non trouvé'
      });
    }

    // Enrichir la team avec les données des personnages et utilisateur
    const enrichedTeam = await enrichTeamWithCharacters(build.team, req.db);
    const enrichedBuild = await enrichWithUser(build, req.db);
    const enrichedWithRotation = await enrichWithRotation(enrichedBuild, req.db);

    res.json({
      success: true,
      data: {
        ...enrichedWithRotation,
        team: enrichedTeam
      }
    });
  } catch (error) {
    console.error('Erreur lors de la récupération du build:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur serveur lors de la récupération du build'
    });
  }
});

// PATCH /builds/:id - Mettre à jour un build
router.patch('/:id', extractUser, async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Format d\'ID invalide'
      });
    }

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

    // Mettre à jour - forcer isValid à false si ce n'est pas un admin qui modifie
    updates.updated_at = new Date();
    
    if (!isAdmin) {
      updates.isValid = false;
    }

    const result = await req.db.collection('builds').updateOne(
      { _id: new ObjectId(id) },
      { $set: updates }
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
    console.error('Erreur lors de la mise à jour du build:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur serveur lors de la mise à jour du build'
    });
  }
});

// PATCH /builds/:id/validate - Valider un build (admin seulement)
router.patch('/:id/validate', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { isValid } = req.body;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Format d\'ID invalide'
      });
    }

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
    console.error('Erreur lors de la validation du build:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur serveur lors de la validation du build'
    });
  }
});

// DELETE /builds/:id - Supprimer un build
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Format d\'ID invalide'
      });
    }

    const result = await req.db.collection('builds').deleteOne({
      _id: new ObjectId(id)
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({
        success: false,
        message: 'Build non trouvé'
      });
    }

    res.json({
      success: true,
      message: 'Build supprimé avec succès'
    });
  } catch (error) {
    console.error('Erreur lors de la suppression du build:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur serveur lors de la suppression du build'
    });
  }
});

export default router;

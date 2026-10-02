import { ObjectId } from 'mongodb';
import { USER_BUILD } from '../../utils/projections.js';

// Enrichissement partagé par toutes les routes builds (create/crud/update) :
// un build stocké ne contient que des ObjectId (user_id, rotation_id,
// team[].id_character, ...), ces helpers y greffent les documents complets
// pour la réponse API.

// Helper function pour enrichir avec les données utilisateur
export const enrichWithUser = async (build, db) => {
  if (!build || !build.user_id) return build;

  try {
    let user;

    // Essayer d'abord comme ObjectId MongoDB
    if (ObjectId.isValid(build.user_id)) {
      user = await db.collection('users').findOne(
        { _id: new ObjectId(build.user_id) },
        { projection: USER_BUILD }
      );
    }

    // Sinon, essayer comme discord_id
    if (!user) {
      user = await db.collection('users').findOne(
        { discord_id: build.user_id },
        { projection: USER_BUILD }
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
export const enrichWithRotation = async (build, db) => {
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
export const enrichTeamWithCharacters = async (team, db) => {
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
            { projection: { name: 1, code: 1 } }
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

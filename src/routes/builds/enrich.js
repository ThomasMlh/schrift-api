import { ObjectId } from 'mongodb';
import { USER_BUILD } from '../../utils/projections.js';

// Enrichment shared by every builds route (create/crud/update): a stored build only holds ids
// (user_id, rotation_id, team[].id_character, …); these helpers attach the full documents for the
// API response.

export const enrichWithUser = async (build, db) => {
  if (!build || !build.user_id) return build;

  try {
    let user;

    // Try a MongoDB ObjectId first
    if (ObjectId.isValid(build.user_id)) {
      user = await db.collection('users').findOne(
        { _id: new ObjectId(build.user_id) },
        { projection: USER_BUILD }
      );
    }

    // Otherwise treat it as a discord_id
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

const CHARACTER_FIELDS = { name: 1, image: 1, rarity: 1, element: 1, affinity: 1, soul_traits: 1 };

const loadByIds = async (db, collection, ids, projection) => {
  const validIds = [...new Set(ids.filter((id) => id && ObjectId.isValid(id)).map(String))];
  if (validIds.length === 0) return new Map();
  const docs = await db.collection(collection)
    .find({ _id: { $in: validIds.map((id) => new ObjectId(id)) } }, { projection })
    .toArray();
  return new Map(docs.map((doc) => [doc._id.toString(), doc]));
};

const withoutSoulTraits = (character) => {
  if (!character) return null;
  const rest = { ...character };
  delete rest.soul_traits;
  return rest;
};

// Attaches characters, links, skills and accessories to several teams with one query per collection.
// Invalid skill ids are dropped, and so are accessories with an invalid accessory or sub-effect id.
export const enrichTeams = async (teams, db) => {
  const members = teams.flatMap((team) => (Array.isArray(team) ? team : []));
  const accessories = members.flatMap((m) => (Array.isArray(m.accessories) ? m.accessories : []));

  const [characters, skills, accessoryDocs, subeffects] = await Promise.all([
    loadByIds(db, 'characters', members.flatMap((m) => [
      m.id_character,
      ...(Array.isArray(m.links) ? m.links.map((l) => l.id_character) : []),
    ]), CHARACTER_FIELDS),
    loadByIds(db, 'skills', members.flatMap((m) => (Array.isArray(m.skills) ? m.skills : [])), { name: 1 }),
    loadByIds(db, 'accessories', accessories.map((a) => a.id_accessory), { name: 1, code: 1 }),
    loadByIds(db, 'accessories_subeffect', accessories.map((a) => a.id_subeffect), { name: 1 }),
  ]);

  const enrichMember = (member) => {
    if (!member.id_character) return member;
    return {
      ...member,
      character: withoutSoulTraits(characters.get(String(member.id_character))),
      links: (Array.isArray(member.links) ? member.links : []).map((link) => (
        link.id_character ? { ...link, character: characters.get(String(link.id_character)) || null } : link
      )),
      skills: (Array.isArray(member.skills) ? member.skills : [])
        .map((id) => skills.get(String(id)))
        .filter(Boolean),
      accessories: (Array.isArray(member.accessories) ? member.accessories : [])
        .filter((a) => ObjectId.isValid(a.id_accessory) && (!a.id_subeffect || ObjectId.isValid(a.id_subeffect)))
        .map((a) => ({
          accessory: accessoryDocs.get(String(a.id_accessory)) || null,
          subeffect: a.id_subeffect ? subeffects.get(String(a.id_subeffect)) || null : null,
        })),
    };
  };

  return teams.map((team) => (Array.isArray(team) ? team.map(enrichMember) : []));
};

export const enrichTeamWithCharacters = async (team, db) => (await enrichTeams([team], db))[0];

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

const CHARACTER_FIELDS = {
  name: 1, version: 1, image: 1, rarity: 1, element: 1, affinity: 1, 'traits.link': 1, 'traits.ex': 1, 'resurrection.traits.link': 1,
};

const loadByIds = async (db, collection, ids, projection) => {
  const validIds = [...new Set(ids.filter((id) => id && ObjectId.isValid(id)).map(String))];
  if (validIds.length === 0) return new Map();
  const docs = await db.collection(collection)
    .find({ _id: { $in: validIds.map((id) => new ObjectId(id)) } }, { projection })
    .toArray();
  return new Map(docs.map((doc) => [doc._id.toString(), doc]));
};

// EX traits only exist on the base form, one value per EX level
const toTeamCharacter = (character) => {
  if (!character) return null;
  const { traits, resurrection, ...rest } = character;
  return { ...rest, ex_traits: (traits?.ex ?? []).map(({ text, values }) => ({ text, values })) };
};

// Soul traits of a link, from the game tables: the resurrected values when the character has that form
const toLinkCharacter = (character) => {
  if (!character) return null;
  const traits = character.resurrection?.traits?.link?.length ? character.resurrection.traits.link : character.traits?.link;
  return { ...toTeamCharacter(character), link_traits: (traits ?? []).map(({ name, text }) => ({ name, text })) };
};

// Album of each author's main bbs account ({ <character _id>: spe }), by user id
const loadAuthorAlbums = async (db, userIds) => {
  const users = await loadByIds(db, 'users', userIds, { bbs_id: 1, bbs_accounts: 1 });
  const mainAccount = new Map([...users].map(([id, user]) => {
    const accounts = user.bbs_accounts ?? [];
    const account = accounts.find((a) => a.is_primary) ?? accounts[0];
    return [id, account?.bbs_id ?? user.bbs_id ?? null];
  }));
  const bbsIds = [...new Set([...mainAccount.values()].filter(Boolean))];
  if (bbsIds.length === 0) return new Map();
  const albums = await db.collection('albums')
    .find({ bbs_id: { $in: bbsIds } }, { projection: { bbs_id: 1, characters: 1 } })
    .toArray();
  const byBbsId = new Map(albums.map((album) => [album.bbs_id, album.characters ?? {}]));
  return new Map([...mainAccount].map(([id, bbsId]) => [id, byBbsId.get(bbsId) ?? {}]));
};

// Attaches characters, links, skills and accessories to several teams with one query per collection.
// Invalid skill ids are dropped, and so are accessories with an invalid accessory or sub-effect id.
// With the author of each team (userIds, in the same order), members and links also get `spe`, the
// level set in the author's album; it is left out when the album does not list the character.
export const enrichTeams = async (teams, db, userIds = []) => {
  const members = teams.flatMap((team) => (Array.isArray(team) ? team : []));
  const accessories = members.flatMap((m) => (Array.isArray(m.accessories) ? m.accessories : []));

  const [characters, skills, accessoryDocs, subeffects, albums] = await Promise.all([
    loadByIds(db, 'characters', members.flatMap((m) => [
      m.id_character,
      ...(Array.isArray(m.links) ? m.links.map((l) => l.id_character) : []),
    ]), CHARACTER_FIELDS),
    loadByIds(db, 'skills', members.flatMap((m) => (Array.isArray(m.skills) ? m.skills : [])), { name: 1, names: 1, value: 1, format: 1 }),
    loadByIds(db, 'accessories', accessories.map((a) => a.id_accessory), { name: 1, names: 1, code: 1, rarity: 1, effect: 1, same_affinity_rate: 1 }),
    loadByIds(db, 'accessories_subeffect', accessories.map((a) => a.id_subeffect), { name: 1, names: 1, value: 1 }),
    loadAuthorAlbums(db, userIds.map((id) => (id ? String(id) : null))),
  ]);

  const enrichMember = (album) => (member) => {
    if (!member.id_character) return member;
    const withSpe = (doc, id) => (album[String(id)] ? { ...doc, spe: album[String(id)] } : doc);
    return {
      ...withSpe(member, member.id_character),
      character: toTeamCharacter(characters.get(String(member.id_character))),
      links: (Array.isArray(member.links) ? member.links : []).map((link) => (
        link.id_character
          ? withSpe({ ...link, character: toLinkCharacter(characters.get(String(link.id_character))) }, link.id_character)
          : link
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

  return teams.map((team, i) => (
    Array.isArray(team) ? team.map(enrichMember(albums.get(String(userIds[i])) ?? {})) : []
  ));
};

export const enrichTeamWithCharacters = async (team, db, userId) => (await enrichTeams([team], db, [userId]))[0];

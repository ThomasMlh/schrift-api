// Pipeline commun pour joindre users (identité Discord uniquement : avatar/global_name) à partir
// d'un champ user_id présent sur le document, et guildes à partir d'un champ guild_id présent sur
// le document lui-même (le guild_id/bbs_name du SCORE, jamais la guilde/le pseudo actuels du user
// — un même user peut avoir plusieurs comptes bbs classés séparément dans des guildes différentes).
// Nombre minimum de rotations jouées pour apparaître dans un classement basé sur une moyenne
// (sinon un joueur avec 1-2 scores excellents peut dominer des joueurs réguliers avec beaucoup
// plus de scores). Ne s'applique pas aux vues par rotation unique (un seul score possible) ni
// aux misses (comptage, pas une moyenne). Configurable par l'admin (app_settings/podium) ;
// 0 = désactivé. Repli si aucun réglage n'existe encore en base.
const DEFAULT_MIN_SCORES_FOR_RANKING = 0;

export const getMinScoresForRanking = async (db) => {
  const settings = await db.collection('app_settings').findOne({ _id: 'podium' });
  return typeof settings?.min_scores_for_ranking === 'number'
    ? settings.min_scores_for_ranking
    : DEFAULT_MIN_SCORES_FOR_RANKING;
};

export const lookupUserAndGuild = () => {
  return [
    {
      $lookup: {
        from: 'users',
        let: { userId: "$user_id" },
        pipeline: [
          {
            $match: {
              $expr: {
                $or: [
                  { $eq: [{ $toString: "$_id" }, "$$userId"] },
                  { $eq: ["$discord_id", "$$userId"] }
                ]
              }
            }
          },
          { $project: { _id: 1, discord_id: 1, avatar: 1, global_name: 1, username: 1 } }
        ],
        as: 'user'
      }
    },
    {
      $lookup: {
        from: 'guildes',
        let: { guildId: "$guild_id" },
        pipeline: [
          { $match: { $expr: { $eq: [{ $toString: "$_id" }, "$$guildId"] } } },
          { $project: { name: 1 } }
        ],
        as: 'guild'
      }
    },
    { $addFields: { hasUser: { $gt: [{ $size: "$user" }, 0] } } }
  ];
}

// Alias conservé pour lisibilité aux call sites existants (même pipeline).
export const lookupUserByUserId = lookupUserAndGuild;

// Résout les bbs_id actuellement rattachés à une guilde (users.bbs_accounts[].guilde_id),
// pour attribuer un score à la guilde ACTUELLE du compte plutôt qu'à la guilde figée sur
// le score au moment de la saisie (utile après un transfert de guilde en cours de cycle).
export const getCurrentGuildBbsIds = async (db, guildId) => {
  const users = await db.collection('users').find(
    { 'bbs_accounts.guilde_id': guildId },
    { projection: { 'bbs_accounts.bbs_id': 1, 'bbs_accounts.guilde_id': 1 } }
  ).toArray();

  const bbsIds = [];
  for (const user of users) {
    for (const account of user.bbs_accounts || []) {
      if (account.guilde_id === guildId && account.bbs_id) bbsIds.push(account.bbs_id);
    }
  }
  return bbsIds;
};

// Résout les bbs_id des comptes qui n'appartiennent actuellement à aucune guilde, pour que la
// draft auto puisse les proposer comme candidats au même titre que les membres déjà en guilde.
export const getUnguildedBbsIds = async (db) => {
  const users = await db.collection('users').find(
    { 'bbs_accounts.guilde_id': null },
    { projection: { 'bbs_accounts.bbs_id': 1, 'bbs_accounts.guilde_id': 1 } }
  ).toArray();

  const bbsIds = [];
  for (const user of users) {
    for (const account of user.bbs_accounts || []) {
      if (!account.guilde_id && account.bbs_id) bbsIds.push(account.bbs_id);
    }
  }
  return bbsIds;
};

// Condition de match pour une guilde : scores des comptes actuellement dans la guilde (via
// bbs_id). Les scores sans bbs_id (anciens, en voie de suppression) ne remontent jamais.
export const buildGuildMatch = (currentBbsIds) => ({ bbs_id: { $in: currentBbsIds } });

// Une fois le filtre par guilde appliqué, chaque ligne appartient par construction à cette
// guilde : on force l'affichage dessus plutôt que sur le guild_id (potentiellement obsolète,
// cf. buildGuildMatch) figé sur le score.
export const overrideGuildName = (results, guildName) => {
  if (guildName) results.forEach(r => { r.guild_name = guildName; });
  return results;
};

// Calcule les ranks en tenant compte des ex-aequo
export const applyRanks = (results, scoreKey) => {
  let currentRank = 1;
  let previousScore = null;
  return results.map((player, index) => {
    const score = player[scoreKey];
    if (index > 0 && previousScore !== null && score !== previousScore) currentRank++;
    previousScore = score;
    return { rank: currentRank, ...player };
  });
}

// Applique la pagination sur un tableau déjà trié
export const paginate = (results, page, limit) => {
  const skip = (page - 1) * limit;
  const totalCount = results.length;
  const totalPages = Math.ceil(totalCount / limit);
  const items = results.slice(skip, skip + limit);
  return {
    items,
    pagination: {
      currentPage: page,
      totalPages,
      totalCount,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
      itemsPerPage: limit,
      itemsOnPage: items.length
    }
  };
}

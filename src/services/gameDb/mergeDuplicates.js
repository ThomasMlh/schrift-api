/**
 * Merges site characters linked to the same game unit into the kept one: album entries (highest spé
 * wins) and build members/links move to it, then the duplicate is deleted.
 */
export const mergeDuplicates = async (db, duplicates) => {
  const merged = [];
  for (const { keep_id: keepId, merge_ids: mergeIds } of duplicates) {
    const keep = String(keepId);
    for (const mergeId of mergeIds.map(String)) {
      const albums = await db.collection('albums').find({ [`characters.${mergeId}`]: { $exists: true } }).toArray();
      for (const album of albums) {
        const spe = Math.max(album.characters[mergeId] ?? 0, album.characters[keep] ?? 0);
        await db.collection('albums').updateOne(
          { _id: album._id },
          { $set: { [`characters.${keep}`]: spe }, $unset: { [`characters.${mergeId}`]: '' } }
        );
      }

      const members = await db.collection('builds').updateMany(
        { 'team.id_character': mergeId },
        { $set: { 'team.$[member].id_character': keep } },
        { arrayFilters: [{ 'member.id_character': mergeId }] }
      );
      const links = await db.collection('builds').updateMany(
        { 'team.links.id_character': mergeId },
        { $set: { 'team.$[].links.$[link].id_character': keep } },
        { arrayFilters: [{ 'link.id_character': mergeId }] }
      );

      await db.collection('characters').deleteOne({ _id: mergeIds.find((id) => String(id) === mergeId) });
      merged.push({ keep_id: keep, merged_id: mergeId, albums: albums.length, builds: members.modifiedCount + links.modifiedCount });
    }
  }
  return merged;
};

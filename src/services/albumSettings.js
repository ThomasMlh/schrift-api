/**
 * Admin option letting guild leaders and officers fill the albums of their guild's players. Off by default.
 */
export const ALBUM_SETTINGS_ID = 'albums';

export const leadersCanEditAlbums = async (db) => {
  const settings = await db.collection('app_settings').findOne({ _id: ALBUM_SETTINGS_ID }, { projection: { leaders_can_edit: 1 } });
  return settings?.leaders_can_edit === true;
};

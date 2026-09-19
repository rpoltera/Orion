'use strict';

// Shared access rules for browser, Roku, and future TV clients.  Keep the
// decision on the server: a hidden tile alone is never an access control.

const RATING_ORDER = ['G','TV-G','TV-Y','TV-Y7','PG','TV-PG','PG-13','TV-14','R','TV-MA','NC-17','NR','UNRATED'];

function ratingRank(rating) {
  const index = RATING_ORDER.indexOf(String(rating || '').trim().toUpperCase());
  return index === -1 ? RATING_ORDER.length : index;
}

function isRatingAllowed(item, user) {
  if (!user?.maxRating || user?.role === 'admin') return true;
  return ratingRank(item?.contentRating) <= ratingRank(user.maxRating);
}

function asSet(value) {
  return new Set(Array.isArray(value) ? value.map(String) : []);
}

function mergeAccess(target, source) {
  if (!source) return target;
  if (source.all) target.all = true;
  for (const key of ['movies', 'tvShows', 'music', 'musicVideos', 'collections', 'customLibraries', 'liveChannels', 'iptvChannels']) {
    const values = Array.isArray(source[key]) ? source[key] : [];
    values.forEach(value => target[key].add(String(value)));
  }
  return target;
}

function resolveAccess(db, user) {
  const access = {
    all: user?.role === 'admin',
    movies: new Set(), tvShows: new Set(), music: new Set(), musicVideos: new Set(),
    collections: new Set(), customLibraries: new Set(), liveChannels: new Set(), iptvChannels: new Set(),
  };
  if (!user) return access;
  mergeAccess(access, user.mediaAccess);
  for (const group of db.groups || []) {
    if ((user.groupIds || []).includes(group.id)) mergeAccess(access, group.mediaAccess);
  }
  return access;
}

function collectionVisibleToUser(collection, user, access) {
  if (!collection || !user) return false;
  if (access?.all) return true;
  if (!access?.collections.has(String(collection.id))) return false;

  const profile = user.collectionProfile || {};
  const hiddenTypes = new Set(profile.hideCollectionTypes || []);
  if (hiddenTypes.has(collection.type)) return false;
  if (collection.type === 'auto-genre' && profile.showGenreCollections === false) return false;
  if (collection.type === 'auto-decade' && profile.showDecadeCollections === false) return false;
  if (collection.type === 'franchise' && profile.showFranchiseCollections === false) return false;
  if (collection.type === 'network' && profile.showNetworkCollections === false) return false;
  if (collection.type === 'holiday' && profile.showHolidayCollections === false) return false;
  return true;
}

function itemVisibleToUser(db, item, mediaType, user, access = resolveAccess(db, user)) {
  if (!item || !user || !isRatingAllowed(item, user)) return false;
  if (access.all) return true;

  const id = String(item.id || '');
  const keys = mediaType === 'musicVideos' ? ['musicVideos', 'music'] : [mediaType];
  if (keys.some(key => access[key]?.has(id))) return true;

  // A permitted collection is also a permitted way into the collection's
  // contents.  This is essential for a child profile that is assigned a
  // collection rather than every individual episode.
  return (db.collections || []).some(collection =>
    collectionVisibleToUser(collection, user, access) && (collection.mediaIds || []).map(String).includes(id)
  );
}

function customLibraryVisibleToUser(library, user, access = null, db = null) {
  if (!library || !user) return false;
  const resolved = access || resolveAccess(db || { groups: [] }, user);
  return resolved.all || resolved.customLibraries.has(String(library.id));
}

function liveItemVisibleToUser(item, key, user, access = null, db = null) {
  if (!item || !user) return false;
  const resolved = access || resolveAccess(db || { groups: [] }, user);
  if (resolved.all) return true;

  // Live TV remains available to restricted profiles unless an administrator
  // has explicitly created a channel allow-list.  Video-library access never
  // accidentally makes live television disappear.
  const configured = key === 'liveChannels' ? resolved.liveChannels : resolved.iptvChannels;
  if (!configured || configured.size === 0) return true;
  return configured.has(String(item.id || item.tvgId || item.url || ''));
}

module.exports = {
  RATING_ORDER,
  asSet,
  isRatingAllowed,
  resolveAccess,
  collectionVisibleToUser,
  itemVisibleToUser,
  customLibraryVisibleToUser,
  liveItemVisibleToUser,
};

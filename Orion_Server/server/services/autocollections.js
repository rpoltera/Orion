'use strict';

// Orion's collection UI is driven by database records.  This builder works
// entirely from already-fetched local metadata; it never calls a remote API.
const { v4: uuidv4 } = require('uuid');

const STANDARD_DEFAULTS = {
  byGenre: true,
  byDecade: true,
  byYear: true,
  byRating: true,
  byCountry: true,
  byLanguage: true,
  byFranchise: true,
};

function list(value) {
  if (Array.isArray(value)) return value;
  if (value == null || value === '') return [];
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch {}
    return value.split(/[|,;]/).map(v => v.trim()).filter(Boolean);
  }
  return [value];
}

function label(value) {
  if (value && typeof value === 'object') return String(value.name || value.title || value.label || '').trim();
  return String(value || '').trim();
}

function clean(value) {
  return label(value).replace(/\s+/g, ' ').trim();
}

function key(value) {
  return clean(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function yearOf(item) {
  const year = parseInt(item?.year, 10);
  return year >= 1888 && year <= 2200 ? year : null;
}

function showKey(item) {
  return key(item?.seriesTitle || item?.showName || item?.title || item?.filePath || item?.id);
}

function titleFor(item, mediaType) {
  return mediaType === 'tvShows'
    ? clean(item?.seriesTitle || item?.showName || item?.title || 'Unknown Show')
    : clean(item?.title || item?.fileName || 'Unknown Movie');
}

function option(config, name, fallback = false) {
  const nested = config?.autoCollections || {};
  if (typeof nested[name] === 'boolean') return nested[name];
  if (typeof config?.[name] === 'boolean') return config[name];
  return fallback;
}

function numberOption(config, name, fallback) {
  const nested = config?.autoCollections || {};
  const value = nested[name] ?? config?.[name];
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function groupItems(items, mediaType, valuesFor) {
  const groups = new Map();
  for (const item of items) {
    if (!item?.id) continue;
    const identity = mediaType === 'tvShows' ? showKey(item) : String(item.id);
    if (!identity) continue;
    for (const raw of valuesFor(item)) {
      const name = clean(raw);
      if (!name || name.toLowerCase() === 'unknown') continue;
      const groupKey = key(name);
      if (!groupKey) continue;
      if (!groups.has(groupKey)) groups.set(groupKey, { name, items: new Map() });
      const group = groups.get(groupKey);
      if (!group.items.has(identity)) group.items.set(identity, item);
    }
  }
  return groups;
}

function firstArtwork(items) {
  const item = items.find(i => i.thumbnail || i.poster || i.backdrop) || items[0];
  return item?.thumbnail || item?.poster || item?.backdrop || null;
}

function makeCollection(type, mediaType, name, items, sortBy) {
  const displayName = clean(name);
  return {
    id: uuidv4(),
    name: displayName,
    type,
    mediaType,
    mediaIds: items.map(item => item.id),
    thumbnail: firstArtwork(items),
    poster: firstArtwork(items),
    sortBy,
    description: `${displayName} ${mediaType === 'tvShows' ? 'TV shows' : 'movies'}`,
    generatedBy: 'autocollections',
    autoKey: `${type}:${mediaType}:${key(displayName)}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function addGroups(target, type, mediaType, groups, minimum, sortBy) {
  let built = 0;
  for (const group of groups.values()) {
    const items = [...group.items.values()];
    if (items.length < minimum) continue;
    target.push(makeCollection(type, mediaType, group.name, items, sortBy));
    built++;
  }
  return built;
}

function fieldValues(item, fields) {
  const result = [];
  for (const field of fields) result.push(...list(item?.[field]));
  return result.map(label).filter(Boolean);
}

async function buildAutoCollections({ db, saveDB, getConfig, onProgress = () => {} }) {
  const config = getConfig?.()?.autocollections || {};
  const sortBy = config.defaultSort || 'rating';
  const minGenre = numberOption(config, 'minGenreItems', numberOption(config, 'minItems', 3));
  const minPeople = numberOption(config, 'minDirectorItems', 3);
  const minActors = numberOption(config, 'minActorItems', 5);
  const minGeneral = numberOption(config, 'minItems', 3);
  const movies = (db.movies || []).filter(item => item?.id);
  const tvEpisodes = (db.tvShows || []).filter(item => item?.id);
  const newCollections = [];
  const summary = { movies: movies.length, tvEpisodes: tvEpisodes.length, built: {}, skippedWithoutGenre: { movies: 0, tvShows: 0 } };
  const steps = 11;
  let done = 0;

  const progress = (phase, current) => onProgress({ phase, current, done: ++done, total: steps });
  const buildBoth = (enabled, type, valuesFor, minimum, phase, current) => {
    progress(phase, current);
    if (!enabled) return;
    summary.built[type] =
      addGroups(newCollections, type, 'movies', groupItems(movies, 'movies', valuesFor), minimum, sortBy) +
      addGroups(newCollections, type, 'tvShows', groupItems(tvEpisodes, 'tvShows', valuesFor), minimum, sortBy);
  };

  progress('genres', 'Building genre categories');
  if (option(config, 'byGenre', STANDARD_DEFAULTS.byGenre)) {
    summary.skippedWithoutGenre.movies = movies.filter(item => fieldValues(item, ['genres', 'genre']).length === 0).length;
    summary.skippedWithoutGenre.tvShows = tvEpisodes.filter(item => fieldValues(item, ['genres', 'genre']).length === 0).length;
    summary.built['auto-genre'] =
      addGroups(newCollections, 'auto-genre', 'movies', groupItems(movies, 'movies', item => fieldValues(item, ['genres', 'genre'])), minGenre, sortBy) +
      addGroups(newCollections, 'auto-genre', 'tvShows', groupItems(tvEpisodes, 'tvShows', item => fieldValues(item, ['genres', 'genre'])), minGenre, sortBy);
  }

  buildBoth(option(config, 'byDecade', STANDARD_DEFAULTS.byDecade), 'auto-decade', item => {
    const year = yearOf(item); return year ? [`${Math.floor(year / 10) * 10}s`] : [];
  }, minGeneral, 'decades', 'Building decade collections');

  buildBoth(option(config, 'byYear', STANDARD_DEFAULTS.byYear), 'auto-year', item => {
    const year = yearOf(item); return year ? [String(year)] : [];
  }, minGeneral, 'years', 'Building year collections');

  buildBoth(option(config, 'byRating', STANDARD_DEFAULTS.byRating), 'auto-rating', item => fieldValues(item, ['contentRating', 'ratingCode']), minGeneral, 'ratings', 'Building content-rating collections');
  buildBoth(option(config, 'byCountry', STANDARD_DEFAULTS.byCountry), 'auto-country', item => fieldValues(item, ['countries', 'country', 'productionCountries']), minGeneral, 'countries', 'Building country collections');
  buildBoth(option(config, 'byLanguage', STANDARD_DEFAULTS.byLanguage), 'auto-language', item => fieldValues(item, ['languages', 'language', 'originalLanguage']), minGeneral, 'languages', 'Building language collections');
  buildBoth(option(config, 'byStudio', false), 'auto-studio', item => fieldValues(item, ['studios', 'studio', 'productionCompanies']), minGeneral, 'studios', 'Building studio collections');
  buildBoth(option(config, 'byNetwork', false), 'auto-network', item => fieldValues(item, ['networks', 'network', 'watchProviders']), minGeneral, 'networks', 'Building network collections');
  buildBoth(option(config, 'byDirector', false), 'auto-director', item => fieldValues(item, ['director', 'directors']), minPeople, 'directors', 'Building director collections');
  buildBoth(option(config, 'byActor', false), 'auto-actor', item => fieldValues(item, ['cast', 'actors']), minActors, 'actors', 'Building actor collections');
  buildBoth(option(config, 'byFranchise', STANDARD_DEFAULTS.byFranchise), 'auto-franchise', item => fieldValues(item, ['tmdbCollection', 'collection', 'collectionName']), minGeneral, 'franchises', 'Building franchise collections');

  // Preserve user-created collections.  Only Orion-generated entries are
  // replaced, so a rebuild is safe to run every night.
  const preserved = (db.collections || []).filter(collection =>
    collection?.generatedBy !== 'autocollections' && !String(collection?.type || '').startsWith('auto-')
  );
  db.collections = [...preserved, ...newCollections];

  const preservedCategories = (db.categories || []).filter(category => category?.generatedBy !== 'autocollections');
  db.categories = [
    ...preservedCategories,
    ...newCollections.filter(collection => collection.type === 'auto-genre').map(collection => ({
      id: collection.id,
      name: collection.name,
      type: 'genre',
      mediaType: collection.mediaType,
      count: collection.mediaIds.length,
      collectionId: collection.id,
      generatedBy: 'autocollections',
    })),
  ];

  saveDB(true, 'collections');
  summary.total = newCollections.length;
  summary.categories = newCollections.filter(collection => collection.type === 'auto-genre').length;
  return summary;
}

module.exports = { buildAutoCollections };

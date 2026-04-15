'use strict';
/**
 * Orion Metadata Service
 * Fetches movie, TV, and music metadata from TMDB, OMDb, TVMaze, iTunes, Last.fm
 */

const axios = require('axios');

// ── HTTP connection pool ───────────────────────────────────────────────────────
const http_agent  = new (require('http').Agent)({ keepAlive: true, maxSockets: 10 });
const https_agent = new (require('https').Agent)({ keepAlive: true, maxSockets: 10 });
const axiosPool   = axios.create({ httpAgent: http_agent, httpsAgent: https_agent, timeout: 10000 });

// ── Constants ─────────────────────────────────────────────────────────────────
const TMDB_BASE = 'https://api.themoviedb.org/3';
const TMDB_IMG  = 'https://image.tmdb.org/t/p/w500';

const TMDB_GENRES = {
  28:'Action', 12:'Adventure', 16:'Animation', 35:'Comedy', 80:'Crime',
  99:'Documentary', 18:'Drama', 10751:'Family', 14:'Fantasy', 36:'History',
  27:'Horror', 10402:'Music', 9648:'Mystery', 10749:'Romance',
  878:'Science Fiction', 10770:'TV Movie', 53:'Thriller', 10752:'War', 37:'Western',
  10759:'Action & Adventure', 10762:'Kids', 10763:'News', 10764:'Reality',
  10765:'Sci-Fi & Fantasy', 10766:'Soap', 10767:'Talk', 10768:'War & Politics',
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function decodeHtmlEntities(str) {
  if (!str) return str;
  return str
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'");
}

function resolveGenres(ids) {
  if (!ids?.length) return [];
  if (typeof ids[0] === 'string') return ids;
  return ids.map(id => TMDB_GENRES[id] || null).filter(Boolean);
}

function parseMusicVideoFilename(filename) {
  const clean = filename
    .replace(/\.(mkv|mp4|avi|mov|wmv|m4v|webm|flv|mp3|flac|m4a|aac|ogg|opus|wav|wma)$/i, '')
    .replace(/_/g, ' ').trim();
  const parts = clean.split(/\s*[-–—]\s*/);
  if (parts.length >= 4) {
    const trackNum = parts[parts.length - 2];
    if (/^\d{1,3}$/.test(trackNum.trim())) return { artist: parts[0].trim(), title: parts[parts.length - 1].trim() };
    return { artist: parts[0].trim(), title: parts[2].trim() };
  }
  if (parts.length === 3) {
    if (/^\d{1,3}$/.test(parts[1].trim())) return { artist: parts[0].trim(), title: parts[2].trim() };
    return { artist: parts[0].trim(), title: parts[2].trim() };
  }
  if (parts.length === 2) {
    const first = parts[0].trim(), second = parts[1].trim();
    if (/^\d{1,3}$/.test(first)) return { artist: null, title: second };
    return { artist: first, title: second };
  }
  return { artist: null, title: clean };
}

// ── OMDb ──────────────────────────────────────────────────────────────────────
async function fetchOMDb(title, year, type = 'movie', { omdbApiKey = '' } = {}) {
  try {
    const yearParam = year ? `&y=${year}` : '';
    const typeParam = type === 'tv' ? '&type=series' : '&type=movie';
    const keyParam  = omdbApiKey ? `&apikey=${omdbApiKey}` : '&apikey=trilogy';
    const url = `https://www.omdbapi.com/?t=${encodeURIComponent(title)}${yearParam}${typeParam}${keyParam}`;
    const res = await axiosPool.get(url, { timeout: 8000 });
    const d = res.data;
    if (d.Response === 'False') return null;
    return {
      title:    d.Title,
      overview: d.Plot !== 'N/A' ? d.Plot : null,
      poster:   d.Poster !== 'N/A' ? d.Poster : null,
      backdrop: null,
      year:     d.Year ? parseInt(d.Year) : null,
      rating:   d.imdbRating !== 'N/A' ? parseFloat(d.imdbRating).toFixed(1) : null,
      genres:   d.Genre ? d.Genre.split(', ') : [],
      director: d.Director !== 'N/A' ? d.Director : null,
      runtime:  d.Runtime !== 'N/A' ? parseInt(d.Runtime) : null,
      mpaa:     d.Rated !== 'N/A' ? d.Rated : null,
      source:   'omdb',
    };
  } catch (err) {
    console.error('[OMDb] Error:', err.message);
    return null;
  }
}

// ── TVmaze ────────────────────────────────────────────────────────────────────
async function fetchTVmaze(title) {
  try {
    const res = await axiosPool.get(`https://api.tvmaze.com/singlesearch/shows?q=${encodeURIComponent(title)}&embed=cast`, { timeout: 8000 });
    const d = res.data;
    if (!d?.id) return null;
    const cast = (d._embedded?.cast || []).slice(0, 12).map(c => ({ name: c.person?.name, role: c.character?.name }));
    return {
      title:    d.name,
      overview: d.summary ? d.summary.replace(/<[^>]+>/g, '') : null,
      poster:   d.image?.original || d.image?.medium || null,
      backdrop: null,
      year:     d.premiered ? parseInt(d.premiered.split('-')[0]) : null,
      rating:   d.rating?.average ? d.rating.average.toFixed(1) : null,
      genres:   d.genres || [],
      runtime:  d.averageRuntime || null,
      network:  d.network?.name || null,
      status:   d.status || null,
      cast,
      source:   'tvmaze',
    };
  } catch (err) {
    if (!err.message?.includes('404')) console.error('[TVmaze] Error:', err.message);
    return null;
  }
}

// ── TMDB Movie ────────────────────────────────────────────────────────────────
async function fetchTMDBMovie(title, year, { tmdbApiKey } = {}) {
  const key = tmdbApiKey;
  if (!key) return null;
  try {
    const query = encodeURIComponent(title);
    const yearP = year ? `&year=${year}` : '';
    const res   = await axiosPool.get(`${TMDB_BASE}/search/movie?api_key=${key}&query=${query}${yearP}&language=en-US`, { timeout: 8000 });
    const movie = res.data.results?.[0];
    if (!movie) return null;

    // Collection
    let collection = null;
    try {
      const detail = await axiosPool.get(`${TMDB_BASE}/movie/${movie.id}?api_key=${key}&language=en-US`, { timeout: 8000 });
      const col = detail.data.belongs_to_collection;
      if (col) collection = { id: col.id, name: decodeHtmlEntities(col.name), poster: col.poster_path ? `${TMDB_IMG}${col.poster_path}` : null };
    } catch {}

    // Content rating, studios, cast, watch providers
    let contentRating = null, studios = [], watchProviders = [], cast = [], director = null;
    try {
      const [certRes, provRes] = await Promise.all([
        axiosPool.get(`${TMDB_BASE}/movie/${movie.id}?api_key=${key}&append_to_response=release_dates,credits&language=en-US`, { timeout: 8000 }),
        axiosPool.get(`${TMDB_BASE}/movie/${movie.id}/watch/providers?api_key=${key}`, { timeout: 8000 }),
      ]);
      const usReleases = certRes.data.release_dates?.results?.find(r => r.iso_3166_1 === 'US');
      contentRating = usReleases?.release_dates?.find(r => r.certification)?.certification || null;
      studios = (certRes.data.production_companies || []).slice(0, 3).map(s => s.name);
      const crew = certRes.data.credits?.crew || [];
      const castRaw = certRes.data.credits?.cast || [];
      director = crew.find(p => p.job === 'Director')?.name || null;
      cast = await Promise.all(castRaw.slice(0, 10).map(async a => {
        let birthMonth = null;
        try {
          const pr = await axiosPool.get(`${TMDB_BASE}/person/${a.id}?api_key=${key}`, { timeout: 5000 });
          const bd = pr.data.birthday;
          if (bd) birthMonth = parseInt(bd.split('-')[1]);
        } catch {}
        return { name: a.name, character: a.character, image: a.profile_path ? `https://image.tmdb.org/t/p/w185${a.profile_path}` : null, birthMonth };
      }));
      const usProviders = provRes.data.results?.US;
      watchProviders = [...new Set([...(usProviders?.flatrate||[]), ...(usProviders?.free||[]), ...(usProviders?.ads||[])].map(p => p.provider_name))];
    } catch {}

    // Extra details
    let tagline = null, runtime = null, imdbId = null, budget = null, revenue = null, voteCount = null, writers = [];
    try {
      const d = (await axiosPool.get(`${TMDB_BASE}/movie/${movie.id}?api_key=${key}&language=en-US`, { timeout: 8000 })).data;
      tagline = d.tagline || null; runtime = d.runtime || null; imdbId = d.imdb_id || null;
      budget = d.budget || null; revenue = d.revenue || null; voteCount = d.vote_count || null;
      writers = (d.credits?.crew||[]).filter(p=>p.department==='Writing').slice(0,3).map(p=>p.name);
    } catch {}

    return {
      tmdbId: movie.id, title: decodeHtmlEntities(movie.title),
      overview: movie.overview, tagline,
      poster:   movie.poster_path   ? `${TMDB_IMG}${movie.poster_path}` : null,
      backdrop: movie.backdrop_path ? `https://image.tmdb.org/t/p/w1280${movie.backdrop_path}` : null,
      year:     movie.release_date  ? parseInt(movie.release_date.split('-')[0]) : null,
      rating:   movie.vote_average  ? movie.vote_average.toFixed(1) : null,
      voteCount, runtime, imdbId, budget, revenue,
      genres: resolveGenres(movie.genre_ids || []),
      collection, contentRating, studios, watchProviders, cast, director, writers,
      source: 'tmdb',
    };
  } catch (err) {
    console.error('[TMDB] Movie error:', err.message);
    return null;
  }
}

// ── TMDB TV ───────────────────────────────────────────────────────────────────
async function fetchTMDBTV(title, { tmdbApiKey } = {}) {
  const key = tmdbApiKey;
  if (!key) return null;
  try {
    const res  = await axiosPool.get(`${TMDB_BASE}/search/tv?api_key=${key}&query=${encodeURIComponent(title)}&language=en-US`, { timeout: 8000 });
    const show = res.data.results?.[0];
    if (!show) return null;

    let contentRating = null, watchProviders = [], tvStatus = null, networks = [], cast = [];
    try {
      const [detailRes, provRes] = await Promise.all([
        axiosPool.get(`${TMDB_BASE}/tv/${show.id}?api_key=${key}&append_to_response=content_ratings,credits&language=en-US`, { timeout: 8000 }),
        axiosPool.get(`${TMDB_BASE}/tv/${show.id}/watch/providers?api_key=${key}`, { timeout: 8000 }),
      ]);
      const usRating = detailRes.data.content_ratings?.results?.find(r => r.iso_3166_1 === 'US');
      contentRating = usRating?.rating || null;
      tvStatus = detailRes.data.status || null;
      networks = (detailRes.data.networks || []).slice(0, 2).map(n => n.name);
      cast = (detailRes.data.credits?.cast || []).slice(0, 16).map(a => ({
        name: a.name, character: a.character,
        image: a.profile_path ? `https://image.tmdb.org/t/p/w185${a.profile_path}` : null,
      }));
      const usProviders = provRes.data.results?.US;
      watchProviders = [...new Set([...(usProviders?.flatrate||[]), ...(usProviders?.free||[]), ...(usProviders?.ads||[])].map(p => p.provider_name))];
    } catch {}

    let tagline = null, seasonCount = null, episodeCount = null, creators = [], runtime = null, voteCount = null;
    try {
      const d = (await axiosPool.get(`${TMDB_BASE}/tv/${show.id}?api_key=${key}&language=en-US`, { timeout: 8000 })).data;
      tagline = d.tagline || null; seasonCount = d.number_of_seasons || null;
      episodeCount = d.number_of_episodes || null; creators = (d.created_by||[]).map(c=>c.name);
      runtime = d.episode_run_time?.[0] || null; voteCount = d.vote_count || null;
    } catch {}

    return {
      tmdbId: show.id, title: decodeHtmlEntities(show.name),
      overview: show.overview, tagline,
      poster:   show.poster_path   ? `${TMDB_IMG}${show.poster_path}` : null,
      backdrop: show.backdrop_path ? `https://image.tmdb.org/t/p/w1280${show.backdrop_path}` : null,
      year:     show.first_air_date ? parseInt(show.first_air_date.split('-')[0]) : null,
      rating:   show.vote_average  ? show.vote_average.toFixed(1) : null,
      voteCount, runtime, contentRating, watchProviders, tvStatus, networks,
      seasonCount, episodeCount, creators, cast,
      genres: resolveGenres(show.genre_ids || []),
      source: 'tmdb',
    };
  } catch (err) {
    console.error('[TMDB] TV error:', err.message);
    return null;
  }
}

// ── Smart fetchers (config-aware) ─────────────────────────────────────────────
async function fetchMovieMeta(title, year, config = {}) {
  const source = config.metadataSource || 'auto';
  if (source === 'tmdb' && config.tmdbApiKey) return fetchTMDBMovie(title, year, config);
  if (source === 'omdb') return fetchOMDb(title, year, 'movie', config);
  return await fetchOMDb(title, year, 'movie', config)
      || (config.tmdbApiKey ? fetchTMDBMovie(title, year, config) : null);
}

async function fetchTVMeta(title, config = {}) {
  const source = config.metadataSource || 'auto';
  if (source === 'tmdb' && config.tmdbApiKey) return fetchTMDBTV(title, config);
  if (source === 'tvmaze') return fetchTVmaze(title);
  if (source === 'omdb')   return fetchOMDb(title, null, 'tv', config);
  return await fetchTVmaze(title)
      || await fetchOMDb(title, null, 'tv', config)
      || (config.tmdbApiKey ? fetchTMDBTV(title, config) : null);
}

// ── Music metadata ────────────────────────────────────────────────────────────
async function fetchMusicVideoMeta(filename, config = {}) {
  const { artist, title } = parseMusicVideoFilename(filename);
  if (!artist || !title) return null;
  try {
    const query = encodeURIComponent(`recording:"${title}" AND artist:"${artist}"`);
    const mbRes = await axios.get(`https://musicbrainz.org/ws/2/recording?query=${query}&limit=1&fmt=json`, {
      timeout: 8000, headers: { 'User-Agent': 'Orion/1.0 (https://github.com/rpoltera/Orion)' }
    });
    const recordings = mbRes.data.recordings;
    if (!recordings?.length) return null;
    const rec = recordings[0];
    const artistName = rec['artist-credit']?.[0]?.artist?.name || artist;
    const albumName  = rec.releases?.[0]?.title || null;
    const lfmKey = config.lastfmKey || 'f927d04e8eba8edb5cc57a68aecdb0f8';

    let thumbnail = null;
    if (albumName) {
      try {
        const lfm = await axios.get(`https://ws.audioscrobbler.com/2.0/?method=album.getinfo&api_key=${lfmKey}&artist=${encodeURIComponent(artistName)}&album=${encodeURIComponent(albumName)}&format=json`, { timeout: 5000 });
        const images = lfm.data?.album?.image;
        if (images) {
          const large = images.find(i => i.size === 'extralarge') || images[images.length-1];
          if (large?.['#text'] && !large['#text'].includes('2a96cbd8b46e442fc41c2b86b821562f')) thumbnail = large['#text'];
        }
      } catch {}
    }
    if (!thumbnail) {
      try {
        const itunes = await axios.get(`https://itunes.apple.com/search?term=${encodeURIComponent(`${artistName} ${title}`)}&media=music&limit=1`, { timeout: 5000 });
        const art = itunes.data?.results?.[0]?.artworkUrl100;
        if (art) thumbnail = art.replace('100x100bb', '600x600bb');
      } catch {}
    }

    return { title: rec.title || title, artist: artistName, album: albumName, year: rec['first-release-date'] ? parseInt(rec['first-release-date'].split('-')[0]) : null, mbId: rec.id, thumbnail, overview: `Music video by ${artistName}`, rating: null };
  } catch (err) {
    console.error('[MusicVideo] Metadata error:', err.message);
    return null;
  }
}

async function fetchMusicMeta(filename, config = {}) {
  const { artist, title } = parseMusicVideoFilename(filename);
  if (!title) return null;
  const lfmKey = config.lastfmKey || 'f927d04e8eba8edb5cc57a68aecdb0f8';

  // iTunes first
  try {
    const q = encodeURIComponent(artist ? `${artist} ${title}` : title);
    const res = await axios.get(`https://itunes.apple.com/search?term=${q}&media=music&limit=5&entity=song`, { timeout: 6000 });
    const results = res.data?.results || [];
    const match = results.find(r => r.trackName?.toLowerCase() === title.toLowerCase()) || results.find(r => r.artistName?.toLowerCase() === artist?.toLowerCase()) || results[0];
    if (match) {
      const poster = match.artworkUrl100?.replace('100x100bb', '600x600bb') || null;
      if (poster) return { title: match.trackName || title, artist: match.artistName || artist, album: match.collectionName || null, year: match.releaseDate ? parseInt(match.releaseDate.split('-')[0]) : null, poster };
    }
  } catch {}

  // Last.fm fallback
  let poster = null, foundAlbum = null;
  if (artist) {
    try {
      const trackRes = await axios.get(`https://ws.audioscrobbler.com/2.0/?method=track.getinfo&api_key=${lfmKey}&artist=${encodeURIComponent(artist)}&track=${encodeURIComponent(title)}&format=json`, { timeout: 5000 });
      const album = trackRes.data?.track?.album;
      if (album) {
        foundAlbum = album.title || null;
        const images = album.image;
        const large = images?.find(i => i.size === 'extralarge') || images?.[images?.length-1];
        if (large?.['#text'] && !large['#text'].includes('2a96cbd8b46e442fc41c2b86b821562f')) poster = large['#text'];
      }
    } catch {}
  }

  return { title, artist, album: foundAlbum, year: null, poster };
}

module.exports = {
  axiosPool,
  decodeHtmlEntities,
  resolveGenres,
  parseMusicVideoFilename,
  fetchOMDb,
  fetchTVmaze,
  fetchTMDBMovie,
  fetchTMDBTV,
  fetchMovieMeta,
  fetchTVMeta,
  fetchMusicVideoMeta,
  fetchMusicMeta,
  TMDB_BASE,
  TMDB_IMG,
  TMDB_GENRES,
};

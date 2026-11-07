process.on('uncaughtException', (err) => {
  if (err.code === 'EPIPE') return;
  console.error('Uncaught Exception:', err);
});
process.stdout?.on('error', (err) => { if (err.code === 'EPIPE') return; });
process.stderr?.on('error', (err) => { if (err.code === 'EPIPE') return; });

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const CryptoJS = require('crypto-js');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

// ==========================================
// 1. FILE UPLOAD CONFIGURATION (Multer)
// ==========================================
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const SONGS_DIR = path.join(UPLOADS_DIR, 'songs');
const COVERS_DIR = path.join(UPLOADS_DIR, 'covers');

function initUploadDirs() {
  [UPLOADS_DIR, SONGS_DIR, COVERS_DIR].forEach((dir) => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });
}
initUploadDirs();

// Serve uploaded media
app.use('/uploads', express.static(UPLOADS_DIR));

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    if (file.fieldname === 'audioFile') {
      cb(null, SONGS_DIR);
    } else if (file.fieldname === 'coverFile') {
      cb(null, COVERS_DIR);
    } else {
      cb(null, UPLOADS_DIR);
    }
  },
  filename: function (req, file, cb) {
    const cleanName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
    cb(null, `${Date.now()}_${cleanName}`);
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB limit
});

// ==========================================
// 2. PERSISTENT JSON DATABASE
// ==========================================
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

function initDb() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DB_FILE)) {
    const initialData = { users: [], customSongs: [] };
    fs.writeFileSync(DB_FILE, JSON.stringify(initialData, null, 2), 'utf-8');
  } else {
    // Ensure customSongs array exists in older db.json
    try {
      const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
      if (!Array.isArray(data.customSongs)) {
        data.customSongs = [];
        fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf-8');
      }
    } catch (e) {}
  }
}

function readDb() {
  initDb();
  try {
    const data = fs.readFileSync(DB_FILE, 'utf-8');
    const parsed = JSON.parse(data);
    if (!Array.isArray(parsed.users)) parsed.users = [];
    if (!Array.isArray(parsed.customSongs)) parsed.customSongs = [];
    return parsed;
  } catch (err) {
    console.error('Error reading DB:', err);
    return { users: [], customSongs: [] };
  }
}

function writeDb(data) {
  initDb();
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error('Error writing DB:', err);
  }
}

// ==========================================
// 3. AUDIO DECRYPTION & HELPERS (JioSaavn)
// ==========================================
const JIOSAAVN_DES_KEY = '38346591';

function decryptMediaUrl(encryptedUrl) {
  if (!encryptedUrl) return null;
  try {
    const key = CryptoJS.enc.Utf8.parse(JIOSAAVN_DES_KEY);
    const decrypted = CryptoJS.DES.decrypt(
      { ciphertext: CryptoJS.enc.Base64.parse(encryptedUrl) },
      key,
      { mode: CryptoJS.mode.ECB, padding: CryptoJS.pad.Pkcs7 }
    ).toString(CryptoJS.enc.Utf8);

    if (!decrypted || !decrypted.startsWith('http')) return null;

    // Upgrading to 160kbps for crystal-clear full songs
    let fullQualityUrl = decrypted.replace('_96.mp4', '_160.mp4');
    return fullQualityUrl;
  } catch (err) {
    console.error('Decryption failed for URL:', err.message);
    return null;
  }
}

function decodeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&copy;/g, '©');
}

function formatJioSaavnSong(item, index) {
  const moreInfo = item.more_info || {};
  let streamUrl = decryptMediaUrl(moreInfo.encrypted_media_url);

  // High quality cover image
  let cover = item.image
    ? item.image.replace('150x150', '500x500')
    : 'https://via.placeholder.com/300';

  // Primary artist detection
  let artist = moreInfo.music || item.subtitle || 'Unknown Artist';
  if (
    moreInfo.artistMap &&
    Array.isArray(moreInfo.artistMap.primary_artists) &&
    moreInfo.artistMap.primary_artists.length > 0
  ) {
    artist = moreInfo.artistMap.primary_artists.map((a) => a.name).join(', ');
  }

  return {
    id: item.id || `track-${index}`,
    title: decodeHtml(item.title || item.song),
    artist: decodeHtml(artist),
    cover: cover,
    src: streamUrl,
    duration: parseInt(moreInfo.duration || 0, 10),
    album: decodeHtml(moreInfo.album || ''),
    source: 'jiosaavn'
  };
}

// Fallback search with iTunes (in case JioSaavn is unreachable)
async function fallbackItunesSearch(searchTerm, limit = 16) {
  try {
    const itunesUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(
      searchTerm
    )}&media=music&limit=${limit}`;
    const res = await fetch(itunesUrl);
    const data = await res.json();
    return (data.results || []).map((item, index) => ({
      id: item.trackId || `itunes-${index}`,
      title: item.trackName,
      artist: item.artistName,
      cover: item.artworkUrl100
        ? item.artworkUrl100.replace('100x100bb', '400x400bb')
        : 'https://via.placeholder.com/300',
      src: item.previewUrl,
      duration: Math.round((item.trackTimeMillis || 30000) / 1000),
      album: item.collectionName || '',
      source: 'itunes'
    }));
  } catch (err) {
    console.error('Fallback iTunes API error:', err);
    return [];
  }
}

// Filter matching custom songs
function getMatchingCustomSongs(query) {
  const db = readDb();
  const customSongs = db.customSongs || [];
  if (!query) return customSongs;

  const q = query.toLowerCase().trim();
  const genericQueries = ['top hits', 'bollywood', 'trending', 'home', 'all'];

  // If user searches generic, show all custom songs
  if (genericQueries.some((g) => q.includes(g))) {
    return customSongs;
  }

  return customSongs.filter(
    (s) =>
      (s.title && s.title.toLowerCase().includes(q)) ||
      (s.artist && s.artist.toLowerCase().includes(q)) ||
      (s.album && s.album.toLowerCase().includes(q))
  );
}

// ==========================================
// 4. API ENDPOINTS - MUSIC SEARCH & STREAMING
// ==========================================

// Search songs (Returns custom songs + JioSaavn full-length tracks)
app.get('/api/search', async (req, res) => {
  const query = (req.query.q || req.query.query || 'Bollywood Hits').trim();
  const limit = parseInt(req.query.limit || 20, 10);

  // 1. Get any custom matching songs
  const matchedCustom = getMatchingCustomSongs(query);

  try {
    const saavnUrl = `https://www.jiosaavn.com/api.php?__call=search.getResults&q=${encodeURIComponent(
      query
    )}&_format=json&_marker=0&api_version=4&ctx=web6dot0&n=${limit}&p=1`;

    const response = await fetch(saavnUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'application/json'
      }
    });

    const data = await response.json();

    if (data && Array.isArray(data.results) && data.results.length > 0) {
      const saavnSongs = data.results
        .map((item, idx) => formatJioSaavnSong(item, idx))
        .filter((song) => !!song.src);

      // Prepend custom songs at the top
      const combined = [...matchedCustom, ...saavnSongs];
      return res.json({ success: true, count: combined.length, results: combined });
    }

    // Fallback if no saavn results
    console.log(`No Saavn results for "${query}", falling back to iTunes...`);
    const fallbackResults = await fallbackItunesSearch(query, limit);
    const combined = [...matchedCustom, ...fallbackResults];
    return res.json({
      success: true,
      count: combined.length,
      results: combined,
      notice: 'Fallback results used'
    });
  } catch (err) {
    console.error('Error fetching songs from Saavn:', err.message);
    const fallbackResults = await fallbackItunesSearch(query, limit);
    const combined = [...matchedCustom, ...fallbackResults];
    return res.json({
      success: true,
      count: combined.length,
      results: combined,
      notice: 'Fallback used after error'
    });
  }
});

// Quick suggestions endpoint for live search autocomplete
app.get('/api/suggestions', async (req, res) => {
  const query = (req.query.q || req.query.query || '').trim();
  if (!query) return res.json({ success: true, results: [] });

  const matchedCustom = getMatchingCustomSongs(query).slice(0, 4);

  try {
    const saavnUrl = `https://www.jiosaavn.com/api.php?__call=search.getResults&q=${encodeURIComponent(
      query
    )}&_format=json&_marker=0&api_version=4&ctx=web6dot0&n=6&p=1`;

    const response = await fetch(saavnUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'application/json'
      }
    });

    const data = await response.json();
    if (data && Array.isArray(data.results) && data.results.length > 0) {
      const saavnSongs = data.results
        .map((item, idx) => formatJioSaavnSong(item, idx))
        .filter((song) => !!song.src);

      const combined = [...matchedCustom, ...saavnSongs].slice(0, 6);
      return res.json({ success: true, results: combined });
    }

    const fallback = await fallbackItunesSearch(query, 6);
    const combined = [...matchedCustom, ...fallback].slice(0, 6);
    return res.json({ success: true, results: combined });
  } catch (err) {
    const fallback = await fallbackItunesSearch(query, 6);
    const combined = [...matchedCustom, ...fallback].slice(0, 6);
    return res.json({ success: true, results: combined });
  }
});

// Trending hits endpoint
app.get('/api/trending', async (req, res) => {
  const db = readDb();
  const customSongs = db.customSongs || [];

  try {
    const saavnUrl = `https://www.jiosaavn.com/api.php?__call=search.getResults&q=Trending%20Songs%202026&_format=json&_marker=0&api_version=4&ctx=web6dot0&n=20&p=1`;
    const response = await fetch(saavnUrl);
    const data = await response.json();

    if (data && Array.isArray(data.results)) {
      const saavnSongs = data.results
        .map((item, idx) => formatJioSaavnSong(item, idx))
        .filter((song) => !!song.src);

      const combined = [...customSongs, ...saavnSongs];
      return res.json({ success: true, count: combined.length, results: combined });
    }

    const fallback = await fallbackItunesSearch('Trending Hits', 16);
    const combined = [...customSongs, ...fallback];
    res.json({ success: true, count: combined.length, results: combined });
  } catch (err) {
    console.error('Trending fetch error:', err);
    const fallback = await fallbackItunesSearch('Trending Hits', 16);
    const combined = [...customSongs, ...fallback];
    res.json({ success: true, count: combined.length, results: combined });
  }
});

// Proxy streaming endpoint for full CORS and Web Audio compatibility
app.get('/api/stream', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send('Missing url parameter');

  try {
    const range = req.headers.range;
    const fetchHeaders = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Referer: 'https://www.jiosaavn.com/'
    };
    if (range) {
      fetchHeaders['Range'] = range;
    }

    const response = await fetch(targetUrl, { headers: fetchHeaders });
    if (!response.ok && response.status !== 206) {
      return res.status(response.status).send('Upstream stream error');
    }

    res.status(response.status);
    ['content-type', 'content-length', 'content-range', 'accept-ranges'].forEach((header) => {
      const val = response.headers.get(header);
      if (val) res.setHeader(header, val);
    });
    res.setHeader('Access-Control-Allow-Origin', '*');

    const { Readable } = require('stream');
    Readable.fromWeb(response.body).pipe(res);
  } catch (err) {
    console.error('Stream proxy error:', err.message);
    if (!res.headersSent) {
      res.redirect(targetUrl);
    }
  }
});

// Download proxy endpoint (Saves clean audio file with proper name)
app.get('/api/download', async (req, res) => {
  const targetUrl = req.query.url;
  const rawName = (req.query.name || 'track').replace(/[^a-zA-Z0-9 _.-]/g, '_');
  if (!targetUrl) return res.status(400).send('Missing url parameter');

  try {
    if (targetUrl.startsWith('/uploads/')) {
      const localPath = path.join(__dirname, targetUrl);
      if (fs.existsSync(localPath)) {
        return res.download(localPath, `${rawName}.mp3`);
      }
    }

    const response = await fetch(targetUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Referer: 'https://www.jiosaavn.com/'
      }
    });

    res.setHeader('Content-Disposition', `attachment; filename="${rawName}.mp3"`);
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Access-Control-Allow-Origin', '*');

    const { Readable } = require('stream');
    Readable.fromWeb(response.body).pipe(res);
  } catch (err) {
    console.error('Download error:', err.message);
    res.redirect(targetUrl);
  }
});

// ==========================================
// 5. ADMIN AUTH & SONG MANAGEMENT (ADD & DELETE)
// ==========================================

const DEFAULT_ADMIN = {
  email: 'admin@music.com',
  password: 'admin123'
};

// Admin Login
app.post('/api/admin/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const db = readDb();
  const adminEmail = (db.admin && db.admin.email) || DEFAULT_ADMIN.email;
  const adminPassword = (db.admin && db.admin.password) || DEFAULT_ADMIN.password;

  if (
    email.trim().toLowerCase() === adminEmail.toLowerCase() &&
    password === adminPassword
  ) {
    return res.json({
      success: true,
      message: 'Admin authenticated successfully',
      admin: { email: adminEmail }
    });
  }

  return res.status(401).json({ error: 'Invalid admin email or password' });
});

// Get all custom songs
app.get('/api/admin/songs', (req, res) => {
  const db = readDb();
  return res.json({
    success: true,
    count: db.customSongs.length,
    songs: db.customSongs
  });
});

// Add a new song (Supports file upload or direct URL)
app.post(
  '/api/admin/songs',
  upload.fields([
    { name: 'audioFile', maxCount: 1 },
    { name: 'coverFile', maxCount: 1 }
  ]),
  (req, res) => {
    try {
      const { title, artist, album, audioUrl, coverUrl, duration } = req.body;

      if (!title || !title.trim()) {
        return res.status(400).json({ error: 'Song title is required' });
      }

      // Determine audio source
      let src = '';
      if (req.files && req.files.audioFile && req.files.audioFile.length > 0) {
        src = `/uploads/songs/${req.files.audioFile[0].filename}`;
      } else if (audioUrl && audioUrl.trim()) {
        src = audioUrl.trim();
      } else {
        return res
          .status(400)
          .json({ error: 'Please either upload an audio file or provide an audio URL' });
      }

      // Determine cover image
      let cover = 'https://via.placeholder.com/300';
      if (req.files && req.files.coverFile && req.files.coverFile.length > 0) {
        cover = `/uploads/covers/${req.files.coverFile[0].filename}`;
      } else if (coverUrl && coverUrl.trim()) {
        cover = coverUrl.trim();
      }

      const db = readDb();
      const newSong = {
        id: 'custom_' + Date.now(),
        title: title.trim(),
        artist: (artist || 'Unknown Artist').trim(),
        album: (album || 'Single').trim(),
        src: src,
        cover: cover,
        duration: parseInt(duration || 0, 10),
        source: 'custom',
        createdAt: new Date().toISOString()
      };

      db.customSongs.unshift(newSong);
      writeDb(db);

      console.log(`[ADMIN] Added new song: "${newSong.title}" by ${newSong.artist}`);
      return res.json({
        success: true,
        message: 'Song added successfully!',
        song: newSong
      });
    } catch (err) {
      console.error('Error adding song:', err);
      return res.status(500).json({ error: 'Failed to add song: ' + err.message });
    }
  }
);

// Delete song by ID
app.delete('/api/admin/songs/:id', (req, res) => {
  const songId = req.params.id;
  if (!songId) {
    return res.status(400).json({ error: 'Song ID is required' });
  }

  const db = readDb();
  const songIndex = db.customSongs.findIndex((s) => s.id === songId);

  if (songIndex === -1) {
    return res.status(404).json({ error: 'Song not found' });
  }

  const [deletedSong] = db.customSongs.splice(songIndex, 1);

  // If local file was uploaded, safely remove from disk
  if (deletedSong.src && deletedSong.src.startsWith('/uploads/')) {
    const fullAudioPath = path.join(__dirname, deletedSong.src);
    if (fs.existsSync(fullAudioPath)) {
      try {
        fs.unlinkSync(fullAudioPath);
      } catch (e) {
        console.error('Error removing audio file:', e);
      }
    }
  }

  if (deletedSong.cover && deletedSong.cover.startsWith('/uploads/')) {
    const fullCoverPath = path.join(__dirname, deletedSong.cover);
    if (fs.existsSync(fullCoverPath)) {
      try {
        fs.unlinkSync(fullCoverPath);
      } catch (e) {
        console.error('Error removing cover file:', e);
      }
    }
  }

  writeDb(db);
  console.log(`[ADMIN] Deleted song: "${deletedSong.title}" (ID: ${songId})`);

  return res.json({
    success: true,
    message: `Song "${deletedSong.title}" deleted successfully`,
    deletedId: songId
  });
});

// ==========================================
// 6. AUTH & USER DATA ENDPOINTS
// ==========================================

// Sign Up
app.post('/api/auth/signup', (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) {
    return res.status(400).json({ error: 'Username, email and password are required' });
  }

  const db = readDb();
  const existingUser = db.users.find((u) => u.email.toLowerCase() === email.toLowerCase());
  if (existingUser) {
    return res.status(409).json({ error: 'User with this email already exists' });
  }

  const newUser = {
    id: 'user_' + Date.now(),
    username,
    email: email.toLowerCase(),
    password,
    likedSongs: [],
    library: [],
    createdAt: new Date().toISOString()
  };

  db.users.push(newUser);
  writeDb(db);

  return res.json({
    success: true,
    message: 'Account created successfully',
    user: { id: newUser.id, username: newUser.username, email: newUser.email }
  });
});

// Log In
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const db = readDb();
  const user = db.users.find(
    (u) => u.email.toLowerCase() === email.toLowerCase() && u.password === password
  );

  if (!user) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  return res.json({
    success: true,
    message: 'Logged in successfully',
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      likedSongs: user.likedSongs || [],
      library: user.library || []
    }
  });
});

// Get User Profile & Saved Playlists
app.get('/api/user/data', (req, res) => {
  const email = req.query.email;
  if (!email) {
    return res.status(400).json({ error: 'Email query parameter required' });
  }

  const db = readDb();
  const user = db.users.find((u) => u.email.toLowerCase() === email.toLowerCase());
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  return res.json({
    success: true,
    user: {
      username: user.username,
      email: user.email,
      likedSongs: user.likedSongs || [],
      library: user.library || []
    }
  });
});

// Toggle Liked Song
app.post('/api/user/liked', (req, res) => {
  const { email, track } = req.body;
  if (!email || !track || !track.src) {
    return res.status(400).json({ error: 'Email and track details required' });
  }

  const db = readDb();
  const user = db.users.find((u) => u.email.toLowerCase() === email.toLowerCase());
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  if (!user.likedSongs) user.likedSongs = [];

  const existingIndex = user.likedSongs.findIndex((s) => s.src === track.src);
  let isLiked = false;

  if (existingIndex > -1) {
    user.likedSongs.splice(existingIndex, 1);
    isLiked = false;
  } else {
    user.likedSongs.unshift(track);
    isLiked = true;
  }

  writeDb(db);
  return res.json({ success: true, isLiked, likedSongs: user.likedSongs });
});

// Add to Library (History)
app.post('/api/user/library', (req, res) => {
  const { email, track } = req.body;
  if (!email || !track || !track.src) {
    return res.status(400).json({ error: 'Email and track details required' });
  }

  const db = readDb();
  const user = db.users.find((u) => u.email.toLowerCase() === email.toLowerCase());
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  if (!user.library) user.library = [];

  user.library = user.library.filter((s) => s.src !== track.src);
  user.library.unshift(track);
  if (user.library.length > 30) user.library.pop();

  writeDb(db);
  return res.json({ success: true, library: user.library });
});

// ==========================================
// 6.1 CUSTOM USER PLAYLISTS
// ==========================================

// Get user playlists
app.get('/api/user/playlists', (req, res) => {
  const email = req.query.email;
  const db = readDb();
  if (email) {
    const user = db.users.find((u) => u.email.toLowerCase() === email.toLowerCase());
    return res.json({ success: true, playlists: (user && user.playlists) || [] });
  }
  // If guest, store in a guest array or return empty
  return res.json({ success: true, playlists: [] });
});

// Create new playlist
app.post('/api/user/playlists', (req, res) => {
  const { email, name } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Playlist name is required' });
  }

  const db = readDb();
  const newPlaylist = {
    id: 'pl_' + Date.now(),
    name: name.trim(),
    songs: [],
    createdAt: new Date().toISOString()
  };

  if (email) {
    const user = db.users.find((u) => u.email.toLowerCase() === email.toLowerCase());
    if (user) {
      if (!user.playlists) user.playlists = [];
      user.playlists.push(newPlaylist);
      writeDb(db);
      return res.json({ success: true, playlist: newPlaylist, playlists: user.playlists });
    }
  }

  return res.json({ success: true, playlist: newPlaylist });
});

// Add song to playlist
app.post('/api/user/playlists/add-song', (req, res) => {
  const { email, playlistId, track } = req.body;
  if (!playlistId || !track) {
    return res.status(400).json({ error: 'Playlist ID and track are required' });
  }

  const db = readDb();
  if (email) {
    const user = db.users.find((u) => u.email.toLowerCase() === email.toLowerCase());
    if (user && user.playlists) {
      const pl = user.playlists.find((p) => p.id === playlistId);
      if (pl) {
        if (!pl.songs.some((s) => s.src === track.src)) {
          pl.songs.push(track);
          writeDb(db);
        }
        return res.json({ success: true, playlist: pl, playlists: user.playlists });
      }
    }
  }

  return res.json({ success: true, message: 'Added to playlist' });
});

// Delete playlist
app.delete('/api/user/playlists/:playlistId', (req, res) => {
  const playlistId = req.params.playlistId;
  const email = req.query.email;

  const db = readDb();
  if (email) {
    const user = db.users.find((u) => u.email.toLowerCase() === email.toLowerCase());
    if (user && user.playlists) {
      user.playlists = user.playlists.filter((p) => p.id !== playlistId);
      writeDb(db);
      return res.json({ success: true, playlists: user.playlists });
    }
  }

  return res.json({ success: true, message: 'Playlist deleted' });
});

// Remove song from playlist
app.delete('/api/user/playlists/:playlistId/song/:songId', (req, res) => {
  const { playlistId, songId } = req.params;
  const email = req.query.email;

  const db = readDb();
  if (email) {
    const user = db.users.find((u) => u.email.toLowerCase() === email.toLowerCase());
    if (user && user.playlists) {
      const pl = user.playlists.find((p) => p.id === playlistId);
      if (pl) {
        pl.songs = pl.songs.filter((s) => String(s.id) !== String(songId));
        writeDb(db);
        return res.json({ success: true, playlist: pl });
      }
    }
  }

  return res.json({ success: true, message: 'Song removed from playlist' });
});

// ==========================================
// 7. SERVER STARTUP
// ==========================================
initDb();

const server = app.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`🎵 Music Streaming Server running at: http://localhost:${PORT}`);
  console.log(`🚀 Serving Full-length songs (No 30-second restriction)`);
  console.log(`🛠️ Admin API Ready: Add & Delete custom tracks enabled`);
  console.log(`====================================================`);
});

server.on('error', (err) => {
  console.error('Server error:', err);
});

// Keep event loop alive
setInterval(() => {}, 1000 * 60 * 60);

// ==========================================
// CONFIGURATION & GLOBAL STATE MANAGER
// ==========================================
const API_BASE = window.location.protocol.startsWith('http')
  ? window.location.origin
  : 'http://localhost:3000';

// Storage Keys
const USERS_KEY = 'Spotify_users';
const CURRENT_USER_KEY = 'Spotify_current_user';
const LIKED_SONGS_KEY = 'Spotify_liked_songs';
const LIBRARY_KEY = 'Spotify_library_songs';
const PLAYLISTS_KEY = 'Spotify_user_playlists';
const PLAYER_STATE_STORAGE_KEY = 'spotify_global_player_state';

// Centralized Music Player Global Store Class
class MusicPlayerStore {
  constructor() {
    this.subscribers = new Set();
    this.state = this.loadPersistedState();
  }

  getDefaultState() {
    return {
      trackList: [],
      currentTrackIndex: 0,
      currentTrack: null,
      isPlaying: false,
      currentTime: 0,
      duration: 0,
      volume: 0.8,
      isShuffle: false,
      repeatMode: 0, // 0 = Off, 1 = Repeat All, 2 = Repeat One
      playbackSpeed: 1.0,
      is8DActive: false
    };
  }

  loadPersistedState() {
    try {
      const raw = localStorage.getItem(PLAYER_STATE_STORAGE_KEY);
      if (!raw) return this.getDefaultState();
      const parsed = JSON.parse(raw);
      return {
        ...this.getDefaultState(),
        ...parsed,
        isPlaying: false // always start unpaused on initial load
      };
    } catch (e) {
      return this.getDefaultState();
    }
  }

  getState() {
    return this.state;
  }

  setState(partial, options = { persist: true, notify: true }) {
    const prevState = { ...this.state };
    this.state = { ...this.state, ...partial };

    if (options.persist !== false) {
      this.persist();
    }

    if (options.notify !== false) {
      this.notify(this.state, prevState);
    }
  }

  persist() {
    try {
      const toSave = {
        trackList: Array.isArray(this.state.trackList) ? this.state.trackList.slice(0, 50) : [],
        currentTrackIndex: this.state.currentTrackIndex,
        currentTrack: this.state.currentTrack,
        currentTime: this.state.currentTime,
        duration: this.state.duration,
        volume: this.state.volume,
        isShuffle: this.state.isShuffle,
        repeatMode: this.state.repeatMode,
        playbackSpeed: this.state.playbackSpeed,
        is8DActive: this.state.is8DActive
      };
      localStorage.setItem(PLAYER_STATE_STORAGE_KEY, JSON.stringify(toSave));
    } catch (e) {}
  }

  subscribe(listener) {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  notify(currentState, prevState) {
    for (const listener of this.subscribers) {
      try {
        listener(currentState, prevState);
      } catch (err) {
        console.error("Store listener error:", err);
      }
    }
  }
}

const playerStore = new MusicPlayerStore();
window.playerStore = playerStore;

// State Variables synced with global store
let trackList = playerStore.state.trackList || [];
let currentTrackIndex = playerStore.state.currentTrackIndex || 0;
let isPlaying = false;
let isShuffle = !!playerStore.state.isShuffle;
let repeatMode = playerStore.state.repeatMode || 0;
let currentPlaybackSpeed = playerStore.state.playbackSpeed || 1.0;
let userPlaylists = [];
let pendingAddToPlaylistTrack = null;

const audio = new Audio();
// Native HTML5 audio: no crossOrigin enforcement so remote CDN streams play without CORS zeroing

playerStore.subscribe((state) => {
  if (Array.isArray(state.trackList) && state.trackList.length > 0) {
    trackList = state.trackList;
  }
  currentTrackIndex = state.currentTrackIndex;
  isPlaying = state.isPlaying;
  isShuffle = state.isShuffle;
  repeatMode = state.repeatMode;
  currentPlaybackSpeed = state.playbackSpeed;
});

// ==========================================
// WEB AUDIO API GRAPH (8D Audio, Visualizer, Equalizer)
// ==========================================
let audioCtx = null;
let sourceNode = null;
let pannerNode = null;
let eqFilters = [];
let is8DActive = false;
let panAngle = 0;
let panAnimationId = null;

// Sleep Timer State
let sleepTimerInterval = null;
let sleepRemainingSeconds = 0;
let originalVolumeBeforeFade = 0.8;

// Ambient Sound Synthesizers
let ambientCtx = null;
const ambientNodes = {
  rain: { isPlaying: false, gainNode: null, sourceNode: null },
  fire: { isPlaying: false, gainNode: null, sourceNode: null },
  cafe: { isPlaying: false, gainNode: null, sourceNode: null }
};

// ==========================================
// DOM ELEMENTS
// ==========================================
const navHome = document.getElementById('nav-home');
const navDiscover = document.getElementById('nav-discover');
const navLibrary = document.getElementById('nav-library');
const navLiked = document.getElementById('nav-liked');
const navTrending = document.getElementById('nav-trending');
const navCustom = document.getElementById('nav-custom');

const trackGrid = document.getElementById('track-grid');
const searchInput = document.getElementById('search-input');
const searchBtn = document.getElementById('search-btn');
const voiceSearchBtn = document.getElementById('voice-search-btn');
const searchSuggestions = document.getElementById('search-suggestions');
const sectionTitle = document.getElementById('section-title');
const moodChips = document.querySelectorAll('.mood-chip');

const playBtn = document.getElementById('play-btn');
const prevBtn = document.getElementById('prev-btn');
const nextBtn = document.getElementById('next-btn');
const shuffleBtn = document.getElementById('shuffle-btn');
const repeatBtn = document.getElementById('repeat-btn');
const repeatBadge = document.getElementById('repeat-badge');
const progressBar = document.getElementById('progress-bar');
const volumeBar = document.getElementById('volume-bar');
const trackTitle = document.getElementById('track-title');
const trackArtist = document.getElementById('track-artist');
const coverArt = document.getElementById('cover-art');
const currentTimeEl = document.getElementById('current-time');
const totalTimeEl = document.getElementById('total-time');
const visualizerCanvas = document.getElementById('visualizer-canvas');
const speedBtn = document.getElementById('speed-btn');
const queueBtn = document.getElementById('queue-btn');
const downloadCurrentBtn = document.getElementById('download-current-btn');
const shareCurrentBtn = document.getElementById('share-current-btn');

// Standout feature buttons
const eightDBtn = document.getElementById('eight-d-btn');
const openAmbientBtn = document.getElementById('open-ambient-btn');
const eqBtn = document.getElementById('eq-btn');
const sleepTimerBtn = document.getElementById('sleep-timer-btn');

// Modals
const authModal = document.getElementById('auth-modal');
const openLoginBtn = document.getElementById('open-login-btn');
const openSignupBtn = document.getElementById('open-signup-btn');
const closeModalBtn = document.getElementById('close-modal-btn');
const signupForm = document.getElementById('signup-form');
const loginForm = document.getElementById('login-form');
const switchToLogin = document.getElementById('switch-to-login');
const switchToSignup = document.getElementById('switch-to-signup');
const authButtons = document.getElementById('auth-buttons');
const userProfile = document.getElementById('user-profile');
const userDisplayName = document.getElementById('user-display-name');
const logoutBtn = document.getElementById('logout-btn');

// Playlists & Queue Modals
const createPlaylistBtn = document.getElementById('create-playlist-btn');
const createPlaylistModal = document.getElementById('create-playlist-modal');
const closePlaylistModalBtn = document.getElementById('close-playlist-modal-btn');
const createPlaylistForm = document.getElementById('create-playlist-form');
const newPlaylistNameInput = document.getElementById('new-playlist-name');
const userPlaylistsList = document.getElementById('user-playlists-list');

const addToPlaylistModal = document.getElementById('add-to-playlist-modal');
const closeAddPlaylistBtn = document.getElementById('close-add-playlist-btn');
const addPlaylistSongTitle = document.getElementById('add-playlist-song-title');
const targetPlaylistsList = document.getElementById('target-playlists-list');

const queueModal = document.getElementById('queue-modal');
const closeQueueBtn = document.getElementById('close-queue-btn');
const queueNowPlaying = document.getElementById('queue-now-playing');
const queueList = document.getElementById('queue-list');

// Ambient Modal
const ambientModal = document.getElementById('ambient-modal');
const closeAmbientBtn = document.getElementById('close-ambient-btn');
const btnToggleRain = document.getElementById('btn-toggle-rain');
const sliderRain = document.getElementById('slider-rain');
const cardAmbientRain = document.getElementById('card-ambient-rain');
const btnToggleFire = document.getElementById('btn-toggle-fire');
const sliderFire = document.getElementById('slider-fire');
const cardAmbientFire = document.getElementById('card-ambient-fire');
const btnToggleCafe = document.getElementById('btn-toggle-cafe');
const sliderCafe = document.getElementById('slider-cafe');
const cardAmbientCafe = document.getElementById('card-ambient-cafe');

// Equalizer Modal
const eqModal = document.getElementById('eq-modal');
const closeEqBtn = document.getElementById('close-eq-btn');
const eqPresetBtns = document.querySelectorAll('.eq-preset-btn');
const eqBands = [
  { id: 'eq-band-60', freq: 60, type: 'lowshelf', label: 'label-eq-60' },
  { id: 'eq-band-250', freq: 250, type: 'peaking', label: 'label-eq-250' },
  { id: 'eq-band-1k', freq: 1000, type: 'peaking', label: 'label-eq-1k' },
  { id: 'eq-band-4k', freq: 4000, type: 'peaking', label: 'label-eq-4k' },
  { id: 'eq-band-14k', freq: 14000, type: 'highshelf', label: 'label-eq-14k' }
];

// Sleep Timer Modal
const sleepTimerModal = document.getElementById('sleep-timer-modal');
const closeSleepBtn = document.getElementById('close-sleep-btn');
const sleepStatusBox = document.getElementById('sleep-status-box');
const sleepChips = document.querySelectorAll('.sleep-chip[data-min]');
const btnTurnOffTimer = document.getElementById('btn-turn-off-timer');
const themeSelect = document.getElementById('theme-select');

const THEME_STORAGE_KEY = 'Spotify_color_theme';
const availableThemes = ['normal', 'dark', 'light'];
const savedTheme = localStorage.getItem(THEME_STORAGE_KEY);
const initialTheme = availableThemes.includes(savedTheme) ? savedTheme : 'normal';

document.body.dataset.theme = initialTheme;
themeSelect.value = initialTheme;
themeSelect.addEventListener('change', () => {
  const selectedTheme = themeSelect.value;
  if (!availableThemes.includes(selectedTheme)) return;
  document.body.dataset.theme = selectedTheme;
  localStorage.setItem(THEME_STORAGE_KEY, selectedTheme);
});

// ==========================================
// 1. NAVIGATION & MENU LOGIC
// ==========================================

const bnavHome = document.getElementById('bnav-home');
const bnavSearch = document.getElementById('bnav-search');
const bnavLiked = document.getElementById('bnav-liked');
const bnavLibrary = document.getElementById('bnav-library');

function updateBottomNavActive(activeBtn) {
  document.querySelectorAll('.bottom-nav-item').forEach(b => b.classList.remove('active'));
  if (activeBtn) activeBtn.classList.add('active');
}

function updateActiveNav(activeElement) {
  if (typeof closeArtistProfile === 'function') closeArtistProfile();
  const navLinks = document.querySelectorAll('.nav-menu a, .playlists li');
  navLinks.forEach(link => link.classList.remove('active'));
  if (activeElement) activeElement.classList.add('active');

  // Sync mobile bottom nav
  if (activeElement === navHome && bnavHome) updateBottomNavActive(bnavHome);
  else if (activeElement === navLiked && bnavLiked) updateBottomNavActive(bnavLiked);
  else if (activeElement === navLibrary && bnavLibrary) updateBottomNavActive(bnavLibrary);
}

if (bnavHome) {
  bnavHome.addEventListener('click', () => {
    updateBottomNavActive(bnavHome);
    navHome.click();
  });
}
if (bnavSearch) {
  bnavSearch.addEventListener('click', () => {
    updateBottomNavActive(bnavSearch);
    if (typeof closeArtistProfile === 'function') closeArtistProfile();
    const searchInput = document.getElementById('search-input');
    if (searchInput) {
      searchInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(() => searchInput.focus(), 300);
    }
  });
}
if (bnavLiked) {
  bnavLiked.addEventListener('click', () => {
    updateBottomNavActive(bnavLiked);
    navLiked.click();
  });
}
if (bnavLibrary) {
  bnavLibrary.addEventListener('click', () => {
    updateBottomNavActive(bnavLibrary);
    navLibrary.click();
  });
}

navHome.addEventListener('click', (e) => {
  e.preventDefault();
  updateActiveNav(navHome);
  sectionTitle.innerText = "Home - Top Hits";
  fetchOnlineSongs("Top Hits");
});

navDiscover.addEventListener('click', (e) => {
  e.preventDefault();
  updateActiveNav(navDiscover);
  const discoverQueries = ["New Releases", "Global Top 50", "Indie Pop", "Arijit Singh", "Bollywood Romance", "EDM Dance"];
  const randomQuery = discoverQueries[Math.floor(Math.random() * discoverQueries.length)];
  sectionTitle.innerText = `Discover - ${randomQuery}`;
  fetchOnlineSongs(randomQuery);
});

navLibrary.addEventListener('click', (e) => {
  e.preventDefault();
  updateActiveNav(navLibrary);
  sectionTitle.innerText = "Your Library";
  const librarySongs = getLibrarySongs();
  
  if (librarySongs.length === 0) {
    trackGrid.innerHTML = '<p style="color: #b3b3b3; grid-column: 1/-1; text-align: center; padding: 40px 0;">Your library is empty. Play songs to add them to your recently played history!</p>';
    return;
  }
  trackList = librarySongs;
  renderTracks();
});

navLiked.addEventListener('click', (e) => {
  if (e) e.preventDefault();
  updateActiveNav(navLiked);
  sectionTitle.innerText = "Liked Songs";
  const likedSongs = getLikedSongs();

  if (likedSongs.length === 0) {
    trackGrid.innerHTML = '<p style="color: #b3b3b3; grid-column: 1/-1; text-align: center; padding: 40px 0;">No liked songs yet! Click the heart icon on any track to save it here.</p>';
    return;
  }
  trackList = likedSongs;
  renderTracks();
});

navTrending.addEventListener('click', (e) => {
  if (e) e.preventDefault();
  updateActiveNav(navTrending);
  sectionTitle.innerText = "Top Trending Charts";
  fetchTrendingSongs();
});

if (navCustom) {
  navCustom.addEventListener('click', (e) => {
    if (e) e.preventDefault();
    updateActiveNav(navCustom);
    sectionTitle.innerText = "Featured Hits";
    fetchCustomSongs();
  });
}

moodChips.forEach(chip => {
  chip.addEventListener('click', () => {
    if (typeof closeArtistProfile === 'function') closeArtistProfile();
    moodChips.forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    const query = chip.dataset.query;
    sectionTitle.innerText = chip.innerText.trim();
    fetchOnlineSongs(query);
  });
});

function getLibrarySongs() {
  return JSON.parse(localStorage.getItem(LIBRARY_KEY)) || [];
}

async function addToLibrary(track) {
  let librarySongs = getLibrarySongs();
  librarySongs = librarySongs.filter(item => item.src !== track.src);
  librarySongs.unshift(track);
  if (librarySongs.length > 30) librarySongs.pop();
  localStorage.setItem(LIBRARY_KEY, JSON.stringify(librarySongs));

  const currentUser = getCurrentUser();
  if (currentUser && currentUser.email) {
    try {
      await fetch(`${API_BASE}/api/user/library`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: currentUser.email, track })
      });
    } catch (e) {}
  }
}

// ==========================================
// 2. USER AUTHENTICATION LOGIC
// ==========================================

function getCurrentUser() {
  return JSON.parse(localStorage.getItem(CURRENT_USER_KEY));
}

function checkAuthState() {
  const currentUser = getCurrentUser();
  if (currentUser) {
    authButtons.classList.add('hidden');
    userProfile.classList.remove('hidden');
    userDisplayName.innerHTML = `<i class="fa-solid fa-user"></i> ${currentUser.username}`;
    loadUserPlaylists();
  } else {
    authButtons.classList.remove('hidden');
    userProfile.classList.add('hidden');
    loadUserPlaylists();
  }
}

openLoginBtn.addEventListener('click', (e) => {
  if (e) { e.preventDefault(); e.stopPropagation(); }
  authModal.classList.remove('hidden');
  loginForm.classList.remove('hidden');
  signupForm.classList.add('hidden');
});

openSignupBtn.addEventListener('click', (e) => {
  if (e) { e.preventDefault(); e.stopPropagation(); }
  authModal.classList.remove('hidden');
  signupForm.classList.remove('hidden');
  loginForm.classList.add('hidden');
});

closeModalBtn.addEventListener('click', (e) => {
  if (e) { e.preventDefault(); e.stopPropagation(); }
  authModal.classList.add('hidden');
});

switchToLogin.addEventListener('click', (e) => {
  e.preventDefault();
  signupForm.classList.add('hidden');
  loginForm.classList.remove('hidden');
});

switchToSignup.addEventListener('click', (e) => {
  e.preventDefault();
  loginForm.classList.add('hidden');
  signupForm.classList.remove('hidden');
});

signupForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('signup-username').value.trim();
  const email = document.getElementById('signup-email').value.trim();
  const password = document.getElementById('signup-password').value;

  try {
    const res = await fetch(`${API_BASE}/api/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, email, password })
    });
    const data = await res.json();

    if (!res.ok) {
      showToast(data.error || 'Failed to create account.', 'error');
      return;
    }

    localStorage.setItem(CURRENT_USER_KEY, JSON.stringify(data.user));
    checkAuthState();
    authModal.classList.add('hidden');
    signupForm.reset();
    showToast('Account created successfully! 🎉', 'success');
  } catch (err) {
    let users = JSON.parse(localStorage.getItem(USERS_KEY)) || [];
    if (users.some(u => u.email === email)) {
      showToast('User with this email already exists!', 'error');
      return;
    }
    users.push({ username, email, password });
    localStorage.setItem(USERS_KEY, JSON.stringify(users));
    localStorage.setItem(CURRENT_USER_KEY, JSON.stringify({ username, email }));
    checkAuthState();
    authModal.classList.add('hidden');
    signupForm.reset();
    showToast('Account created successfully! 🎉', 'success');
  }
});

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;

  try {
    const res = await fetch(`${API_BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();

    if (!res.ok) {
      showToast(data.error || 'Invalid email or password!', 'error');
      return;
    }

    localStorage.setItem(CURRENT_USER_KEY, JSON.stringify(data.user));
    if (data.user.likedSongs) {
      localStorage.setItem(LIKED_SONGS_KEY, JSON.stringify(data.user.likedSongs));
    }
    if (data.user.library) {
      localStorage.setItem(LIBRARY_KEY, JSON.stringify(data.user.library));
    }

    checkAuthState();
    authModal.classList.add('hidden');
    loginForm.reset();
    renderTracks();
    showToast(`Welcome back, ${data.user.username || 'User'}! 👋`, 'success');
  } catch (err) {
    let users = JSON.parse(localStorage.getItem(USERS_KEY)) || [];
    const user = users.find(u => u.email === email && u.password === password);
    if (user) {
      localStorage.setItem(CURRENT_USER_KEY, JSON.stringify({ username: user.username, email: user.email }));
      checkAuthState();
      authModal.classList.add('hidden');
      loginForm.reset();
      showToast(`Welcome back, ${user.username}! 👋`, 'success');
    } else {
      showToast('Invalid email or password!', 'error');
    }
  }
});

logoutBtn.addEventListener('click', () => {
  localStorage.removeItem(CURRENT_USER_KEY);
  checkAuthState();
});

// ==========================================
// 3. LIKED SONGS & STORAGE LOGIC
// ==========================================

function getLikedSongs() {
  return JSON.parse(localStorage.getItem(LIKED_SONGS_KEY)) || [];
}

async function toggleLikeSong(track, heartIcon) {
  let likedSongs = getLikedSongs();
  const index = likedSongs.findIndex(s => s.src === track.src);

  if (index > -1) {
    likedSongs.splice(index, 1);
    heartIcon.classList.remove('fa-solid', 'active-heart');
    heartIcon.classList.add('fa-regular');
    showToast(`Removed "${track.title}" from Liked Songs`, 'info');
  } else {
    likedSongs.unshift(track);
    heartIcon.classList.remove('fa-regular');
    heartIcon.classList.add('fa-solid', 'active-heart');
    showToast(`Added to Liked Songs ❤️`, 'heart');
  }

  localStorage.setItem(LIKED_SONGS_KEY, JSON.stringify(likedSongs));

  if (sectionTitle.innerText.includes("Liked Songs")) {
    trackList = likedSongs;
    renderTracks();
  }

  const currentUser = getCurrentUser();
  if (currentUser && currentUser.email) {
    try {
      await fetch(`${API_BASE}/api/user/liked`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: currentUser.email, track })
      });
    } catch (e) {}
  }
}

// ==========================================
// 4. MUSIC STREAMING & BACKEND PLAYER LOGIC
// ==========================================

async function fetchOnlineSongs(searchTerm = "Bollywood Hits") {
  trackGrid.innerHTML = `
    <div style="grid-column: 1/-1; text-align: center; padding: 40px 0; color: #b3b3b3;">
      <i class="fa-solid fa-spinner fa-spin" style="font-size: 2rem; margin-bottom: 10px; display: block; color: #1db954;"></i>
      Loading full tracks...
    </div>
  `;

  try {
    const backendRes = await fetch(`${API_BASE}/api/search?q=${encodeURIComponent(searchTerm)}&limit=20`);
    if (backendRes.ok) {
      const data = await backendRes.json();
      if (data && data.results && data.results.length > 0) {
        trackList = data.results;
        renderTracks();
        loadFirstTrackIfEmpty();
        return;
      }
    }
    throw new Error("Backend search returned empty");
  } catch (error) {
    console.warn("Backend error, falling back to iTunes:", error);
    try {
      const itunesRes = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(searchTerm)}&media=music&limit=16`);
      const data = await itunesRes.json();

      if (!data.results || data.results.length === 0) {
        trackGrid.innerHTML = '<p style="color: #b3b3b3; grid-column: 1/-1; text-align: center; padding: 40px 0;">No tracks found. Try another search!</p>';
        return;
      }

      trackList = data.results.map((item, index) => ({
        id: index,
        title: item.trackName,
        artist: item.artistName,
        cover: item.artworkUrl100 ? item.artworkUrl100.replace('100x100bb', '300x300bb') : 'https://via.placeholder.com/300',
        src: item.previewUrl
      }));

      renderTracks();
      loadFirstTrackIfEmpty();
    } catch (e) {
      trackGrid.innerHTML = '<p style="color: #ff5555; grid-column: 1/-1; text-align: center; padding: 40px 0;">Error fetching songs. Please start the backend server.</p>';
    }
  }
}

async function fetchTrendingSongs() {
  trackGrid.innerHTML = `
    <div style="grid-column: 1/-1; text-align: center; padding: 40px 0; color: #b3b3b3;">
      <i class="fa-solid fa-spinner fa-spin" style="font-size: 2rem; margin-bottom: 10px; display: block; color: #1db954;"></i>
      Loading trending tracks...
    </div>
  `;
  try {
    const res = await fetch(`${API_BASE}/api/trending`);
    if (res.ok) {
      const data = await res.json();
      if (data && data.results && data.results.length > 0) {
        trackList = data.results;
        renderTracks();
        loadFirstTrackIfEmpty();
        return;
      }
    }
    fetchOnlineSongs("Top Trending Hits");
  } catch (err) {
    fetchOnlineSongs("Top Trending Hits");
  }
}

async function fetchCustomSongs() {
  trackGrid.innerHTML = `
    <div style="grid-column: 1/-1; text-align: center; padding: 40px 0; color: #b3b3b3;">
      <i class="fa-solid fa-spinner fa-spin" style="font-size: 2rem; margin-bottom: 10px; display: block; color: #1db954;"></i>
      Loading custom uploaded tracks...
    </div>
  `;
  try {
    const res = await fetch(`${API_BASE}/api/admin/songs`);
    const data = await res.json();
    if (data.success && data.songs.length > 0) {
      trackList = data.songs;
      renderTracks();
      loadFirstTrackIfEmpty();
    } else {
      trackGrid.innerHTML = `
        <div style="grid-column: 1/-1; text-align: center; padding: 40px 0; color: #b3b3b3;">
          <p>No featured custom tracks found.</p>
        </div>
      `;
    }
  } catch (e) {
    trackGrid.innerHTML = '<p style="color: #ff5555; grid-column: 1/-1; text-align: center; padding: 40px 0;">Error fetching custom tracks.</p>';
  }
}

function renderTracks() {
  trackGrid.innerHTML = '';
  const likedSongs = getLikedSongs();

  trackList.forEach((track, index) => {
    const isLiked = likedSongs.some(s => s.src === track.src);
    const isCustom = track.source === 'custom';
    const card = document.createElement('div');
    card.classList.add('card');

    card.innerHTML = `
      <div class="card-img-wrap">
        <img src="${track.cover}" alt="${track.title}" onerror="this.src='https://via.placeholder.com/300'">
        <i class="fa-heart ${isLiked ? 'fa-solid active-heart' : 'fa-regular'} card-heart" id="heart-${index}"></i>
        <button class="card-play-btn" title="Play ${escapeHtml(track.title)}" data-index="${index}">
          <i class="fa-solid fa-play"></i>
        </button>
      </div>
      <h3 title="${track.title}">${track.title}</h3>
      <p title="${track.artist}">${track.artist}</p>
      
      <div class="card-actions-row">
        <button class="card-action-btn add-pl-card-btn" title="Add to Playlist" data-index="${index}">
          <i class="fa-solid fa-plus"></i>
        </button>
        <button class="card-action-btn download-card-btn" title="Download Song" data-index="${index}">
          <i class="fa-solid fa-download"></i>
        </button>
        <button class="card-action-btn share-card-btn" title="Share Song" data-index="${index}">
          <i class="fa-solid fa-share-nodes"></i>
        </button>
      </div>
    `;

    card.addEventListener('click', (e) => {
      if (e.target.classList.contains('card-heart')) return;
      if (e.target.closest('.card-actions-row')) return;
      currentTrackIndex = index;
      loadTrack(currentTrackIndex);
      playAudio();
    });

    const artistEl = card.querySelector('p');
    if (artistEl) {
      artistEl.addEventListener('click', (e) => {
        e.stopPropagation();
        openArtistProfile(track.artist);
      });
    }

    const heartBtn = card.querySelector(`#heart-${index}`);
    heartBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleLikeSong(track, heartBtn);
    });

    const addPlBtn = card.querySelector('.add-pl-card-btn');
    addPlBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openAddToPlaylistModal(track);
    });

    const downloadBtn = card.querySelector('.download-card-btn');
    downloadBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      downloadSong(track);
    });

    const shareBtn = card.querySelector('.share-card-btn');
    shareBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      shareSong(track);
    });

    trackGrid.appendChild(card);
  });
}

function formatTime(seconds) {
  if (isNaN(seconds) || seconds < 0) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
}

function playNextSong() {
  playNextTrack();
}

function playPrevSong() {
  playPrevTrack();
}

function updateMediaSession(song) {
  if (!('mediaSession' in navigator) || !song) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: song.title || 'Unknown Title',
      artist: song.artist || 'Unknown Artist',
      album: song.album || 'Spotify Web',
      artwork: [
        { src: song.cover || '/icons/default-cover.png', sizes: '512x512', type: 'image/jpeg' },
        { src: song.cover || 'https://via.placeholder.com/256', sizes: '256x256', type: 'image/jpeg' },
        { src: song.cover || 'https://via.placeholder.com/96', sizes: '96x96', type: 'image/jpeg' }
      ]
    });

    navigator.mediaSession.setActionHandler('play', () => (typeof playAudio === 'function' ? playAudio() : audio.play()));
    navigator.mediaSession.setActionHandler('pause', () => (typeof pauseAudio === 'function' ? pauseAudio() : audio.pause()));
    navigator.mediaSession.setActionHandler('nexttrack', () => playNextSong());
    navigator.mediaSession.setActionHandler('previoustrack', () => playPrevSong());
    navigator.mediaSession.setActionHandler('seekto', (details) => {
      if (details.fastSeek && 'fastSeek' in audio) {
        audio.fastSeek(details.seekTime);
        return;
      }
      audio.currentTime = details.seekTime;
    });

    navigator.mediaSession.playbackState = !audio.paused ? 'playing' : 'paused';
  } catch (e) {
    console.warn("MediaSession API note:", e.message);
  }
}

function restoreInitialPlayerUI() {
  const s = playerStore.getState();

  // 1. Restore Volume
  if (typeof s.volume === 'number' && !isNaN(s.volume)) {
    audio.volume = s.volume;
    if (volumeBar) volumeBar.value = Math.round(s.volume * 100);
    originalVolumeBeforeFade = s.volume;
  }

  // 2. Restore Speed
  if (s.playbackSpeed) {
    currentPlaybackSpeed = s.playbackSpeed;
    audio.playbackRate = s.playbackSpeed;
    if (speedBtn) speedBtn.innerText = `${s.playbackSpeed}x`;
  }

  // 3. Restore Shuffle
  if (typeof s.isShuffle === 'boolean') {
    isShuffle = s.isShuffle;
    if (shuffleBtn) {
      shuffleBtn.classList.toggle('active', isShuffle);
      shuffleBtn.title = isShuffle ? "Shuffle (On)" : "Shuffle (Off)";
    }
  }

  // 4. Restore Repeat Mode
  if (typeof s.repeatMode === 'number') {
    repeatMode = s.repeatMode;
    if (repeatBtn && repeatBadge) {
      if (repeatMode === 0) {
        repeatBtn.classList.remove('active');
        repeatBadge.classList.add('hidden');
        repeatBtn.title = "Repeat (Off)";
      } else if (repeatMode === 1) {
        repeatBtn.classList.add('active');
        repeatBadge.classList.add('hidden');
        repeatBtn.title = "Repeat All (On)";
      } else if (repeatMode === 2) {
        repeatBtn.classList.add('active');
        repeatBadge.classList.remove('hidden');
        repeatBtn.title = "Repeat One Track (On)";
      }
    }
  }

  // 5. Restore Last Played Track
  if (s.currentTrack && s.currentTrack.src) {
    if (Array.isArray(s.trackList) && s.trackList.length > 0) {
      trackList = s.trackList;
      currentTrackIndex = typeof s.currentTrackIndex === 'number' ? s.currentTrackIndex : 0;
    }
    audio.src = s.currentTrack.src;
    if (trackTitle) trackTitle.innerText = s.currentTrack.title || 'Unknown Title';
    if (trackArtist) trackArtist.innerText = s.currentTrack.artist || 'Unknown Artist';
    if (coverArt && s.currentTrack.cover) coverArt.src = s.currentTrack.cover;
    if (s.duration && totalTimeEl) totalTimeEl.innerText = formatTime(s.duration);
    if (s.currentTime && currentTimeEl) {
      currentTimeEl.innerText = formatTime(s.currentTime);
      if (s.duration && progressBar) {
        progressBar.value = (s.currentTime / s.duration) * 100;
      }
    }
    updateMediaSession(s.currentTrack);
  }
}

function loadFirstTrackIfEmpty() {
  const current = playerStore.getState().currentTrack;
  if (!current || !audio.src) {
    loadTrack(0);
  } else if (Array.isArray(trackList) && trackList.length > 0) {
    const idx = trackList.findIndex(t => t.src === current.src || t.id === current.id || (t.title === current.title && t.artist === current.artist));
    if (idx !== -1) {
      currentTrackIndex = idx;
    }
  }
}

function loadTrack(index) {
  if (trackList.length === 0) return;
  currentTrackIndex = index;
  const track = trackList[index];
  audio.src = track.src;
  audio.playbackRate = currentPlaybackSpeed;
  trackTitle.innerText = track.title;
  trackArtist.innerText = track.artist;
  coverArt.src = track.cover;
  
  progressBar.value = 0;
  currentTimeEl.innerText = "0:00";
  if (track.duration) {
    totalTimeEl.innerText = formatTime(track.duration);
  } else {
    totalTimeEl.innerText = "0:00";
  }

  playerStore.setState({
    trackList: trackList,
    currentTrackIndex: index,
    currentTrack: track,
    currentTime: 0,
    duration: track.duration || 0
  });

  updateMediaSession(track);
  if (typeof syncFullscreenPlayerUI === 'function') syncFullscreenPlayerUI();
  if (typeof updateVizMeta === 'function') updateVizMeta();
  if (typeof lyricsModal !== 'undefined' && lyricsModal && !lyricsModal.classList.contains('hidden')) {
    fetchLyricsForTrack(track);
  }
}

function playAudio() {
  if (!audio.src) {
    if (trackList.length > 0) {
      loadTrack(currentTrackIndex || 0);
    } else {
      return;
    }
  }

  initVisualizer();
  audio.play().then(() => {
    isPlaying = true;
    playBtn.innerHTML = `<i class="fa-solid fa-pause"></i>`;
    const fsPlayBtnEl = document.getElementById('fs-play-btn');
    if (fsPlayBtnEl) fsPlayBtnEl.innerHTML = `<i class="fa-solid fa-pause"></i>`;
    playerStore.setState({ isPlaying: true });
    const cur = trackList[currentTrackIndex];
    if (cur) {
      addToLibrary(cur);
      addToRecentlyPlayed(cur);
      updateMediaSession(cur);
      if (typeof syncFullscreenPlayerUI === 'function') syncFullscreenPlayerUI();
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
      document.title = `▶ ${cur.title} - ${cur.artist}`;
      if (typeof updateVizMeta === 'function') updateVizMeta();

      // If Party Mode is active, broadcast
      if (typeof partySocket !== 'undefined' && partySocket && activePartyRoomId) {
        partySocket.emit('sync-playback', {
          roomId: activePartyRoomId,
          track: cur,
          isPlaying: true,
          currentTime: audio.currentTime
        });
      }
    }
  }).catch((err) => {
    console.warn("Playback error/aborted:", err.message);
    isPlaying = false;
    playBtn.innerHTML = `<i class="fa-solid fa-play"></i>`;
    const fsPlayBtnEl = document.getElementById('fs-play-btn');
    if (fsPlayBtnEl) fsPlayBtnEl.innerHTML = `<i class="fa-solid fa-play"></i>`;
    playerStore.setState({ isPlaying: false });
  });
}

function pauseAudio() {
  audio.pause();
  isPlaying = false;
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
  playBtn.innerHTML = `<i class="fa-solid fa-play"></i>`;
  const fsPlayBtnEl = document.getElementById('fs-play-btn');
  if (fsPlayBtnEl) fsPlayBtnEl.innerHTML = `<i class="fa-solid fa-play"></i>`;
  playerStore.setState({ isPlaying: false });
  document.title = 'Spotify 2.0 - Web Player';
  if (typeof updateVizMeta === 'function') updateVizMeta();

  if (typeof partySocket !== 'undefined' && partySocket && activePartyRoomId) {
    partySocket.emit('sync-playback', {
      roomId: activePartyRoomId,
      track: trackList[currentTrackIndex],
      isPlaying: false,
      currentTime: audio.currentTime
    });
  }
}

function togglePlay() {
  if (isPlaying) {
    pauseAudio();
  } else {
    playAudio();
  }
}

function playNextTrack() {
  if (trackList.length === 0) return;
  if (isShuffle) {
    let rand = Math.floor(Math.random() * trackList.length);
    if (rand === currentTrackIndex && trackList.length > 1) {
      rand = (rand + 1) % trackList.length;
    }
    currentTrackIndex = rand;
  } else {
    currentTrackIndex = (currentTrackIndex + 1) % trackList.length;
  }
  loadTrack(currentTrackIndex);
  playAudio();
}

function playPrevTrack() {
  if (trackList.length === 0) return;
  currentTrackIndex = (currentTrackIndex - 1 + trackList.length) % trackList.length;
  loadTrack(currentTrackIndex);
  playAudio();
}

audio.addEventListener('loadedmetadata', () => {
  if (audio.duration && !isNaN(audio.duration) && isFinite(audio.duration)) {
    totalTimeEl.innerText = formatTime(audio.duration);
    playerStore.setState({ duration: Math.floor(audio.duration) }, { persist: true, notify: false });
  }
});

let lastTimePersist = 0;
audio.addEventListener('timeupdate', () => {
  if (audio.duration && !isNaN(audio.duration)) {
    const progressPercent = (audio.currentTime / audio.duration) * 100;
    progressBar.value = progressPercent;
    currentTimeEl.innerText = formatTime(audio.currentTime);
    totalTimeEl.innerText = formatTime(audio.duration);

    // Fullscreen Popup Player Sync
    const fsProgressBarEl = document.getElementById('fs-progress-bar');
    const fsCurrentTimeEl = document.getElementById('fs-current-time');
    const fsTotalTimeEl = document.getElementById('fs-total-time');
    if (fsProgressBarEl && (typeof isFsScrubbing === 'undefined' || !isFsScrubbing)) {
      fsProgressBarEl.value = progressPercent;
    }
    if (fsCurrentTimeEl) fsCurrentTimeEl.innerText = formatTime(audio.currentTime);
    if (fsTotalTimeEl) fsTotalTimeEl.innerText = formatTime(audio.duration);

    // Live Synced Lyrics Scroll
    if (typeof updateSyncedLyrics === 'function') {
      updateSyncedLyrics(audio.currentTime);
    }

    // DJ Crossfade Transition check
    if (typeof crossfadeDuration !== 'undefined' && crossfadeDuration > 0 && audio.duration > crossfadeDuration * 2) {
      const timeLeft = audio.duration - audio.currentTime;
      if (timeLeft <= crossfadeDuration && !isCrossfading) {
        handleCrossfadeTransition();
      }
    }

    // Periodically sync currentTime with global state every 2 seconds
    const now = Date.now();
    if (now - lastTimePersist > 2000) {
      lastTimePersist = now;
      playerStore.setState({
        currentTime: Math.floor(audio.currentTime),
        duration: Math.floor(audio.duration)
      }, { persist: true, notify: false });
    }
  }
});

audio.addEventListener('ended', () => {
  if (repeatMode === 2) {
    audio.currentTime = 0;
    playAudio();
  } else if (repeatMode === 1) {
    playNextTrack();
  } else {
    if (currentTrackIndex < trackList.length - 1 || isShuffle) {
      playNextTrack();
    } else {
      pauseAudio();
    }
  }
});

audio.addEventListener('error', (e) => {
  console.warn("Audio playback error:", e);
  isPlaying = false;
  playBtn.innerHTML = `<i class="fa-solid fa-play"></i>`;
  playerStore.setState({ isPlaying: false });
  const badTrack = trackList[currentTrackIndex];
  const name = badTrack ? badTrack.title : 'Current track';
  showToast(`⚠️ Unable to play "${name}". Playing next track...`, 'error');
  if (trackList.length > 1) {
    setTimeout(() => {
      playNextTrack();
    }, 1200);
  }
});

progressBar.addEventListener('input', () => {
  if (audio.duration) {
    const seekTime = (progressBar.value / 100) * audio.duration;
    audio.currentTime = seekTime;
    playerStore.setState({ currentTime: Math.floor(seekTime) }, { persist: true, notify: false });
  }
});

volumeBar.addEventListener('input', (e) => {
  const val = e.target.value / 100;
  audio.volume = val;
  originalVolumeBeforeFade = val;
  playerStore.setState({ volume: val });
});

nextBtn.addEventListener('click', playNextTrack);
prevBtn.addEventListener('click', playPrevTrack);
playBtn.addEventListener('click', togglePlay);

shuffleBtn.addEventListener('click', () => {
  isShuffle = !isShuffle;
  shuffleBtn.classList.toggle('active', isShuffle);
  shuffleBtn.title = isShuffle ? "Shuffle (On)" : "Shuffle (Off)";
  playerStore.setState({ isShuffle: isShuffle });
  showToast(isShuffle ? "Shuffle On 🔀" : "Shuffle Off", 'info');
});

repeatBtn.addEventListener('click', () => {
  repeatMode = (repeatMode + 1) % 3;
  playerStore.setState({ repeatMode: repeatMode });
  if (repeatMode === 0) {
    repeatBtn.classList.remove('active');
    repeatBadge.classList.add('hidden');
    repeatBtn.title = "Repeat (Off)";
    showToast("Repeat Off", 'info');
  } else if (repeatMode === 1) {
    repeatBtn.classList.add('active');
    repeatBadge.classList.add('hidden');
    repeatBtn.title = "Repeat All (On)";
    showToast("Repeat All 🔁", 'info');
  } else if (repeatMode === 2) {
    repeatBtn.classList.add('active');
    repeatBadge.classList.remove('hidden');
    repeatBtn.title = "Repeat One Track (On)";
    showToast("Repeat One Track 🔂", 'info');
  }
});

const speeds = [1.0, 1.25, 1.5, 0.75];
speedBtn.addEventListener('click', () => {
  const nextIdx = (speeds.indexOf(currentPlaybackSpeed) + 1) % speeds.length;
  currentPlaybackSpeed = speeds[nextIdx];
  audio.playbackRate = currentPlaybackSpeed;
  speedBtn.innerText = `${currentPlaybackSpeed}x`;
  playerStore.setState({ playbackSpeed: currentPlaybackSpeed });
  showToast(`Speed: ${currentPlaybackSpeed}x`, 'info');
});

// ==========================================
// LIVE SEARCH AUTO-COMPLETE SUGGESTIONS
// ==========================================
let searchDebounceTimer = null;
let currentSuggestionResults = [];
let selectedSuggestionIndex = -1;

function hideSuggestions() {
  if (searchSuggestions) {
    searchSuggestions.classList.add('hidden');
    searchSuggestions.innerHTML = '';
  }
  selectedSuggestionIndex = -1;
}

function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function fetchLiveSuggestions(query) {
  if (!query || query.length === 0) {
    hideSuggestions();
    return;
  }

  if (searchSuggestions) {
    searchSuggestions.classList.remove('hidden');
    searchSuggestions.innerHTML = `
      <div class="suggestion-loading">
        <i class="fa-solid fa-spinner fa-spin" style="color:#1db954;"></i>
        <span>Finding songs for "${escapeHtml(query)}"...</span>
      </div>
    `;
  }

  try {
    const res = await fetch(`${API_BASE}/api/suggestions?q=${encodeURIComponent(query)}`);
    const data = await res.json();

    if (searchInput.value.trim().toLowerCase() !== query.toLowerCase()) return;

    if (!data || !data.results || data.results.length === 0) {
      if (searchSuggestions) {
        searchSuggestions.innerHTML = `
          <div style="padding: 14px; text-align: center; color: #888; font-size: 13px;">
            No direct song options found. Press Enter to search all.
          </div>
          <div class="suggestion-footer" id="suggestion-see-all">
            <i class="fa-solid fa-magnifying-glass"></i>
            <span>Search all results for "${escapeHtml(query)}"</span>
          </div>
        `;
        const seeAllBtn = document.getElementById('suggestion-see-all');
        if (seeAllBtn) {
          seeAllBtn.addEventListener('click', () => {
            hideSuggestions();
            executeSearch();
          });
        }
      }
      return;
    }

    currentSuggestionResults = data.results;
    selectedSuggestionIndex = -1;
    renderSuggestions(data.results, query);
  } catch (err) {
    console.warn("Live suggestions note:", err.message);
  }
}

function renderSuggestions(songs, query) {
  if (!searchSuggestions) return;
  searchSuggestions.innerHTML = '';

  songs.forEach((song, idx) => {
    const item = document.createElement('div');
    item.className = 'suggestion-item';
    item.setAttribute('data-index', idx);

    let badge = '';
    if (song.source === 'permanent' || song.source === 'custom') {
      badge = `<span class="suggestion-badge">Featured</span>`;
    }

    item.innerHTML = `
      <img src="${song.cover || 'https://via.placeholder.com/60'}" alt="${escapeHtml(song.title)}" onerror="this.src='https://via.placeholder.com/60'">
      <div class="suggestion-details">
        <div class="suggestion-title">${escapeHtml(song.title)} ${badge}</div>
        <div class="suggestion-artist">${escapeHtml(song.artist)}</div>
      </div>
      <div class="suggestion-play-icon" title="Play Song">
        <i class="fa-solid fa-play"></i>
      </div>
    `;

    item.addEventListener('click', () => {
      selectAndPlaySuggestion(song, songs);
    });

    const artistElem = item.querySelector('.suggestion-artist');
    if (artistElem) {
      artistElem.style.cursor = 'pointer';
      artistElem.title = `View ${song.artist} profile`;
      artistElem.addEventListener('click', (e) => {
        e.stopPropagation();
        hideSuggestions();
        if (typeof openArtistProfile === 'function') openArtistProfile(song.artist);
      });
    }

    searchSuggestions.appendChild(item);
  });

  const footer = document.createElement('div');
  footer.className = 'suggestion-footer';
  footer.innerHTML = `
    <i class="fa-solid fa-magnifying-glass"></i>
    <span>See all results for "${escapeHtml(query)}"</span>
  `;
  footer.addEventListener('click', () => {
    hideSuggestions();
    executeSearch();
  });
  searchSuggestions.appendChild(footer);
}

function selectAndPlaySuggestion(song, allSuggestions) {
  if (typeof closeArtistProfile === 'function') closeArtistProfile();
  hideSuggestions();
  searchInput.value = song.title;

  trackList = allSuggestions;
  renderTracks();
  const idx = trackList.findIndex(s => s.src === song.src);
  currentTrackIndex = idx > -1 ? idx : 0;
  loadTrack(currentTrackIndex);
  playAudio();
  sectionTitle.innerText = `Playing: "${song.title}"`;
  showToast(`Playing "${song.title}" 🎵`, 'success');
}

function updateSuggestionHighlight() {
  const items = searchSuggestions.querySelectorAll('.suggestion-item');
  items.forEach((item, idx) => {
    if (idx === selectedSuggestionIndex) {
      item.classList.add('selected');
      item.scrollIntoView({ block: 'nearest' });
    } else {
      item.classList.remove('selected');
    }
  });
}

function executeSearch() {
  if (typeof closeArtistProfile === 'function') closeArtistProfile();
  hideSuggestions();
  const query = searchInput.value.trim();
  if (query) {
    sectionTitle.innerText = `Search Results for "${query}"`;
    fetchOnlineSongs(query);
  } else {
    sectionTitle.innerText = "Home - Top Hits";
    fetchOnlineSongs("Top Hits");
  }
}

searchBtn.addEventListener('click', executeSearch);

searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') {
    if (searchSuggestions && !searchSuggestions.classList.contains('hidden') && currentSuggestionResults.length > 0) {
      e.preventDefault();
      selectedSuggestionIndex = (selectedSuggestionIndex + 1) % currentSuggestionResults.length;
      updateSuggestionHighlight();
    }
  } else if (e.key === 'ArrowUp') {
    if (searchSuggestions && !searchSuggestions.classList.contains('hidden') && currentSuggestionResults.length > 0) {
      e.preventDefault();
      selectedSuggestionIndex = (selectedSuggestionIndex - 1 + currentSuggestionResults.length) % currentSuggestionResults.length;
      updateSuggestionHighlight();
    }
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (selectedSuggestionIndex > -1 && currentSuggestionResults[selectedSuggestionIndex]) {
      selectAndPlaySuggestion(currentSuggestionResults[selectedSuggestionIndex], currentSuggestionResults);
    } else {
      executeSearch();
    }
  } else if (e.key === 'Escape') {
    hideSuggestions();
  }
});

searchInput.addEventListener('input', () => {
  const query = searchInput.value.trim();

  if (searchDebounceTimer) {
    clearTimeout(searchDebounceTimer);
  }

  if (query === '') {
    hideSuggestions();
    sectionTitle.innerText = "Home - Top Hits";
    fetchOnlineSongs("Top Hits");
    return;
  }

  // Trigger live suggestions as soon as user types even a single letter / word
  searchDebounceTimer = setTimeout(() => {
    fetchLiveSuggestions(query);
  }, 220);
});

searchInput.addEventListener('focus', () => {
  const query = searchInput.value.trim();
  if (query.length > 0) {
    fetchLiveSuggestions(query);
  }
});

// Close suggestions on outside click
document.addEventListener('click', (e) => {
  if (!e.target.closest('.search-box')) {
    hideSuggestions();
  }
});

// ==========================================
// 5. WEB AUDIO GRAPH SETUP (8D Audio + Equalizer)
// ==========================================

function setupAudioContext() {
  if (audioCtx) {
    if (audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }
    return true;
  }

  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return false;
    audioCtx = new AudioContextClass();

    // Source from Audio element
    try {
      sourceNode = audioCtx.createMediaElementSource(audio);
    } catch (e) {
      console.warn("Audio element source routing note:", e.message);
      return false;
    }

    if (!sourceNode) return false;

    // Stereo Panner Node for 8D Audio
    if (audioCtx.createStereoPanner) {
      pannerNode = audioCtx.createStereoPanner();
    }

    // Build 5-Band Equalizer Nodes
    eqFilters = eqBands.map((band) => {
      const filter = audioCtx.createBiquadFilter();
      filter.type = band.type;
      filter.frequency.value = band.freq;
      filter.gain.value = 0;
      return filter;
    });

    let lastNode = sourceNode;

    if (pannerNode) {
      lastNode.connect(pannerNode);
      lastNode = pannerNode;
    }

    eqFilters.forEach((filter) => {
      lastNode.connect(filter);
      lastNode = filter;
    });

    lastNode.connect(audioCtx.destination);
    return true;
  } catch (err) {
    console.warn("Web Audio API routing note:", err.message);
    return false;
  }
}

// 8D Audio Mode Toggle
eightDBtn.addEventListener('click', (e) => {
  if (e) { e.preventDefault(); e.stopPropagation(); }
  is8DActive = !is8DActive;
  setupAudioContext();

  if (is8DActive) {
    eightDBtn.classList.add('active');
    eightDBtn.title = "8D Audio (Active: 360° Rotating Sound)";
    start8DLoop();
  } else {
    eightDBtn.classList.remove('active');
    eightDBtn.title = "8D Spatial Audio (360° Surround Sound)";
    stop8DLoop();
  }
});

function start8DLoop() {
  if (panAnimationId) return;

  function rotateSound() {
    if (is8DActive && isPlaying && pannerNode && audioCtx && audioCtx.state === 'running') {
      panAngle += 0.035; // smooth rotation speed
      pannerNode.pan.value = Math.sin(panAngle);
    } else if (pannerNode) {
      pannerNode.pan.value = 0;
    }
    panAnimationId = requestAnimationFrame(rotateSound);
  }

  panAnimationId = requestAnimationFrame(rotateSound);
}

function stop8DLoop() {
  if (panAnimationId) {
    cancelAnimationFrame(panAnimationId);
    panAnimationId = null;
  }
  if (pannerNode) {
    pannerNode.pan.value = 0;
  }
}

// ==========================================
// 6. 5-BAND EQUALIZER & BASS BOOST
// ==========================================

eqBtn.addEventListener('click', (e) => {
  if (e) { e.preventDefault(); e.stopPropagation(); }
  setupAudioContext();
  eqModal.classList.remove('hidden');
});

closeEqBtn.addEventListener('click', (e) => {
  if (e) { e.preventDefault(); e.stopPropagation(); }
  eqModal.classList.add('hidden');
});

// Sliders event listener
eqBands.forEach((band, idx) => {
  const slider = document.getElementById(band.id);
  const label = document.getElementById(band.label);

  slider.addEventListener('input', (e) => {
    setupAudioContext();
    const val = parseFloat(e.target.value);
    label.innerText = (val > 0 ? `+${val}` : `${val}`) + 'dB';

    if (eqFilters[idx]) {
      eqFilters[idx].gain.value = val;
    }

    // Set active preset to custom
    eqPresetBtns.forEach(b => b.classList.remove('active'));
  });
});

// Equalizer Presets
const eqPresetsMap = {
  flat: [0, 0, 0, 0, 0],
  bass: [10, 6, 0, 0, 2],
  club: [7, 4, -2, 5, 7],
  rock: [5, 3, -1, 4, 6],
  vocal: [-2, 2, 7, 4, 1]
};

eqPresetBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    setupAudioContext();
    eqPresetBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    const presetKey = btn.dataset.preset;
    const values = eqPresetsMap[presetKey] || [0, 0, 0, 0, 0];

    values.forEach((val, idx) => {
      const band = eqBands[idx];
      const slider = document.getElementById(band.id);
      const label = document.getElementById(band.label);

      slider.value = val;
      label.innerText = (val > 0 ? `+${val}` : `${val}`) + 'dB';

      if (eqFilters[idx]) {
        eqFilters[idx].gain.value = val;
      }
    });
  });
});

// ==========================================
// 7. AMBIENT SOUND MIXER (Rain, Fire, Cafe)
// ==========================================

function getAmbientContext() {
  if (!ambientCtx) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    ambientCtx = new AudioContextClass();
  }
  if (ambientCtx.state === 'suspended') {
    ambientCtx.resume();
  }
  return ambientCtx;
}

// Generate synthesized ambient audio buffers
function createNoiseBuffer(ctx, type = 'pink') {
  const bufferSize = ctx.sampleRate * 2;
  const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const data = buffer.getChannelData(0);

  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;

  for (let i = 0; i < bufferSize; i++) {
    const white = Math.random() * 2 - 1;
    if (type === 'pink') {
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.96900 * b2 + white * 0.1538520;
      b3 = 0.86650 * b3 + white * 0.3104856;
      b4 = 0.55000 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.0168980;
      data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
      b6 = white * 0.115926;
    } else {
      data[i] = white * 0.15;
    }
  }
  return buffer;
}

function startAmbientSound(key, filterFreq, volume) {
  const ctx = getAmbientContext();
  const nodeInfo = ambientNodes[key];

  if (nodeInfo.isPlaying) return;

  const noiseBuffer = createNoiseBuffer(ctx, key === 'fire' ? 'white' : 'pink');
  const source = ctx.createBufferSource();
  source.buffer = noiseBuffer;
  source.loop = true;

  const filter = ctx.createBiquadFilter();
  filter.type = key === 'fire' ? 'bandpass' : 'lowpass';
  filter.frequency.value = filterFreq;

  const gain = ctx.createGain();
  gain.gain.value = volume / 100;

  source.connect(filter);
  filter.connect(gain);
  gain.connect(ctx.destination);

  source.start(0);

  nodeInfo.isPlaying = true;
  nodeInfo.sourceNode = source;
  nodeInfo.gainNode = gain;
}

function stopAmbientSound(key) {
  const nodeInfo = ambientNodes[key];
  if (!nodeInfo.isPlaying) return;

  try {
    nodeInfo.sourceNode.stop();
    nodeInfo.sourceNode.disconnect();
  } catch (e) {}

  nodeInfo.isPlaying = false;
  nodeInfo.sourceNode = null;
  nodeInfo.gainNode = null;
}

openAmbientBtn.addEventListener('click', (e) => {
  if (e) { e.preventDefault(); e.stopPropagation(); }
  ambientModal.classList.remove('hidden');
});
closeAmbientBtn.addEventListener('click', (e) => {
  if (e) { e.preventDefault(); e.stopPropagation(); }
  ambientModal.classList.add('hidden');
});

// Rain Toggle
btnToggleRain.addEventListener('click', () => {
  const key = 'rain';
  if (ambientNodes[key].isPlaying) {
    stopAmbientSound(key);
    btnToggleRain.innerText = 'OFF';
    btnToggleRain.classList.remove('active');
    cardAmbientRain.classList.remove('active');
  } else {
    startAmbientSound(key, 800, sliderRain.value);
    btnToggleRain.innerText = 'ON';
    btnToggleRain.classList.add('active');
    cardAmbientRain.classList.add('active');
  }
});
sliderRain.addEventListener('input', (e) => {
  if (ambientNodes.rain.gainNode) {
    ambientNodes.rain.gainNode.gain.value = e.target.value / 100;
  }
});

// Campfire Toggle
btnToggleFire.addEventListener('click', () => {
  const key = 'fire';
  if (ambientNodes[key].isPlaying) {
    stopAmbientSound(key);
    btnToggleFire.innerText = 'OFF';
    btnToggleFire.classList.remove('active');
    cardAmbientFire.classList.remove('active');
  } else {
    startAmbientSound(key, 1200, sliderFire.value);
    btnToggleFire.innerText = 'ON';
    btnToggleFire.classList.add('active');
    cardAmbientFire.classList.add('active');
  }
});
sliderFire.addEventListener('input', (e) => {
  if (ambientNodes.fire.gainNode) {
    ambientNodes.fire.gainNode.gain.value = e.target.value / 100;
  }
});

// Cafe Toggle
btnToggleCafe.addEventListener('click', () => {
  const key = 'cafe';
  if (ambientNodes[key].isPlaying) {
    stopAmbientSound(key);
    btnToggleCafe.innerText = 'OFF';
    btnToggleCafe.classList.remove('active');
    cardAmbientCafe.classList.remove('active');
  } else {
    startAmbientSound(key, 500, sliderCafe.value);
    btnToggleCafe.innerText = 'ON';
    btnToggleCafe.classList.add('active');
    cardAmbientCafe.classList.add('active');
  }
});
sliderCafe.addEventListener('input', (e) => {
  if (ambientNodes.cafe.gainNode) {
    ambientNodes.cafe.gainNode.gain.value = e.target.value / 100;
  }
});

// ==========================================
// 8. SMART SLEEP TIMER (WITH GRADUAL FADE-OUT)
// ==========================================

sleepTimerBtn.addEventListener('click', (e) => {
  if (e) { e.preventDefault(); e.stopPropagation(); }
  sleepTimerModal.classList.remove('hidden');
});

closeSleepBtn.addEventListener('click', (e) => {
  if (e) { e.preventDefault(); e.stopPropagation(); }
  sleepTimerModal.classList.add('hidden');
});

sleepChips.forEach(chip => {
  chip.addEventListener('click', () => {
    sleepChips.forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    const minutes = parseInt(chip.dataset.min, 10);
    startSleepTimer(minutes);
  });
});

btnTurnOffTimer.addEventListener('click', () => {
  stopSleepTimer();
  sleepChips.forEach(c => c.classList.remove('active'));
  sleepStatusBox.innerHTML = 'Timer is currently <b>Inactive</b>';
  sleepTimerBtn.classList.remove('active');
  sleepTimerBtn.title = "Sleep Timer";
  showToast("Sleep timer cancelled", 'info');
});

function startSleepTimer(minutes) {
  stopSleepTimer();
  sleepRemainingSeconds = minutes * 60;
  originalVolumeBeforeFade = audio.volume;

  updateSleepTimerDisplay();
  sleepTimerBtn.classList.add('active');

  sleepTimerInterval = setInterval(() => {
    sleepRemainingSeconds--;

    // Last 30 seconds: Gradual Fade-out
    if (sleepRemainingSeconds <= 30 && sleepRemainingSeconds > 0) {
      const fadeFactor = sleepRemainingSeconds / 30;
      audio.volume = originalVolumeBeforeFade * fadeFactor;
    }

    if (sleepRemainingSeconds <= 0) {
      // Time is up!
      stopSleepTimer();
      pauseAudio();
      audio.volume = originalVolumeBeforeFade; // restore
      sleepStatusBox.innerHTML = '💤 Timer completed. Music paused smoothly!';
      sleepTimerBtn.classList.remove('active');
      sleepTimerBtn.title = "Sleep Timer";
      showToast('💤 Sleep timer completed. Music paused.', 'info');
      return;
    }

    updateSleepTimerDisplay();
  }, 1000);

  showToast(`🌙 Sleep timer set for ${minutes} minutes`, 'success');
}

function updateSleepTimerDisplay() {
  const m = Math.floor(sleepRemainingSeconds / 60);
  const s = sleepRemainingSeconds % 60;
  const timeStr = `${m}:${s < 10 ? '0' : ''}${s}`;
  sleepStatusBox.innerHTML = `🌙 Active: <b>${timeStr}</b> remaining before fade-out`;
  sleepTimerBtn.title = `Sleep Timer (${timeStr})`;
}

function stopSleepTimer() {
  if (sleepTimerInterval) {
    clearInterval(sleepTimerInterval);
    sleepTimerInterval = null;
  }
}

// ==========================================
// 9. VOICE SEARCH (बोलकर सर्च करें)
// ==========================================

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

if (SpeechRecognition) {
  const recognition = new SpeechRecognition();
  recognition.continuous = false;
  recognition.lang = 'hi-IN';

  voiceSearchBtn.addEventListener('click', () => {
    try {
      voiceSearchBtn.classList.add('recording');
      voiceSearchBtn.title = "Listening... Speak now";
      recognition.start();
    } catch (err) {
      voiceSearchBtn.classList.remove('recording');
    }
  });

  recognition.onresult = (event) => {
    voiceSearchBtn.classList.remove('recording');
    const transcript = event.results[0][0].transcript;
    searchInput.value = transcript;
    sectionTitle.innerText = `Voice Search: "${transcript}"`;
    fetchOnlineSongs(transcript);
  };

  recognition.onerror = () => {
    voiceSearchBtn.classList.remove('recording');
    voiceSearchBtn.title = "Voice Search";
  };

  recognition.onend = () => {
    voiceSearchBtn.classList.remove('recording');
    voiceSearchBtn.title = "Voice Search";
  };
} else {
  voiceSearchBtn.addEventListener('click', () => {
    alert("Speech recognition is not supported in this browser. Please use Google Chrome or Microsoft Edge.");
  });
}

// ==========================================
// 10. LIVE AUDIO VISUALIZER
// ==========================================

let visualizerAnimationId = null;

function initVisualizer() {
  if (visualizerAnimationId) return;

  const ctx = visualizerCanvas.getContext('2d');
  const barCount = 12;
  const barWidth = 3;
  const gap = 2;

  function renderWave() {
    ctx.clearRect(0, 0, visualizerCanvas.width, visualizerCanvas.height);

    if (isPlaying) {
      for (let i = 0; i < barCount; i++) {
        const h = Math.abs(Math.sin((Date.now() / 150) + i) * (visualizerCanvas.height - 4)) + 3;
        const x = i * (barWidth + gap) + 4;
        const y = visualizerCanvas.height - h;

        ctx.fillStyle = is8DActive ? '#06b6d4' : (i % 2 === 0 ? '#1db954' : '#1ed760');
        ctx.fillRect(x, y, barWidth, h);
      }
    } else {
      for (let i = 0; i < barCount; i++) {
        const x = i * (barWidth + gap) + 4;
        ctx.fillStyle = '#555555';
        ctx.fillRect(x, visualizerCanvas.height - 3, barWidth, 3);
      }
    }

    visualizerAnimationId = requestAnimationFrame(renderWave);
  }

  renderWave();
}

// ==========================================
// 11. TOAST NOTIFICATION, DOWNLOAD & SHARE SONG
// ==========================================

function showToast(message, type = 'info') {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.className = 'toast-container';
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  toast.className = `toast-item toast-${type}`;

  let icon = 'fa-circle-info';
  if (type === 'success') icon = 'fa-circle-check';
  if (type === 'error') icon = 'fa-triangle-exclamation';
  if (type === 'heart') icon = 'fa-heart';

  toast.innerHTML = `
    <i class="fa-solid ${icon}"></i>
    <span>${message}</span>
  `;

  container.appendChild(toast);

  requestAnimationFrame(() => {
    toast.classList.add('show');
  });

  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 300);
  }, 3200);
}

function downloadSong(track) {
  if (!track || !track.src) return;
  showToast(`Starting download: "${track.title}"...`, 'info');
  const cleanName = `${track.artist} - ${track.title}`.replace(/[^a-zA-Z0-9 _.-]/g, '_');
  
  if (track.src.startsWith('http') || track.src.startsWith('/uploads/')) {
    const downloadUrl = `${API_BASE}/api/download?url=${encodeURIComponent(track.src)}&name=${encodeURIComponent(cleanName)}`;
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.setAttribute('download', `${cleanName}.mp3`);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } else {
    const a = document.createElement('a');
    a.href = track.src;
    a.download = `${cleanName}.mp3`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }
}

downloadCurrentBtn.addEventListener('click', () => {
  if (trackList.length > 0 && trackList[currentTrackIndex]) {
    downloadSong(trackList[currentTrackIndex]);
  }
});

function shareSong(track) {
  if (!track) return;
  const text = `🎵 Listen to "${track.title}" by ${track.artist} on Spotify 2.0!`;
  if (navigator.share) {
    navigator.share({
      title: track.title,
      text: text,
      url: window.location.href
    }).catch(() => {});
  } else {
    navigator.clipboard.writeText(`${text}\n${window.location.href}`);
    showToast(`Copied to clipboard: "${track.title}"`, 'success');
  }
}

shareCurrentBtn.addEventListener('click', () => {
  if (trackList.length > 0 && trackList[currentTrackIndex]) {
    shareSong(trackList[currentTrackIndex]);
  }
});

// ==========================================
// 12. UP NEXT QUEUE DRAWER
// ==========================================

function openQueueModal(e) {
  if (e) {
    if (typeof e.preventDefault === 'function') e.preventDefault();
    if (typeof e.stopPropagation === 'function') e.stopPropagation();
  }
  queueModal.classList.remove('hidden');
  renderQueue();
}

function renderQueue() {
  if (trackList.length === 0 || !trackList[currentTrackIndex]) {
    queueNowPlaying.innerHTML = '<p style="color: #888;">No song is currently playing.</p>';
    queueList.innerHTML = '<p style="color: #888;">Queue is empty.</p>';
    return;
  }

  const cur = trackList[currentTrackIndex];
  queueNowPlaying.innerHTML = `
    <img src="${cur.cover}" alt="${cur.title}">
    <div>
      <span style="font-size: 11px; color: #1db954; font-weight: bold; text-transform: uppercase;">Now Playing</span>
      <h4 style="font-size: 14px; color: #fff;">${cur.title}</h4>
      <p style="font-size: 12px; color: #b3b3b3;">${cur.artist}</p>
    </div>
  `;

  queueList.innerHTML = '';
  const upcoming = trackList.slice(currentTrackIndex + 1);

  if (upcoming.length === 0) {
    queueList.innerHTML = '<p style="color: #888; font-size: 13px;">End of playlist. Add more songs or search!</p>';
    return;
  }

  upcoming.forEach((track, offset) => {
    const item = document.createElement('div');
    item.classList.add('queue-item');
    item.innerHTML = `
      <div class="queue-item-info">
        <span style="color: #777; font-size: 12px; width: 16px;">${offset + 1}</span>
        <img src="${track.cover}" alt="${track.title}">
        <div>
          <h5 style="color: #fff; font-size: 13px;">${track.title}</h5>
          <p style="color: #888; font-size: 11px;">${track.artist}</p>
        </div>
      </div>
      <i class="fa-solid fa-play" style="color: #1db954; font-size: 12px;"></i>
    `;

    item.addEventListener('click', () => {
      currentTrackIndex = currentTrackIndex + 1 + offset;
      loadTrack(currentTrackIndex);
      playAudio();
      renderQueue();
    });

    queueList.appendChild(item);
  });
}

queueBtn.addEventListener('click', openQueueModal);
closeQueueBtn.addEventListener('click', (e) => {
  if (e) { e.preventDefault(); e.stopPropagation(); }
  queueModal.classList.add('hidden');
});

// ==========================================
// 13. CUSTOM PLAYLISTS MANAGEMENT
// ==========================================

function loadUserPlaylists() {
  const currentUser = getCurrentUser();
  if (currentUser && currentUser.email) {
    fetch(`${API_BASE}/api/user/playlists?email=${encodeURIComponent(currentUser.email)}`)
      .then(r => r.json())
      .then(d => {
        if (d.success) {
          userPlaylists = d.playlists || [];
          localStorage.setItem(PLAYLISTS_KEY, JSON.stringify(userPlaylists));
          renderUserPlaylists();
        }
      })
      .catch(() => {
        userPlaylists = JSON.parse(localStorage.getItem(PLAYLISTS_KEY)) || [];
        renderUserPlaylists();
      });
  } else {
    userPlaylists = JSON.parse(localStorage.getItem(PLAYLISTS_KEY)) || [];
    renderUserPlaylists();
  }
}

function renderUserPlaylists() {
  userPlaylistsList.innerHTML = '';
  if (userPlaylists.length === 0) {
    userPlaylistsList.innerHTML = '<li style="font-size: 12px; color: #666; padding: 4px 8px;">No playlists yet</li>';
    return;
  }

  userPlaylists.forEach((pl) => {
    const li = document.createElement('li');
    li.classList.add('user-playlist-item');
    li.innerHTML = `
      <span><i class="fa-solid fa-music"></i> ${pl.name} (${pl.songs ? pl.songs.length : 0})</span>
      <button class="delete-pl-btn" title="Delete Playlist"><i class="fa-solid fa-trash"></i></button>
    `;

    li.addEventListener('click', (e) => {
      if (e.target.closest('.delete-pl-btn')) return;
      updateActiveNav(li);
      sectionTitle.innerText = `Playlist: ${pl.name}`;
      if (!pl.songs || pl.songs.length === 0) {
        trackGrid.innerHTML = `
          <div style="grid-column: 1/-1; text-align: center; padding: 40px 0; color: #b3b3b3;">
            <p>This playlist is empty.</p>
            <p style="font-size: 13px; color: #777; margin-top: 5px;">Click the "+" icon on any song card to add it here!</p>
          </div>
        `;
        trackList = [];
      } else {
        trackList = pl.songs;
        renderTracks();
        loadTrack(0);
      }
    });

    const delBtn = li.querySelector('.delete-pl-btn');
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      deletePlaylist(pl.id, pl.name);
    });

    userPlaylistsList.appendChild(li);
  });
}

createPlaylistBtn.addEventListener('click', (e) => {
  if (e) { e.preventDefault(); e.stopPropagation(); }
  createPlaylistModal.classList.remove('hidden');
  newPlaylistNameInput.value = '';
  newPlaylistNameInput.focus();
});

closePlaylistModalBtn.addEventListener('click', (e) => {
  if (e) { e.preventDefault(); e.stopPropagation(); }
  createPlaylistModal.classList.add('hidden');
});

createPlaylistForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = newPlaylistNameInput.value.trim();
  if (!name) return;

  const currentUser = getCurrentUser();
  const newPl = {
    id: 'pl_' + Date.now(),
    name: name,
    songs: [],
    createdAt: new Date().toISOString()
  };

  userPlaylists.push(newPl);
  localStorage.setItem(PLAYLISTS_KEY, JSON.stringify(userPlaylists));
  renderUserPlaylists();

  if (currentUser && currentUser.email) {
    try {
      await fetch(`${API_BASE}/api/user/playlists`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: currentUser.email, name })
      });
    } catch (e) {}
  }

  createPlaylistForm.reset();
  createPlaylistModal.classList.add('hidden');
  showToast(`Playlist "${name}" created!`, 'success');
});

async function deletePlaylist(playlistId, name) {
  if (!confirm(`Delete playlist "${name}"?`)) return;
  userPlaylists = userPlaylists.filter(p => p.id !== playlistId);
  localStorage.setItem(PLAYLISTS_KEY, JSON.stringify(userPlaylists));
  renderUserPlaylists();
  showToast(`Playlist "${name}" deleted`, 'info');

  const currentUser = getCurrentUser();
  if (currentUser && currentUser.email) {
    try {
      await fetch(`${API_BASE}/api/user/playlists/${playlistId}?email=${encodeURIComponent(currentUser.email)}`, {
        method: 'DELETE'
      });
    } catch (e) {}
  }
}

function openAddToPlaylistModal(track) {
  pendingAddToPlaylistTrack = track;
  addPlaylistSongTitle.innerText = `"${track.title}" by ${track.artist}`;
  targetPlaylistsList.innerHTML = '';

  if (userPlaylists.length === 0) {
    targetPlaylistsList.innerHTML = `
      <p style="color: #888; text-align: center; padding: 15px;">No playlists found.</p>
      <button type="button" onclick="document.getElementById('add-to-playlist-modal').classList.add('hidden'); document.getElementById('create-playlist-btn').click();" class="submit-btn">
        <i class="fa-solid fa-plus"></i> Create New Playlist First
      </button>
    `;
  } else {
    userPlaylists.forEach(pl => {
      const btn = document.createElement('div');
      btn.classList.add('target-pl-item');
      btn.innerHTML = `
        <span><i class="fa-solid fa-folder"></i> ${pl.name}</span>
        <span style="font-size: 12px; color: #999;">${pl.songs ? pl.songs.length : 0} tracks</span>
      `;
      btn.addEventListener('click', (e) => {
        if (e) e.stopPropagation();
        addTrackToPlaylist(pl.id, pl.name, track);
      });
      targetPlaylistsList.appendChild(btn);
    });
  }

  addToPlaylistModal.classList.remove('hidden');
}

closeAddPlaylistBtn.addEventListener('click', (e) => {
  if (e) { e.preventDefault(); e.stopPropagation(); }
  addToPlaylistModal.classList.add('hidden');
});

async function addTrackToPlaylist(playlistId, playlistName, track) {
  const pl = userPlaylists.find(p => p.id === playlistId);
  if (!pl) return;
  if (!pl.songs) pl.songs = [];

  if (pl.songs.some(s => s.src === track.src)) {
    showToast(`Already in "${playlistName}"`, 'info');
    addToPlaylistModal.classList.add('hidden');
    return;
  }

  pl.songs.push(track);
  localStorage.setItem(PLAYLISTS_KEY, JSON.stringify(userPlaylists));
  renderUserPlaylists();

  const currentUser = getCurrentUser();
  if (currentUser && currentUser.email) {
    try {
      await fetch(`${API_BASE}/api/user/playlists/add-song`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: currentUser.email, playlistId, track })
      });
    } catch (e) {}
  }

  addToPlaylistModal.classList.add('hidden');
  showToast(`Added to "${playlistName}"!`, 'success');
}









// ==========================================
// 15. GLOBAL POPUP / MODAL BEHAVIOR
// Clicks on backdrop close modal; clicks inside card stay inside
// Audio continues playing uninterrupted when any popup is opened or closed
// ==========================================
document.querySelectorAll('.modal-overlay').forEach((overlay) => {
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      overlay.classList.add('hidden');
    }
  });
});

document.querySelectorAll('.modal-card').forEach((card) => {
  card.addEventListener('click', (e) => {
    e.stopPropagation();
  });
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-overlay').forEach((m) => m.classList.add('hidden'));
    closeMobileSidebar();
  }
});

// ==========================================
// 16. MOBILE DRAWER NAVIGATION
// ==========================================
const mobileMenuBtn = document.getElementById('mobile-menu-btn');
const closeSidebarBtn = document.getElementById('close-sidebar-btn');
const sidebarEl = document.getElementById('sidebar');
const sidebarOverlay = document.getElementById('sidebar-overlay');

function openMobileSidebar() {
  if (sidebarEl) sidebarEl.classList.add('open');
  if (sidebarOverlay) sidebarOverlay.classList.remove('hidden');
}

function closeMobileSidebar() {
  if (sidebarEl) sidebarEl.classList.remove('open');
  if (sidebarOverlay) sidebarOverlay.classList.add('hidden');
}

if (mobileMenuBtn) mobileMenuBtn.addEventListener('click', openMobileSidebar);
if (closeSidebarBtn) closeSidebarBtn.addEventListener('click', closeMobileSidebar);
if (sidebarOverlay) sidebarOverlay.addEventListener('click', closeMobileSidebar);

if (sidebarEl) {
  sidebarEl.querySelectorAll('a, li').forEach((item) => {
    item.addEventListener('click', () => {
      if (window.innerWidth <= 768) {
        closeMobileSidebar();
      }
    });
  });
}

// ==========================================
// 17. RECENTLY PLAYED HISTORY
// ==========================================
const RECENT_HISTORY_KEY = 'spotify_recently_played_history';

function getRecentlyPlayed() {
  try {
    return JSON.parse(localStorage.getItem(RECENT_HISTORY_KEY)) || [];
  } catch (e) {
    return [];
  }
}

function addToRecentlyPlayed(track) {
  if (!track || !track.title) return;
  let history = getRecentlyPlayed();
  history = history.filter((s) => s.id !== track.id && s.title !== track.title);
  history.unshift({
    ...track,
    playedAt: Date.now()
  });
  if (history.length > 50) history = history.slice(0, 50);
  try {
    localStorage.setItem(RECENT_HISTORY_KEY, JSON.stringify(history));
  } catch (e) {}
}

function renderRecentlyPlayed() {
  sectionTitle.innerHTML = `
    <span>Recently Played History</span>
    <button class="history-clear-btn" id="btn-clear-history"><i class="fa-solid fa-trash-can"></i> Clear History</button>
  `;
  document.querySelectorAll('.nav-menu a, .fixed-playlists li').forEach((el) => el.classList.remove('active'));
  const navHist = document.getElementById('nav-history');
  if (navHist) navHist.classList.add('active');

  const history = getRecentlyPlayed();
  if (history.length === 0) {
    trackGrid.innerHTML = `
      <div style="grid-column: 1/-1; text-align: center; padding: 50px 0; color: #b3b3b3;">
        <i class="fa-solid fa-clock-rotate-left" style="font-size: 2.5rem; margin-bottom: 12px; color: #555; display: block;"></i>
        <p>No recently played songs yet.</p>
        <p style="font-size: 13px; color: #777; margin-top: 5px;">Songs you listen to will appear here automatically!</p>
      </div>
    `;
    return;
  }

  trackList = history;
  renderTracks();

  const clearBtn = document.getElementById('btn-clear-history');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      localStorage.removeItem(RECENT_HISTORY_KEY);
      showToast('Listening history cleared', 'info');
      renderRecentlyPlayed();
    });
  }
}

const navHistoryBtn = document.getElementById('nav-history');
if (navHistoryBtn) {
  navHistoryBtn.addEventListener('click', renderRecentlyPlayed);
}

// ==========================================
// 18. LIVE SYNCED LYRICS ( बोल / लिरिक्स )
// ==========================================
const lyricsBtn = document.getElementById('lyrics-btn');
const lyricsModal = document.getElementById('lyrics-modal');
const closeLyricsBtn = document.getElementById('close-lyrics-btn');
const lyricsContainer = document.getElementById('lyrics-container');
const lyricsTitle = document.getElementById('lyrics-title');
const lyricsArtist = document.getElementById('lyrics-artist');
const lyricsCoverArt = document.getElementById('lyrics-cover-art');
const lyricsStatusBadge = document.getElementById('lyrics-status-badge');
const lyricsTranslateBtn = document.getElementById('lyrics-translate-btn');

let currentLyricsData = null;
let isLyricsTranslationActive = false;

function parseLrc(lrcText) {
  if (!lrcText) return [];
  const lines = lrcText.split('\n');
  const result = [];
  const timeRegex = /\[(\d{2}):(\d{2})\.(\d{2,3})\]/;

  for (const line of lines) {
    const match = timeRegex.exec(line);
    if (match) {
      const minutes = parseInt(match[1], 10);
      const seconds = parseInt(match[2], 10);
      const milliseconds = parseInt(match[3].padEnd(3, '0').slice(0, 3), 10);
      const timeInSec = minutes * 60 + seconds + milliseconds / 1000;
      const text = line.replace(/\[\d{2}:\d{2}\.\d{2,3}\]/g, '').trim();
      if (text) {
        result.push({ time: timeInSec, text });
      }
    }
  }
  return result.sort((a, b) => a.time - b.time);
}

async function fetchLyricsForTrack(track) {
  if (!track || !track.title) return;
  if (lyricsTitle) lyricsTitle.innerText = track.title;
  if (lyricsArtist) lyricsArtist.innerText = track.artist || 'Unknown';
  if (lyricsCoverArt && track.cover) lyricsCoverArt.src = track.cover;

  isLyricsTranslationActive = false;
  if (lyricsTranslateBtn) {
    lyricsTranslateBtn.classList.remove('active');
    lyricsTranslateBtn.innerHTML = '<i class="fa-solid fa-language"></i> Meaning (अर्थ)';
  }

  if (lyricsContainer) {
    lyricsContainer.innerHTML = `
      <div class="lyrics-loading">
        <i class="fa-solid fa-spinner fa-spin"></i>
        <p>Fetching real-time lyrics for "${escapeHtml(track.title)}"...</p>
      </div>
    `;
  }

  try {
    const res = await fetch(`${API_BASE}/api/lyrics?title=${encodeURIComponent(track.title)}&artist=${encodeURIComponent(track.artist || '')}`);
    const data = await res.json();

    if (data.success && data.syncedLyrics) {
      const parsed = parseLrc(data.syncedLyrics);
      currentLyricsData = { isSynced: true, parsedLines: parsed, plainLyrics: null, translations: null };
      renderSyncedLyrics(parsed);
      if (lyricsStatusBadge) {
        lyricsStatusBadge.innerHTML = '<i class="fa-solid fa-bolt"></i> Real-time Synced';
        lyricsStatusBadge.style.color = '#1db954';
      }
    } else if (data.success && data.plainLyrics) {
      currentLyricsData = { isSynced: false, parsedLines: [], plainLyrics: data.plainLyrics, translations: null };
      if (lyricsContainer) {
        lyricsContainer.innerHTML = `<div class="plain-lyrics-view">${escapeHtml(data.plainLyrics)}</div>`;
      }
      if (lyricsStatusBadge) {
        lyricsStatusBadge.innerHTML = '<i class="fa-regular fa-file-lines"></i> Plain Lyrics';
        lyricsStatusBadge.style.color = '#f59e0b';
      }
    } else {
      throw new Error('No lyrics found');
    }
  } catch (err) {
    currentLyricsData = null;
    if (lyricsContainer) {
      lyricsContainer.innerHTML = `
        <div class="plain-lyrics-view" style="color: #888;">
          🎵 Now playing: <b>${escapeHtml(track.title)}</b><br><br>
          Lyrics currently not available for this song version.<br>
          Sing along with the groove! 🎶
        </div>
      `;
    }
  }
}

function renderSyncedLyrics(parsedLines) {
  if (!lyricsContainer) return;
  lyricsContainer.innerHTML = '';
  parsedLines.forEach((item, index) => {
    const div = document.createElement('div');
    div.classList.add('lyric-line');
    div.id = `lyric-line-${index}`;

    if (isLyricsTranslationActive && currentLyricsData && currentLyricsData.translations && currentLyricsData.translations[index]) {
      div.innerHTML = `
        <div class="lyric-orig">${escapeHtml(item.text)}</div>
        <div class="lyric-trans">✨ ${escapeHtml(currentLyricsData.translations[index])}</div>
      `;
    } else {
      div.innerText = item.text;
    }

    div.addEventListener('click', () => {
      audio.currentTime = item.time;
      if (!isPlaying) playAudio();
    });
    lyricsContainer.appendChild(div);
  });
}

function updateSyncedLyrics(currentTime) {
  if (!currentLyricsData || !currentLyricsData.isSynced || !currentLyricsData.parsedLines || !currentLyricsData.parsedLines.length) return;
  const lines = currentLyricsData.parsedLines;
  let activeIndex = -1;

  for (let i = 0; i < lines.length; i++) {
    if (currentTime >= lines[i].time) {
      activeIndex = i;
    } else {
      break;
    }
  }

  if (activeIndex !== -1 && lyricsContainer) {
    const prevActive = lyricsContainer.querySelector('.lyric-line.active');
    const newActive = document.getElementById(`lyric-line-${activeIndex}`);

    if (newActive && prevActive !== newActive) {
      if (prevActive) prevActive.classList.remove('active');
      newActive.classList.add('active');
      newActive.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }
}

if (lyricsTranslateBtn) {
  lyricsTranslateBtn.addEventListener('click', async () => {
    if (!currentLyricsData || (!currentLyricsData.isSynced && !currentLyricsData.plainLyrics)) {
      showToast('No lyrics available to translate', 'info');
      return;
    }

    if (isLyricsTranslationActive) {
      isLyricsTranslationActive = false;
      lyricsTranslateBtn.classList.remove('active');
      lyricsTranslateBtn.innerHTML = '<i class="fa-solid fa-language"></i> Meaning (अर्थ)';
      if (currentLyricsData.isSynced) {
        renderSyncedLyrics(currentLyricsData.parsedLines);
      } else if (currentLyricsData.plainLyrics && lyricsContainer) {
        lyricsContainer.innerHTML = `<div class="plain-lyrics-view">${escapeHtml(currentLyricsData.plainLyrics)}</div>`;
      }
      return;
    }

    // Activate translation
    if (!currentLyricsData.translations) {
      lyricsTranslateBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Translating...';
      lyricsTranslateBtn.disabled = true;

      try {
        let linesToTranslate = [];
        if (currentLyricsData.isSynced) {
          linesToTranslate = currentLyricsData.parsedLines.map(l => l.text);
        } else if (currentLyricsData.plainLyrics) {
          linesToTranslate = currentLyricsData.plainLyrics.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        }

        const res = await fetch(`${API_BASE}/api/lyrics/translate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lines: linesToTranslate, targetLang: 'hi' })
        });
        const data = await res.json();
        const transList = data.translatedLines || data.translations;
        if (data.success && Array.isArray(transList)) {
          currentLyricsData.translations = transList;
        } else {
          throw new Error(data.error || 'Translation failed');
        }
      } catch (err) {
        console.error('Translation error:', err);
        showToast('Translation service unavailable. Please try again.', 'error');
        lyricsTranslateBtn.innerHTML = '<i class="fa-solid fa-language"></i> Meaning (अर्थ)';
        lyricsTranslateBtn.disabled = false;
        return;
      }
      lyricsTranslateBtn.disabled = false;
    }

    isLyricsTranslationActive = true;
    lyricsTranslateBtn.classList.add('active');
    lyricsTranslateBtn.innerHTML = '<i class="fa-solid fa-check"></i> Meaning ON';

    if (currentLyricsData.isSynced) {
      renderSyncedLyrics(currentLyricsData.parsedLines);
    } else if (currentLyricsData.translations && lyricsContainer) {
      lyricsContainer.innerHTML = `
        <div class="plain-lyrics-view">
          ${currentLyricsData.translations.map(t => `<p style="margin: 8px 0; color: #86efac; font-size: 15px;">✨ ${escapeHtml(t)}</p>`).join('')}
        </div>
      `;
    }
  });
}

if (lyricsBtn) {
  lyricsBtn.addEventListener('click', () => {
    const cur = trackList[currentTrackIndex];
    if (cur) {
      fetchLyricsForTrack(cur);
    }
    lyricsModal.classList.remove('hidden');
  });
}
if (closeLyricsBtn) {
  closeLyricsBtn.addEventListener('click', () => {
    lyricsModal.classList.add('hidden');
  });
}

// ==========================================
// 19. PWA (PROGRESSIVE WEB APP)
// ==========================================
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js').catch((err) => {
      console.log('SW note:', err.message);
    });
  });
}

let deferredPwaPrompt = null;
const pwaInstallBtn = document.getElementById('pwa-install-btn');

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPwaPrompt = e;
  if (pwaInstallBtn) pwaInstallBtn.classList.remove('hidden');
});

if (pwaInstallBtn) {
  pwaInstallBtn.addEventListener('click', async () => {
    if (deferredPwaPrompt) {
      deferredPwaPrompt.prompt();
      const choice = await deferredPwaPrompt.userChoice;
      if (choice.outcome === 'accepted') {
        showToast('🎉 Spotify app installed successfully!', 'success');
      }
      deferredPwaPrompt = null;
      pwaInstallBtn.classList.add('hidden');
    } else {
      showToast('Tip: Use browser menu to "Install Spotify / Add to Home screen" 📲', 'info');
    }
  });
}

// ==========================================
// 20. DJ CROSSFADE TRANSITION
// ==========================================
const crossfadeSlider = document.getElementById('crossfade-slider');
const crossfadeValLabel = document.getElementById('crossfade-val-label');
let crossfadeDuration = parseInt(localStorage.getItem('spotify_crossfade_duration') || '0', 10);
let isCrossfading = false;

if (crossfadeSlider && crossfadeValLabel) {
  crossfadeSlider.value = crossfadeDuration;
  crossfadeValLabel.innerText = crossfadeDuration > 0 ? `${crossfadeDuration}s` : '0s (Off)';

  crossfadeSlider.addEventListener('input', (e) => {
    crossfadeDuration = parseInt(e.target.value, 10);
    localStorage.setItem('spotify_crossfade_duration', crossfadeDuration);
    crossfadeValLabel.innerText = crossfadeDuration > 0 ? `${crossfadeDuration}s` : '0s (Off)';
  });
}

function handleCrossfadeTransition() {
  if (isCrossfading || crossfadeDuration <= 0) return;
  isCrossfading = true;

  const initialVolume = audio.volume;
  const fadeSteps = 10;
  const stepTime = (crossfadeDuration * 1000) / fadeSteps;
  let currentStep = 0;

  const fadeInterval = setInterval(() => {
    currentStep++;
    const stepVolume = Math.max(0, initialVolume * (1 - currentStep / fadeSteps));
    audio.volume = stepVolume;

    if (currentStep >= fadeSteps) {
      clearInterval(fadeInterval);
      audio.volume = initialVolume;
      isCrossfading = false;
      playNextTrack();
    }
  }, stepTime);
}

// ==========================================
// 21. AI SMART PLAYLIST GENERATOR
// ==========================================
const openAiPlaylistBtn = document.getElementById('open-ai-playlist-btn');
const aiPlaylistModal = document.getElementById('ai-playlist-modal');
const closeAiPlaylistBtn = document.getElementById('close-ai-playlist-btn');
const aiPromptInput = document.getElementById('ai-prompt-input');
const aiGenerateBtn = document.getElementById('ai-generate-btn');
const aiLoading = document.getElementById('ai-loading');

if (openAiPlaylistBtn) {
  openAiPlaylistBtn.addEventListener('click', () => {
    aiPlaylistModal.classList.remove('hidden');
    if (aiPromptInput) aiPromptInput.focus();
  });
}
if (closeAiPlaylistBtn) {
  closeAiPlaylistBtn.addEventListener('click', () => {
    aiPlaylistModal.classList.add('hidden');
  });
}

document.querySelectorAll('.ai-chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    if (aiPromptInput) aiPromptInput.value = chip.getAttribute('data-idea');
    if (aiGenerateBtn) aiGenerateBtn.click();
  });
});

if (aiGenerateBtn) {
  aiGenerateBtn.addEventListener('click', async () => {
    const prompt = aiPromptInput ? aiPromptInput.value.trim() : '';
    if (!prompt) {
      showToast('Please enter a vibe, mood, or idea for the AI playlist!', 'info');
      return;
    }

    aiGenerateBtn.disabled = true;
    if (aiLoading) aiLoading.classList.remove('hidden');

    try {
      const res = await fetch(`${API_BASE}/api/ai-playlist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt })
      });
      const data = await res.json();

      if (data.success && data.songs && data.songs.length > 0) {
        trackList = data.songs;
        sectionTitle.innerText = data.title;
        renderTracks();
        loadTrack(0);
        playAudio();
        aiPlaylistModal.classList.add('hidden');
        showToast(`✨ Generated ${data.songs.length} tracks for "${prompt}"!`, 'success');
      } else {
        showToast('Could not find enough tracks for that prompt. Try another vibe!', 'error');
      }
    } catch (err) {
      showToast('Error generating AI playlist: ' + err.message, 'error');
    } finally {
      aiGenerateBtn.disabled = false;
      if (aiLoading) aiLoading.classList.add('hidden');
    }
  });
}

// ==========================================
// 22. LISTEN TOGETHER / PARTY ROOMS (Socket.io)
// ==========================================
let partySocket = null;
let activePartyRoomId = null;

const openPartyBtn = document.getElementById('open-party-btn');
const partyModal = document.getElementById('party-modal');
const closePartyBtn = document.getElementById('close-party-btn');
const partyJoinView = document.getElementById('party-join-view');
const partyActiveView = document.getElementById('party-active-view');
const btnCreatePartyRoom = document.getElementById('btn-create-party-room');
const btnJoinPartyRoom = document.getElementById('btn-join-party-room');
const partyRoomCodeInput = document.getElementById('party-room-code-input');
const partyActiveCode = document.getElementById('party-active-code');
const btnCopyRoomCode = document.getElementById('btn-copy-room-code');
const btnLeavePartyRoom = document.getElementById('btn-leave-party-room');
const partyUsersCount = document.getElementById('party-users-count');
const partyUsersList = document.getElementById('party-users-list');
const partyChatMessages = document.getElementById('party-chat-messages');
const partyChatForm = document.getElementById('party-chat-form');
const partyChatInput = document.getElementById('party-chat-input');

function initPartySocket() {
  if (partySocket || typeof io === 'undefined') return;

  partySocket = io();

  partySocket.on('room-state', (state) => {
    activePartyRoomId = state.roomId;
    if (partyActiveCode) partyActiveCode.innerText = state.roomId;
    if (partyUsersCount) partyUsersCount.innerText = state.users.length;
    if (partyUsersList) {
      partyUsersList.innerHTML = state.users
        .map((u) => `<li><i class="fa-solid fa-circle-user" style="color:#1db954;"></i> ${u}</li>`)
        .join('');
    }
    if (partyJoinView && partyActiveView) {
      partyJoinView.classList.add('hidden');
      partyActiveView.classList.remove('hidden');
    }
    if (state.currentTrack && (!audio.src || !trackList[currentTrackIndex] || trackList[currentTrackIndex].src !== state.currentTrack.src)) {
      trackList = [state.currentTrack, ...trackList.filter((t) => t.src !== state.currentTrack.src)];
      loadTrack(0);
      if (typeof state.currentTime === 'number') audio.currentTime = state.currentTime;
      if (state.isPlaying) playAudio();
    }
  });

  partySocket.on('playback-update', (data) => {
    if (data.track && (!audio.src || !trackList[currentTrackIndex] || trackList[currentTrackIndex].src !== data.track.src)) {
      trackList = [data.track, ...trackList.filter((t) => t.src !== data.track.src)];
      loadTrack(0);
    }
    if (typeof data.currentTime === 'number') {
      audio.currentTime = data.currentTime;
    }
    if (data.isPlaying && !isPlaying) {
      playAudio();
    } else if (!data.isPlaying && isPlaying) {
      pauseAudio();
    }
    showToast(`👥 ${data.from} synced playback`, 'info');
  });

  partySocket.on('party-chat-msg', (msg) => {
    if (partyChatMessages) {
      const msgEl = document.createElement('div');
      msgEl.classList.add('party-chat-msg');
      msgEl.innerHTML = `<b>${msg.from}:</b> ${msg.text} <small style="color:#888; float:right;">${msg.time}</small>`;
      partyChatMessages.appendChild(msgEl);
      partyChatMessages.scrollTop = partyChatMessages.scrollHeight;
    }
  });
}

if (openPartyBtn) {
  openPartyBtn.addEventListener('click', () => {
    initPartySocket();
    partyModal.classList.remove('hidden');
  });
}
if (closePartyBtn) {
  closePartyBtn.addEventListener('click', () => {
    partyModal.classList.add('hidden');
  });
}

if (btnCreatePartyRoom) {
  btnCreatePartyRoom.addEventListener('click', () => {
    initPartySocket();
    const newRoomCode = 'PARTY-' + Math.floor(1000 + Math.random() * 9000);
    const user = JSON.parse(sessionStorage.getItem('spotify_current_user') || '{}');
    partySocket.emit('join-room', {
      roomId: newRoomCode,
      userName: user.name || 'Host'
    });
    showToast(`🎉 Room ${newRoomCode} created! Share the code with friends.`, 'success');
  });
}

if (btnJoinPartyRoom) {
  btnJoinPartyRoom.addEventListener('click', () => {
    const code = partyRoomCodeInput.value.trim().toUpperCase();
    if (!code) {
      showToast('Please enter a room code!', 'error');
      return;
    }
    initPartySocket();
    const user = JSON.parse(sessionStorage.getItem('spotify_current_user') || '{}');
    partySocket.emit('join-room', {
      roomId: code,
      userName: user.name || 'Friend'
    });
  });
}

if (btnCopyRoomCode) {
  btnCopyRoomCode.addEventListener('click', () => {
    if (activePartyRoomId) {
      navigator.clipboard.writeText(activePartyRoomId);
      showToast(`Copied room code "${activePartyRoomId}" to clipboard!`, 'success');
    }
  });
}

if (btnLeavePartyRoom) {
  btnLeavePartyRoom.addEventListener('click', () => {
    if (partySocket) {
      partySocket.disconnect();
      partySocket = null;
    }
    activePartyRoomId = null;
    if (partyActiveView && partyJoinView) {
      partyActiveView.classList.add('hidden');
      partyJoinView.classList.remove('hidden');
    }
    showToast('Left party room', 'info');
  });
}

if (partyChatForm) {
  partyChatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = partyChatInput.value.trim();
    if (text && partySocket && activePartyRoomId) {
      partySocket.emit('send-party-chat', {
        roomId: activePartyRoomId,
        message: text
      });
      partyChatInput.value = '';
    }
  });
}

// ==========================================
// 23. FLOATING MINI-PLAYER (Picture-in-Picture)
// ==========================================
const pipBtn = document.getElementById('pip-btn');
const pipCanvas = document.getElementById('pip-canvas');
const pipVideo = document.getElementById('pip-video');

async function triggerPictureInPicture() {
  try {
    if (!pipCanvas || !pipVideo) return;
    const ctx = pipCanvas.getContext('2d');

    function drawPipFrame() {
      ctx.fillStyle = '#121212';
      ctx.fillRect(0, 0, 400, 400);

      const cur = trackList[currentTrackIndex] || { title: 'No Song Playing', artist: 'Spotify 2.0' };
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.src = cur.cover || 'icon.svg';

      img.onload = () => {
        ctx.drawImage(img, 40, 30, 320, 240);
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 20px sans-serif';
        ctx.fillText(cur.title.slice(0, 24), 40, 310);

        ctx.fillStyle = '#1db954';
        ctx.font = '16px sans-serif';
        ctx.fillText(cur.artist.slice(0, 28), 40, 340);

        ctx.fillStyle = '#333333';
        ctx.fillRect(40, 370, 320, 8);
        const pct = audio.duration ? audio.currentTime / audio.duration : 0;
        ctx.fillStyle = '#1db954';
        ctx.fillRect(40, 370, 320 * pct, 8);
      };
    }

    drawPipFrame();
    const stream = pipCanvas.captureStream(10);
    pipVideo.srcObject = stream;
    await pipVideo.play();
    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture();
    } else {
      await pipVideo.requestPictureInPicture();
      showToast('Floating Mini-Player opened! 🪟', 'success');
    }
  } catch (err) {
    showToast('Mini-player ready in browser PiP', 'info');
  }
}

if (pipBtn) {
  pipBtn.addEventListener('click', triggerPictureInPicture);
}

// ==========================================
// 24. FULL-SCREEN NEON AUDIO VISUALIZER
// ==========================================
const fullscreenVizBtn = document.getElementById('fullscreen-viz-btn');
const fullscreenVizOverlay = document.getElementById('fullscreen-viz-overlay');
const closeFullscreenVizBtn = document.getElementById('close-fullscreen-viz-btn');
const fullscreenVizCanvas = document.getElementById('fullscreen-viz-canvas');
const vizTitle = document.getElementById('viz-title');
const vizArtist = document.getElementById('viz-artist');
const vizCoverArt = document.getElementById('viz-cover-art');
const vizPlayBtn = document.getElementById('viz-play-btn');
const vizPrevBtn = document.getElementById('viz-prev-btn');
const vizNextBtn = document.getElementById('viz-next-btn');

let isFullscreenVizActive = false;
let vizAnimationId = null;

function updateVizMeta() {
  const cur = trackList[currentTrackIndex];
  if (!cur) return;
  if (vizTitle) vizTitle.innerText = cur.title;
  if (vizArtist) vizArtist.innerText = cur.artist;
  if (vizCoverArt && cur.cover) vizCoverArt.src = cur.cover;
  if (vizPlayBtn) {
    vizPlayBtn.innerHTML = isPlaying ? '<i class="fa-solid fa-pause"></i>' : '<i class="fa-solid fa-play"></i>';
  }
}

function startFullscreenViz() {
  if (!fullscreenVizCanvas) return;
  initVisualizer();
  isFullscreenVizActive = true;
  updateVizMeta();
  fullscreenVizOverlay.classList.remove('hidden');

  const canvas = fullscreenVizCanvas;
  const ctx = canvas.getContext('2d');

  function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  const bufferLength = analyser ? analyser.frequencyBinCount : 128;
  const dataArray = new Uint8Array(bufferLength);

  function draw() {
    if (!isFullscreenVizActive) return;
    vizAnimationId = requestAnimationFrame(draw);

    if (analyser) {
      analyser.getByteFrequencyData(dataArray);
    } else {
      for (let i = 0; i < bufferLength; i++) dataArray[i] = Math.random() * 60;
    }

    ctx.fillStyle = 'rgba(8, 8, 8, 0.25)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const centerX = canvas.width / 2;
    const centerY = canvas.height / 2;
    const radius = 130;

    const bars = 80;
    for (let i = 0; i < bars; i++) {
      const value = dataArray[i % bufferLength] || 10;
      const barHeight = (value / 255) * 120;
      const rad = ((Math.PI * 2) / bars) * i;

      const x1 = centerX + Math.cos(rad) * radius;
      const y1 = centerY + Math.sin(rad) * radius;
      const x2 = centerX + Math.cos(rad) * (radius + barHeight);
      const y2 = centerY + Math.sin(rad) * (radius + barHeight);

      const hue = (i / bars) * 360;
      ctx.strokeStyle = `hsl(${hue}, 85%, 55%)`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }
  }

  draw();
}

function stopFullscreenViz() {
  isFullscreenVizActive = false;
  if (vizAnimationId) cancelAnimationFrame(vizAnimationId);
  fullscreenVizOverlay.classList.add('hidden');
}

if (fullscreenVizBtn) fullscreenVizBtn.addEventListener('click', startFullscreenViz);
if (closeFullscreenVizBtn) closeFullscreenVizBtn.addEventListener('click', stopFullscreenViz);
if (vizPlayBtn) vizPlayBtn.addEventListener('click', () => { togglePlay(); updateVizMeta(); });
if (vizPrevBtn) vizPrevBtn.addEventListener('click', () => { playPrevTrack(); updateVizMeta(); });
if (vizNextBtn) vizNextBtn.addEventListener('click', () => { playNextTrack(); updateVizMeta(); });

// ==========================================
// 23. ARTIST PROFILE & DISCOGRAPHY VIEW
// ==========================================
let currentArtistTracks = [];

const artistProfileView = document.getElementById('artist-profile-view');
const artistBackBtn = document.getElementById('artist-back-btn');
const artistHeroName = document.getElementById('artist-hero-name');
const artistHeroImg = document.getElementById('artist-hero-img');
const artistHeroListeners = document.getElementById('artist-hero-listeners');
const artistPlayAllBtn = document.getElementById('artist-play-all-btn');
const artistShuffleBtn = document.getElementById('artist-shuffle-btn');
const artistTracksList = document.getElementById('artist-tracks-list');
const artistAlbumsGrid = document.getElementById('artist-albums-grid');
const artistAlbumsSection = document.getElementById('artist-albums-section');

function closeArtistProfile() {
  if (artistProfileView && !artistProfileView.classList.contains('hidden')) {
    artistProfileView.classList.add('hidden');
    const moodChipsContainer = document.querySelector('.mood-chips-container');
    const secTitle = document.getElementById('section-title');
    const trGrid = document.getElementById('track-grid');
    const musicSections = document.querySelectorAll('.music-section');
    if (moodChipsContainer) moodChipsContainer.style.display = '';
    if (secTitle) secTitle.style.display = '';
    if (trGrid) trGrid.classList.remove('hidden');
    musicSections.forEach(s => s.style.display = '');
  }
}

async function openArtistProfile(artistName) {
  if (!artistName || artistName === 'Unknown Artist' || artistName === 'Various Artists') return;

  // Clean artist name (if multiple comma separated, pick primary artist)
  const primaryArtist = artistName.split(',')[0].split('&')[0].trim();
  if (!primaryArtist) return;

  const moodChipsContainer = document.querySelector('.mood-chips-container');
  const secTitle = document.getElementById('section-title');
  const trGrid = document.getElementById('track-grid');
  const musicSections = document.querySelectorAll('.music-section');

  if (!artistProfileView) return;

  // Show profile, hide standard grid and header chips
  if (moodChipsContainer) moodChipsContainer.style.display = 'none';
  if (secTitle) secTitle.style.display = 'none';
  if (trGrid) trGrid.classList.add('hidden');
  musicSections.forEach(s => s.style.display = 'none');
  artistProfileView.classList.remove('hidden');

  // Scroll main container to top smoothly
  const mainContent = document.querySelector('.main-content');
  if (mainContent) mainContent.scrollTo({ top: 0, behavior: 'smooth' });

  // Initial skeleton / loading state
  if (artistHeroName) artistHeroName.innerText = primaryArtist;
  if (artistHeroListeners) artistHeroListeners.innerText = 'Fetching artist profile...';
  if (artistHeroImg) artistHeroImg.src = 'https://via.placeholder.com/300?text=' + encodeURIComponent(primaryArtist);

  if (artistTracksList) {
    artistTracksList.innerHTML = `
      <div style="padding: 25px; text-align: center; color: #888;">
        <i class="fa-solid fa-spinner fa-spin" style="font-size: 24px; color: #1db954;"></i>
        <p style="margin-top: 10px; font-size: 14px;">Loading top tracks and discography for ${escapeHtml(primaryArtist)}...</p>
      </div>
    `;
  }
  if (artistAlbumsGrid) {
    artistAlbumsGrid.innerHTML = `
      <div style="padding: 20px; text-align: center; color: #888;">
        <i class="fa-solid fa-spinner fa-spin"></i>
      </div>
    `;
  }

  try {
    const res = await fetch(`${API_BASE}/api/artist?name=${encodeURIComponent(primaryArtist)}`);
    const data = await res.json();

    if (!data.success || !data.artist) {
      throw new Error(data.error || 'Artist not found');
    }

    const artist = data.artist;
    currentArtistTracks = artist.topTracks || [];

    if (artistHeroName) artistHeroName.innerText = artist.name || primaryArtist;
    if (artistHeroImg) artistHeroImg.src = artist.image || 'https://via.placeholder.com/300';
    if (artistHeroListeners) {
      artistHeroListeners.innerText = artist.monthlyListeners ? `${artist.monthlyListeners} Monthly Listeners` : 'Top Trending Artist';
    }

    // Render Popular Tracks
    renderArtistTracks(currentArtistTracks);

    // Render Albums & Discography
    if (artist.albums && artist.albums.length > 0) {
      if (artistAlbumsSection) artistAlbumsSection.style.display = '';
      renderArtistAlbums(artist.albums, artist.name);
    } else {
      if (artistAlbumsSection) artistAlbumsSection.style.display = 'none';
    }

  } catch (err) {
    console.error('Failed to load artist:', err);
    if (artistHeroListeners) artistHeroListeners.innerText = 'Artist Discography';
    // Fallback: search tracks using general search
    try {
      const fallbackRes = await fetch(`${API_BASE}/api/search?q=${encodeURIComponent(primaryArtist)}`);
      const fallbackData = await fallbackRes.json();
      if (fallbackData.results && fallbackData.results.length > 0) {
        currentArtistTracks = fallbackData.results;
        renderArtistTracks(currentArtistTracks);
      } else {
        if (artistTracksList) artistTracksList.innerHTML = '<p style="color: #888; padding: 20px;">No tracks found for this artist.</p>';
      }
    } catch (e) {
      if (artistTracksList) artistTracksList.innerHTML = '<p style="color: #ef4444; padding: 20px;">Unable to load artist tracks right now.</p>';
    }
  }
}

function renderArtistTracks(tracks) {
  if (!artistTracksList) return;
  artistTracksList.innerHTML = '';

  if (!tracks || tracks.length === 0) {
    artistTracksList.innerHTML = '<p style="color: #888; padding: 20px;">No tracks available for this artist.</p>';
    return;
  }

  tracks.slice(0, 10).forEach((track, idx) => {
    const row = document.createElement('div');
    row.className = 'artist-track-row';
    row.title = `Play ${track.title}`;

    const durationStr = track.duration ? formatTime(track.duration) : '3:30';

    row.innerHTML = `
      <div class="artist-track-rank">${idx + 1}</div>
      <img src="${track.cover || 'https://via.placeholder.com/60'}" alt="${escapeHtml(track.title)}" onerror="this.src='https://via.placeholder.com/60'">
      <div class="artist-track-info">
        <h4>${escapeHtml(track.title)}</h4>
        <p>${escapeHtml(track.artist || '')}</p>
      </div>
      <div class="artist-track-duration">${durationStr}</div>
      <div class="artist-track-play" style="color: #1db954; font-size: 16px;">
        <i class="fa-solid fa-play"></i>
      </div>
    `;

    row.addEventListener('click', () => {
      trackList = [...tracks];
      currentTrackIndex = idx;
      loadTrack(currentTrackIndex);
      playAudio();
      showToast(`Playing "${track.title}" 🎵`, 'success');
    });

    artistTracksList.appendChild(row);
  });
}

function renderArtistAlbums(albums, artistName) {
  if (!artistAlbumsGrid) return;
  artistAlbumsGrid.innerHTML = '';

  albums.forEach((alb) => {
    const card = document.createElement('div');
    card.className = 'album-card';
    card.title = `Listen to ${alb.title}`;

    card.innerHTML = `
      <img src="${alb.cover || 'https://via.placeholder.com/300'}" alt="${escapeHtml(alb.title)}" onerror="this.src='https://via.placeholder.com/300'">
      <h4 style="font-size: 14px; font-weight: 700; color: #fff; margin-top: 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(alb.title)}</h4>
      <p style="font-size: 12px; color: #9ca3af; margin-top: 4px;">${escapeHtml(alb.year ? alb.year + ' • Album' : 'Album')}</p>
    `;

    card.addEventListener('click', () => {
      const searchInput = document.getElementById('search-input');
      if (searchInput) searchInput.value = alb.title;
      closeArtistProfile();
      fetchOnlineSongs(alb.title);
      showToast(`Loading album "${alb.title}"...`, 'info');
    });

    artistAlbumsGrid.appendChild(card);
  });
}

if (artistBackBtn) {
  artistBackBtn.addEventListener('click', closeArtistProfile);
}

if (artistPlayAllBtn) {
  artistPlayAllBtn.addEventListener('click', () => {
    if (currentArtistTracks && currentArtistTracks.length > 0) {
      trackList = [...currentArtistTracks];
      currentTrackIndex = 0;
      loadTrack(0);
      playAudio();
      showToast(`Playing Top Hits! 🎶`, 'success');
    }
  });
}

if (artistShuffleBtn) {
  artistShuffleBtn.addEventListener('click', () => {
    if (currentArtistTracks && currentArtistTracks.length > 0) {
      const shuffled = [...currentArtistTracks].sort(() => Math.random() - 0.5);
      trackList = shuffled;
      currentTrackIndex = 0;
      loadTrack(0);
      playAudio();
      showToast(`Shuffling artist hits! 🔀`, 'info');
    }
  });
}

// Click on Artist name in bottom player bar opens Artist Profile
const bottomTrackArtist = document.getElementById('track-artist');
if (bottomTrackArtist) {
  bottomTrackArtist.style.cursor = 'pointer';
  bottomTrackArtist.title = 'View Artist Profile';
  bottomTrackArtist.addEventListener('click', () => {
    const name = bottomTrackArtist.innerText.trim();
    if (name && name !== 'Artist Name' && name !== 'Unknown' && name !== 'Select a song') {
      openArtistProfile(name);
    }
  });
}

// ==========================================
// 24. MOBILE HORIZONTAL SWIPE GESTURE SUPPORT
// ==========================================
function initSliderTouchGestures() {
  const sliders = document.querySelectorAll('.cards-container, .music-row');
  sliders.forEach((slider) => {
    let startX = 0;
    let startY = 0;

    slider.addEventListener('touchstart', (e) => {
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
    }, { passive: true });

    slider.addEventListener('touchmove', (e) => {
      let touchX = e.touches[0].clientX;
      let touchY = e.touches[0].clientY;

      let diffX = startX - touchX;
      let diffY = startY - touchY;

      // Agar user left ya right swipe kar raha hai, toh browser ko upar-niche scroll karne se roko
      if (Math.abs(diffX) > Math.abs(diffY)) {
        // Left / Right drag detect hua
      }
    }, { passive: true });
  });
}

initSliderTouchGestures();

// ==========================================
// 25. EXPANDABLE SPOTIFY FULLSCREEN POPUP PLAYER & CATEGORY PILLS
// ==========================================
let isFsScrubbing = false;

const fullscreenPlayerModal = document.getElementById('fullscreen-player-modal');
const closeFullscreenPlayerBtn = document.getElementById('close-fullscreen-player-btn');
const expandPlayerBtn = document.getElementById('expand-player-btn');
const miniNowPlaying = document.getElementById('mini-now-playing');
const fsPlayerBackdrop = document.getElementById('fs-player-backdrop');

const fsCoverArt = document.getElementById('fs-cover-art');
const fsTrackTitle = document.getElementById('fs-track-title');
const fsTrackArtist = document.getElementById('fs-track-artist');
const fsHeartBtn = document.getElementById('fs-heart-btn');
const miniHeartBtn = document.getElementById('mini-heart-btn');
const fsPlaylistName = document.getElementById('fs-playlist-name');

const fsProgressBar = document.getElementById('fs-progress-bar');
const fsCurrentTime = document.getElementById('fs-current-time');
const fsTotalTime = document.getElementById('fs-total-time');

const fsPlayBtn = document.getElementById('fs-play-btn');
const fsPrevBtn = document.getElementById('fs-prev-btn');
const fsNextBtn = document.getElementById('fs-next-btn');
const fsShuffleBtn = document.getElementById('fs-shuffle-btn');
const fsRepeatBtn = document.getElementById('fs-repeat-btn');
const fsRepeatBadge = document.getElementById('fs-repeat-badge');

const fsLyricsBtn = document.getElementById('fs-lyrics-btn');
const fsEightDBtn = document.getElementById('fs-eight-d-btn');
const fsShareBtn = document.getElementById('fs-share-btn');

function openFullscreenPlayer() {
  if (!fullscreenPlayerModal) return;
  syncFullscreenPlayerUI();
  fullscreenPlayerModal.classList.add('open');
  fullscreenPlayerModal.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
}

function closeFullscreenPlayer() {
  if (!fullscreenPlayerModal) return;
  fullscreenPlayerModal.classList.remove('open');
  fullscreenPlayerModal.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
}

function syncFullscreenPlayerUI() {
  const cur = trackList[currentTrackIndex];
  if (!cur) return;

  if (fsTrackTitle) fsTrackTitle.innerText = cur.title || 'Select a Song';
  if (fsTrackArtist) fsTrackArtist.innerText = cur.artist || 'Artist Name';
  if (fsCoverArt) fsCoverArt.src = cur.cover || 'https://via.placeholder.com/500';
  if (fsPlaylistName && sectionTitle) {
    fsPlaylistName.innerText = sectionTitle.innerText.replace(/Search Results for /gi, '') || 'Top Trending Hits';
  }

  // Sync Likes
  const isLiked = getLikedSongs().some(s => s.src === cur.src);
  if (fsHeartBtn) {
    fsHeartBtn.innerHTML = isLiked ? '<i class="fa-solid fa-heart" style="color: #1db954;"></i>' : '<i class="fa-regular fa-heart"></i>';
  }
  if (miniHeartBtn) {
    miniHeartBtn.innerHTML = isLiked ? '<i class="fa-solid fa-heart" style="color: #1db954;"></i>' : '<i class="fa-regular fa-heart"></i>';
  }

  // Sync Play/Pause
  if (fsPlayBtn) {
    fsPlayBtn.innerHTML = isPlaying ? '<i class="fa-solid fa-pause"></i>' : '<i class="fa-solid fa-play"></i>';
  }

  // Sync Shuffle
  if (fsShuffleBtn) {
    if (isShuffle) fsShuffleBtn.classList.add('active');
    else fsShuffleBtn.classList.remove('active');
  }

  // Sync Repeat
  if (fsRepeatBtn) {
    if (repeatMode > 0) fsRepeatBtn.classList.add('active');
    else fsRepeatBtn.classList.remove('active');
    if (fsRepeatBadge) {
      if (repeatMode === 2) {
        fsRepeatBadge.classList.remove('hidden');
        fsRepeatBadge.innerText = '1';
      } else {
        fsRepeatBadge.classList.add('hidden');
      }
    }
  }

  // Sync Time & Scrub Bar
  if (audio.duration && !isNaN(audio.duration)) {
    const pct = (audio.currentTime / audio.duration) * 100;
    if (fsProgressBar && !isFsScrubbing) fsProgressBar.value = pct;
    if (fsCurrentTime) fsCurrentTime.innerText = formatTime(audio.currentTime);
    if (fsTotalTime) fsTotalTime.innerText = formatTime(audio.duration);
  }
}

// Open/Close triggers
if (miniNowPlaying) {
  miniNowPlaying.addEventListener('click', (e) => {
    if (e.target.closest('#mini-heart-btn') || e.target.closest('.visualizer-canvas')) return;
    openFullscreenPlayer();
  });
}

if (expandPlayerBtn) {
  expandPlayerBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openFullscreenPlayer();
  });
}

if (closeFullscreenPlayerBtn) {
  closeFullscreenPlayerBtn.addEventListener('click', closeFullscreenPlayer);
}

if (fsPlayerBackdrop) {
  fsPlayerBackdrop.addEventListener('click', closeFullscreenPlayer);
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && fullscreenPlayerModal && fullscreenPlayerModal.classList.contains('open')) {
    closeFullscreenPlayer();
  }
});

// Fullscreen Playback Controls
if (fsPlayBtn) fsPlayBtn.addEventListener('click', togglePlay);
if (fsPrevBtn) fsPrevBtn.addEventListener('click', playPrevTrack);
if (fsNextBtn) fsNextBtn.addEventListener('click', playNextTrack);
if (fsShuffleBtn) {
  fsShuffleBtn.addEventListener('click', () => {
    shuffleBtn.click();
    syncFullscreenPlayerUI();
  });
}
if (fsRepeatBtn) {
  fsRepeatBtn.addEventListener('click', () => {
    repeatBtn.click();
    syncFullscreenPlayerUI();
  });
}

// Fullscreen Scrubbing
if (fsProgressBar) {
  fsProgressBar.addEventListener('input', () => {
    isFsScrubbing = true;
    if (audio.duration && !isNaN(audio.duration)) {
      const seekTime = (fsProgressBar.value / 100) * audio.duration;
      if (fsCurrentTime) fsCurrentTime.innerText = formatTime(seekTime);
    }
  });

  fsProgressBar.addEventListener('change', () => {
    isFsScrubbing = false;
    if (audio.duration && !isNaN(audio.duration)) {
      audio.currentTime = (fsProgressBar.value / 100) * audio.duration;
      progressBar.value = fsProgressBar.value;
    }
  });
}

// Like toggle for current song
function toggleCurrentSongLike() {
  const cur = trackList[currentTrackIndex];
  if (!cur) return;
  let likedSongs = getLikedSongs();
  const existsIndex = likedSongs.findIndex(s => s.src === cur.src);
  if (existsIndex > -1) {
    likedSongs.splice(existsIndex, 1);
    localStorage.setItem(LIKED_KEY, JSON.stringify(likedSongs));
    showToast(`Removed "${cur.title}" from Liked Songs`, 'info');
  } else {
    likedSongs.unshift(cur);
    localStorage.setItem(LIKED_KEY, JSON.stringify(likedSongs));
    showToast(`Added to Liked Songs ❤️`, 'heart');
  }
  syncFullscreenPlayerUI();
  renderTracks();
}

if (fsHeartBtn) fsHeartBtn.addEventListener('click', toggleCurrentSongLike);
if (miniHeartBtn) {
  miniHeartBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleCurrentSongLike();
  });
}

// Fullscreen Quick Actions
if (fsLyricsBtn) {
  fsLyricsBtn.addEventListener('click', () => {
    if (lyricsBtn) lyricsBtn.click();
  });
}
if (fsEightDBtn) {
  fsEightDBtn.addEventListener('click', () => {
    const eightDBtn = document.getElementById('eight-d-btn');
    if (eightDBtn) {
      eightDBtn.click();
      if (eightDBtn.classList.contains('active')) {
        fsEightDBtn.classList.add('active');
      } else {
        fsEightDBtn.classList.remove('active');
      }
    }
  });
}
if (fsShareBtn) {
  fsShareBtn.addEventListener('click', () => {
    const shareCurrentBtn = document.getElementById('share-current-btn');
    if (shareCurrentBtn) shareCurrentBtn.click();
  });
}

// Main Category Filter Pills ('All', 'Music', 'Podcasts')
const mainFilterPills = document.querySelectorAll('.main-filter-pill');
mainFilterPills.forEach((pill) => {
  pill.addEventListener('click', () => {
    if (typeof closeArtistProfile === 'function') closeArtistProfile();
    mainFilterPills.forEach(p => p.classList.remove('active'));
    pill.classList.add('active');
    const cat = pill.dataset.category;
    if (cat === 'all') {
      sectionTitle.innerText = "Trending Tracks";
      fetchOnlineSongs("Top Hits");
    } else if (cat === 'music') {
      sectionTitle.innerText = "Trending Music & Hits";
      fetchOnlineSongs("Trending Bollywood & Pop Hits");
    } else if (cat === 'podcasts') {
      sectionTitle.innerText = "Top Podcasts & Stories";
      fetchOnlineSongs("Top Hindi Podcasts & Audio Stories");
    }
  });
});

// Initializations
checkAuthState();
restoreInitialPlayerUI();
fetchOnlineSongs("Top Hits");

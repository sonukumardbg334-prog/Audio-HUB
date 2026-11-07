# Spotify Music Streaming App (Full-Stack)

A full-stack Spotify web application with **full-length song streaming (No 30-second restriction)**, user authentication, personal library, and liked songs persistence.

## 🚀 Why songs were stopping after 30 seconds:
Previously, the frontend was querying the Apple iTunes Search API directly (`item.previewUrl`). Apple only provides a 30-second promotional snippet for free previews.

## ✨ Solution implemented:
We built and integrated a **Node.js + Express backend server** (`server.js`):
1. **Full-Length Audio Streaming**: Fetches high-quality (160kbps/320kbps) full audio streams via decrypted CDN media URLs. Songs now play in their entirety (3 to 6+ minutes).
2. **REST APIs**:
   - `GET /api/search?q=<query>`: Searches songs across Bollywood, English, Punjabi, etc., returning full tracks.
   - `GET /api/trending`: Returns top trending songs.
   - `POST /api/auth/signup`: User registration.
   - `POST /api/auth/login`: User login with persistent sessions.
   - `GET /api/user/data`: Loads user's liked songs and library history.
   - `POST /api/user/liked`: Adds or removes liked songs in persistent database.
   - `POST /api/user/library`: Records played songs into the user's library.
3. **Persistent JSON Database**: Stores user accounts and playlist data in `data/db.json`.
4. **Graceful Fallback**: If the server is not reachable, the frontend automatically falls back without crashing.

---

## 🛠️ How to Run:

### 1. Start the Server:
Open terminal in this project folder and run:
```bash
npm start
```
*(Or double-click `start-server.bat`)*

### 2. Open in Browser:
Visit:
```
http://localhost:3000
```
Now search for any song and enjoy full-length playback!


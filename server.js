// -------- server.js --------
require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const fetch = require('node-fetch');
const path = require('path');
const cookieParser = require('cookie-parser');
const bodyParser = require('body-parser');
const { v4: uuidv4 } = require('uuid');

const isProd = process.env.NODE_ENV === 'production';
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ...(isProd ? { ssl: { rejectUnauthorized: false } } : {})
});

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cookieParser());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

(async () => {
  const client = await pool.connect();
  await client.query(`
    CREATE TABLE IF NOT EXISTS videos (
      id VARCHAR(11) PRIMARY KEY,
      title TEXT,
      thumbnail_url TEXT,
      fetched_at TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS votes (
      session_id UUID,
      video_id VARCHAR(11),
      vote VARCHAR(7) CHECK(vote IN ('like','dislike')),
      PRIMARY KEY(session_id, video_id)
    );
    CREATE TABLE IF NOT EXISTS recommendations (
      id SERIAL PRIMARY KEY,
      session_id UUID,
      video_id VARCHAR(11),
      recommended_at TIMESTAMP DEFAULT NOW()
    );
  `);
  client.release();
  console.log('DB schema ready');
})().catch(console.error);

app.use((req, res, next) => {
  if (!req.cookies.session_id) {
    const sid = uuidv4();
    res.cookie('session_id', sid, { httpOnly: true });
    req.cookies.session_id = sid;
  }
  next();
});

async function fetchMetadata(id) {
  const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${id}&key=${process.env.YOUTUBE_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('YouTube API error');
  const data = await res.json();
  if (!data.items.length) throw new Error('Video not found');
  const snip = data.items[0].snippet;
  return { title: snip.title, thumbnail_url: snip.thumbnails.high?.url || snip.thumbnails.default.url };
}

app.get('/api/videos', async (req, res) => {
  const session = req.cookies.session_id;
  try {
    const client = await pool.connect();
    const { rows: vids } = await client.query('SELECT * FROM videos');
    const now = Date.now();
    for (const v of vids) {
      const stale = !v.fetched_at || (now - new Date(v.fetched_at).getTime() > 24*3600*1000);
      if (!v.title || stale) {
        try {
          const meta = await fetchMetadata(v.id);
          await client.query('UPDATE videos SET title=$1, thumbnail_url=$2, fetched_at=NOW() WHERE id=$3', [meta.title, meta.thumbnail_url, v.id]);
          v.title = meta.title;
          v.thumbnail_url = meta.thumbnail_url;
        } catch {}
      }
    }
    const ids = vids.map(v => v.id);
    const voteMap = {};
    if (ids.length) {
      const vr = await client.query(
        `SELECT video_id,
          COUNT(*) FILTER(WHERE vote='like') AS likes,
          COUNT(*) FILTER(WHERE vote='dislike') AS dislikes,
          MAX((session_id=$1 AND vote='like')::int) AS i_like,
          MAX((session_id=$1 AND vote='dislike')::int) AS i_dislike
         FROM votes WHERE video_id = ANY($2) GROUP BY video_id`,
        [session, ids]
      );
      vr.rows.forEach(r => voteMap[r.video_id] = r);
    }
    client.release();
    res.json(vids.map(v => ({ id: v.id, title: v.title, thumbnail_url: v.thumbnail_url, likes: voteMap[v.id]?.likes||0, dislikes: voteMap[v.id]?.dislikes||0, i_like: voteMap[v.id]?.i_like||0, i_dislike: voteMap[v.id]?.i_dislike||0 })));  }
  catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/videos', async (req, res) => {
  const { id } = req.body;
  if (!/^[\w-]{11}$/.test(id)) return res.status(400).json({ error: 'Invalid YouTube ID' });
  const session = req.cookies.session_id;
  try {
    const client = await pool.connect();
    await client.query('INSERT INTO videos(id) VALUES($1) ON CONFLICT DO NOTHING', [id]);
    await client.query('INSERT INTO recommendations(session_id,video_id) VALUES($1,$2)', [session,id]);
    client.release();
    res.status(201).json({id});
  } catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/videos/:id/vote', async (req, res) => { const {id} = req.params; const {vote} = req.body; const session = req.cookies.session_id; if(!['like','dislike'].includes(vote)) return res.status(400).json({error:'Invalid vote'}); try{ const client=await pool.connect(); await client.query(`INSERT INTO votes(session_id,video_id,vote) VALUES($1,$2,$3) ON CONFLICT(session_id,video_id) DO UPDATE SET vote=EXCLUDED.vote`,[session,id,vote]); const {rows} = await client.query(`SELECT COUNT(*) FILTER(WHERE vote='like') AS likes, COUNT(*) FILTER(WHERE vote='dislike') AS dislikes, MAX((session_id=$1 AND vote='like')::int) AS i_like, MAX((session_id=$1 AND vote='dislike')::int) AS i_dislike FROM votes WHERE video_id=$2 GROUP BY video_id`,[session,id]); client.release(); res.json(rows[0]);}catch(e){res.status(500).json({error:e.message});}});

app.get('/api/user/score', async (req,res)=>{const session=req.cookies.session_id;try{const client=await pool.connect();const{rows} = await client.query(`SELECT COALESCE(SUM(likes),0) AS score FROM (SELECT video_id, COUNT(*) FILTER(WHERE vote='like') AS likes FROM votes WHERE video_id IN (SELECT video_id FROM recommendations WHERE session_id=$1) GROUP BY video_id) t`,[session]);client.release();res.json({score:rows[0].score});}catch(e){res.status(500).json({error:e.message});}});

app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.listen(PORT,()=>console.log(`Listening on port ${PORT}`));
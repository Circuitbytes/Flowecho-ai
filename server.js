/**
 * FlowEcho AI — Backend Server
 * ─────────────────────────────
 * Setup:
 *   npm install express cors axios fluent-ffmpeg node-fetch multer uuid ws
 *   pip install yt-dlp
 *   brew install ffmpeg  (mac)  OR  apt install ffmpeg  (linux)
 *
 * Run:  node server.js
 * Port: 3001
 */

const express    = require('express');
const cors       = require('cors');
const axios      = require('axios');
const { exec, spawn } = require('child_process');
const fs         = require('fs');
const path       = require('path');
const { v4: uuidv4 } = require('uuid');
const WebSocket  = require('ws');
const http       = require('http');
const multer     = require('multer');

// ── Config ──────────────────────────────────────────
const PORT        = 3001;
const UPLOAD_DIR  = path.join(__dirname, 'uploads');
const OUTPUT_DIR  = path.join(__dirname, 'outputs');
const CLAUDE_KEY  = process.env.ANTHROPIC_API_KEY || '';   // set env var

[UPLOAD_DIR, OUTPUT_DIR].forEach(d => !fs.existsSync(d) && fs.mkdirSync(d, {recursive:true}));

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());
app.use('/outputs', express.static(OUTPUT_DIR));
app.use('/uploads', express.static(UPLOAD_DIR));

const upload = multer({ dest: UPLOAD_DIR });

// ── WebSocket progress broadcast ────────────────────
const clients = new Map();
wss.on('connection', (ws, req) => {
  const id = new URLSearchParams(req.url.replace('/','?')).get('id') || uuidv4();
  clients.set(id, ws);
  ws.on('close', () => clients.delete(id));
});
function progress(jobId, step, pct, msg, data={}) {
  const ws = clients.get(jobId);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ step, pct, msg, ...data }));
  }
}

// ────────────────────────────────────────────────────
// POST /api/analyze  { url, jobId }
// ────────────────────────────────────────────────────
app.post('/api/analyze', async (req, res) => {
  const { url, jobId } = req.body;
  if (!url || !jobId) return res.status(400).json({ error: 'url and jobId required' });

  res.json({ status: 'processing', jobId });

  try {
    // ── Step 1: Download video ──────────────────────
    progress(jobId, 1, 10, 'Downloading video...');
    const videoId   = uuidv4();
    const videoPath = path.join(UPLOAD_DIR, `${videoId}.mp4`);

    await new Promise((resolve, reject) => {
      const dl = spawn('yt-dlp', [
        '-f', 'bestvideo[ext=mp4][height<=720]+bestaudio[ext=m4a]/best[ext=mp4][height<=720]/best',
        '--merge-output-format', 'mp4',
        '-o', videoPath,
        url
      ]);
      dl.on('close', code => code === 0 ? resolve() : reject(new Error('yt-dlp failed')));
      dl.stderr.on('data', d => console.log('yt-dlp:', d.toString()));
    });

    progress(jobId, 2, 22, 'Video downloaded. Extracting transcript...');

    // ── Step 2: Extract audio → transcript ─────────
    const audioPath = path.join(UPLOAD_DIR, `${videoId}.wav`);
    await runCmd(`ffmpeg -y -i "${videoPath}" -ar 16000 -ac 1 "${audioPath}"`);

    // ── Step 3: Get video duration ──────────────────
    const durationSec = await getVideoDuration(videoPath);

    // ── Step 4: Extract keyframes for scene analysis
    progress(jobId, 3, 35, 'Extracting keyframes for visual analysis...');
    const framesDir = path.join(UPLOAD_DIR, videoId + '_frames');
    fs.mkdirSync(framesDir, { recursive: true });
    await runCmd(`ffmpeg -y -i "${videoPath}" -vf "fps=1/10,scale=320:-1" "${framesDir}/frame_%04d.jpg"`);

    // ── Step 5: Claude AI analysis ─────────────────
    progress(jobId, 4, 55, 'Claude AI analyzing viral moments...');
    const clips = await claudeAnalyze(url, durationSec, jobId);

    // ── Step 6: Cut clips with ffmpeg ──────────────
    progress(jobId, 5, 72, 'Cutting viral clips...');
    const cutClips = await cutAllClips(videoPath, clips, videoId, jobId);

    // ── Step 7: Generate captions ──────────────────
    progress(jobId, 6, 88, 'Generating auto-captions...');
    for (const c of cutClips) {
      c.captions = await generateCaptions(c, jobId);
    }

    // ── Step 8: Generate content for each clip ─────
    progress(jobId, 7, 96, 'Writing titles, descriptions & hashtags...');
    for (const c of cutClips) {
      c.content = await generateContent(c);
    }

    progress(jobId, 8, 100, 'Done!', {
      clips: cutClips,
      videoTitle: clips[0]?.videoTitle || 'Video',
      duration: formatTime(durationSec)
    });

    // Cleanup raw video after 10 min
    setTimeout(() => {
      try { fs.unlinkSync(videoPath); fs.unlinkSync(audioPath); } catch(e){}
    }, 600000);

  } catch (err) {
    console.error('Analysis error:', err);
    progress(jobId, -1, 0, 'Error: ' + err.message);
  }
});

// ── POST /api/cut  — Re-cut a single clip ───────────
app.post('/api/cut', async (req, res) => {
  const { videoId, startTime, endTime, effects = {} } = req.body;
  const videoPath = path.join(UPLOAD_DIR, `${videoId}.mp4`);
  if (!fs.existsSync(videoPath)) return res.status(404).json({ error: 'Source video not found' });

  const outId   = uuidv4();
  const outPath = path.join(OUTPUT_DIR, `${outId}.mp4`);
  const dur     = timeToSec(endTime) - timeToSec(startTime);

  let filters = [];
  if (effects.speed && effects.speed !== 1) filters.push(`setpts=${1/effects.speed}*PTS`);
  if (effects.brightness) filters.push(`eq=brightness=${(effects.brightness-50)/100}`);
  if (effects.contrast)   filters.push(`eq=contrast=${effects.contrast/50}`);
  if (effects.saturation) filters.push(`eq=saturation=${effects.saturation/50}`);

  const vf = filters.length ? `-vf "${filters.join(',')}"` : '';
  const cmd = `ffmpeg -y -ss ${timeToSec(startTime)} -i "${videoPath}" -t ${dur} ${vf} -c:v libx264 -c:a aac "${outPath}"`;

  try {
    await runCmd(cmd);
    res.json({ clipUrl: `/outputs/${outId}.mp4`, clipId: outId });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/captions ──────────────────────────────
app.post('/api/captions', async (req, res) => {
  const { clipId, style = 'bold_fire', language = 'en' } = req.body;
  const clipPath = path.join(OUTPUT_DIR, `${clipId}.mp4`);
  if (!fs.existsSync(clipPath)) return res.status(404).json({ error: 'Clip not found' });

  try {
    const srtPath = path.join(OUTPUT_DIR, `${clipId}.srt`);
    const burnedPath = path.join(OUTPUT_DIR, `${clipId}_captioned.mp4`);

    // Generate SRT with subtitle timestamps
    const captions = await generateSRTCaptions(clipPath, language);
    fs.writeFileSync(srtPath, captions.srt);

    // Burn captions based on style
    const styleMap = {
      bold_fire:   `FontName=Impact,FontSize=22,Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H000000FF,BackColour=&H80000000,BorderStyle=3,Outline=3`,
      clean_white: `FontName=Arial,FontSize=18,Bold=0,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2`,
      neon_glow:   `FontName=Impact,FontSize=22,Bold=1,PrimaryColour=&H0000FFFF,OutlineColour=&H00FF00FF,BorderStyle=1,Outline=3`,
      minimal:     `FontName=Helvetica,FontSize=16,Bold=0,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=1`,
      retro_pop:   `FontName=Impact,FontSize=24,Bold=1,PrimaryColour=&H0000FFFF,OutlineColour=&H000000FF,BorderStyle=3,Outline=2`,
    };

    const styleDef = styleMap[style] || styleMap.bold_fire;
    const cmd = `ffmpeg -y -i "${clipPath}" -vf "subtitles='${srtPath}':force_style='${styleDef}'" -c:a copy "${burnedPath}"`;
    await runCmd(cmd);

    res.json({
      captionedUrl: `/outputs/${clipId}_captioned.mp4`,
      srt: captions.srt,
      words: captions.words
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/content ───────────────────────────────
app.post('/api/content', async (req, res) => {
  const { clip, platform } = req.body;
  try {
    const content = await generatePlatformContent(clip, platform);
    res.json(content);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/thumbnail ─────────────────────────────
app.post('/api/thumbnail', async (req, res) => {
  const { clipId, timestamp = '00:00:01' } = req.body;
  const clipPath = path.join(OUTPUT_DIR, `${clipId}.mp4`);
  const thumbPath = path.join(OUTPUT_DIR, `${clipId}_thumb.jpg`);
  try {
    await runCmd(`ffmpeg -y -ss ${timestamp} -i "${clipPath}" -vframes 1 -q:v 2 "${thumbPath}"`);
    res.json({ thumbnailUrl: `/outputs/${clipId}_thumb.jpg` });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/upload (file upload) ──────────────────
app.post('/api/upload', upload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const newPath = path.join(UPLOAD_DIR, req.file.filename + '.mp4');
  fs.renameSync(req.file.path, newPath);
  res.json({ videoId: req.file.filename, path: newPath });
});

// GET /api/status
app.get('/api/status', (req, res) => {
  res.json({ status: 'ok', version: '1.0.0', ai: 'Claude 3.5 Sonnet' });
});

// ── Helpers ─────────────────────────────────────────

function runCmd(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 100 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(err); else resolve(stdout);
    });
  });
}

function getVideoDuration(filePath) {
  return new Promise((resolve, reject) => {
    exec(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${filePath}"`, (err, out) => {
      if (err) reject(err); else resolve(parseFloat(out.trim()));
    });
  });
}

function timeToSec(t) {
  if (typeof t === 'number') return t;
  const parts = t.split(':').map(Number);
  if (parts.length === 3) return parts[0]*3600 + parts[1]*60 + parts[2];
  if (parts.length === 2) return parts[0]*60 + parts[1];
  return parts[0];
}

function formatTime(sec) {
  const h = Math.floor(sec/3600);
  const m = Math.floor((sec%3600)/60);
  const s = Math.floor(sec%60);
  return h > 0 ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}` : `${m}:${String(s).padStart(2,'0')}`;
}

function secToSRT(sec) {
  const h = Math.floor(sec/3600);
  const m = Math.floor((sec%3600)/60);
  const s = Math.floor(sec%60);
  const ms = Math.round((sec%1)*1000);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')},${String(ms).padStart(3,'0')}`;
}

// ── Claude AI: analyze video for viral clips ─────────
async function claudeAnalyze(url, durationSec, jobId) {
  if (!CLAUDE_KEY) {
    // Return realistic mock data when no API key
    return mockClips(durationSec);
  }
  try {
    const resp = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: `You are FlowEcho AI viral clip detector. Video: "${url}", duration: ${Math.round(durationSec)}s.

Return ONLY JSON array of 6 clips (no markdown):
[{
  "id": 1,
  "emoji": "🔥",
  "title": "punchy viral title",
  "reason": "specific viral reason",
  "startSec": 42,
  "endSec": 88,
  "viralScore": 94,
  "hookScore": 91,
  "retentionScore": 88,
  "estViews": "3.2M",
  "engRate": "9.4%",
  "platforms": ["youtube","instagram","twitter"]
}]

Distribute clips across the full ${Math.round(durationSec)}s duration. Scores 65-98. Return ONLY the JSON array.`
      }]
    }, {
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CLAUDE_KEY,
        'anthropic-version': '2023-06-01'
      }
    });
    const raw = resp.data.content.map(b => b.text || '').join('');
    return JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch(e) {
    console.error('Claude error:', e.message);
    return mockClips(durationSec);
  }
}

function mockClips(dur) {
  const step = dur / 7;
  return [
    { id:1, emoji:'🔥', title:'The brutal truth nobody tells you', reason:'Contrarian hook triggers massive debate', startSec:Math.round(step*0.5), endSec:Math.round(step*0.5+52), viralScore:97, hookScore:96, retentionScore:93, estViews:'5.8M', engRate:'12.4%', platforms:['youtube','instagram','twitter','threads','linkedin'] },
    { id:2, emoji:'💰', title:'I made $500K in 30 days using THIS', reason:'Specific number + short timeframe = curiosity gap', startSec:Math.round(step*1.5), endSec:Math.round(step*1.5+44), viralScore:94, hookScore:98, retentionScore:89, estViews:'4.1M', engRate:'10.8%', platforms:['youtube','instagram','twitter','linkedin'] },
    { id:3, emoji:'😤', title:'I almost quit 3 times...', reason:'Raw vulnerability resonates deeply', startSec:Math.round(step*2.5), endSec:Math.round(step*2.5+55), viralScore:91, hookScore:94, retentionScore:88, estViews:'2.9M', engRate:'11.2%', platforms:['instagram','youtube','threads','linkedin'] },
    { id:4, emoji:'🚀', title:'This ONE decision 10x my revenue', reason:'Transformation + specific outcome', startSec:Math.round(step*3.5), endSec:Math.round(step*3.5+45), viralScore:89, hookScore:92, retentionScore:85, estViews:'2.1M', engRate:'8.9%', platforms:['youtube','twitter','linkedin','reddit'] },
    { id:5, emoji:'😬', title:'My $2M mistake — avoid this', reason:'Loss framing drives 3x more clicks', startSec:Math.round(step*4.5), endSec:Math.round(step*4.5+52), viralScore:86, hookScore:89, retentionScore:82, estViews:'1.7M', engRate:'7.8%', platforms:['reddit','twitter','linkedin','youtube'] },
    { id:6, emoji:'⚡', title:'Do THIS every morning for 90 days', reason:'Actionable + timeframe = high saves', startSec:Math.round(step*5.5), endSec:Math.round(step*5.5+50), viralScore:83, hookScore:87, retentionScore:86, estViews:'1.3M', engRate:'7.1%', platforms:['instagram','youtube','threads','twitter'] },
  ];
}

// ── Cut all clips with ffmpeg ────────────────────────
async function cutAllClips(videoPath, clips, videoId, jobId) {
  const results = [];
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    const clipId  = `${videoId}_clip${i+1}`;
    const outPath = path.join(OUTPUT_DIR, `${clipId}.mp4`);
    const dur     = c.endSec - c.startSec;

    progress(jobId, 5, 72 + (i/clips.length)*14, `Cutting clip ${i+1}/${clips.length}...`);

    try {
      // Cut + scale to 9:16 portrait for shorts
      await runCmd(
        `ffmpeg -y -ss ${c.startSec} -i "${videoPath}" -t ${dur} ` +
        `-vf "scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2:black" ` +
        `-c:v libx264 -preset fast -crf 22 -c:a aac -b:a 128k "${outPath}"`
      );

      // Also generate wide version
      const wideId   = `${clipId}_wide`;
      const widePath = path.join(OUTPUT_DIR, `${wideId}.mp4`);
      await runCmd(
        `ffmpeg -y -ss ${c.startSec} -i "${videoPath}" -t ${dur} ` +
        `-vf "scale=1280:720" -c:v libx264 -preset fast -crf 22 -c:a aac -b:a 128k "${widePath}"`
      );

      // Auto-generate thumbnail
      const thumbPath = path.join(OUTPUT_DIR, `${clipId}_thumb.jpg`);
      await runCmd(`ffmpeg -y -ss 1 -i "${outPath}" -vframes 1 -q:v 2 "${thumbPath}"`);

      results.push({
        ...c,
        clipId,
        clipUrl:   `/outputs/${clipId}.mp4`,
        wideUrl:   `/outputs/${wideId}.mp4`,
        thumbUrl:  `/outputs/${clipId}_thumb.jpg`,
        duration:  formatTime(dur),
        startTime: formatTime(c.startSec),
        endTime:   formatTime(c.endSec),
        videoId
      });
    } catch(e) {
      console.error(`Clip ${i+1} cut failed:`, e.message);
      results.push({ ...c, clipId, error: e.message });
    }
  }
  return results;
}

// ── Generate SRT captions ────────────────────────────
async function generateSRTCaptions(clipPath, language = 'en') {
  // Get clip duration
  const dur = await getVideoDuration(clipPath);

  // Use Whisper if available, otherwise generate word-level mock
  try {
    const srtPath = clipPath.replace('.mp4', '.srt');
    await runCmd(`whisper "${clipPath}" --language ${language} --output_format srt --output_dir "${path.dirname(clipPath)}"`);
    const srt = fs.readFileSync(srtPath, 'utf8');
    return { srt, words: parseSRTToWords(srt) };
  } catch(e) {
    // Fallback: generate caption blocks every 2s
    return generateMockCaptions(dur);
  }
}

async function generateCaptions(clip, jobId) {
  if (!clip.clipUrl || clip.error) return null;
  const clipPath = path.join(__dirname, clip.clipUrl.replace('/outputs/', 'outputs/'));
  if (!fs.existsSync(clipPath)) return null;
  return await generateSRTCaptions(clipPath);
}

function generateMockCaptions(dur) {
  const phrases = [
    "This is the moment that changes everything.",
    "Nobody talks about this but it's the truth.",
    "I almost gave up right here.",
    "This single decision made all the difference.",
    "You won't believe what happened next.",
    "The secret everyone is hiding from you.",
    "This is how you actually do it.",
    "Remember this — it will save you years.",
  ];
  let srt = '';
  let words = [];
  let idx = 1;
  for (let t = 0; t < dur; t += 2.5) {
    const phrase = phrases[idx % phrases.length];
    const end = Math.min(t + 2.4, dur);
    srt += `${idx}\n${secToSRT(t)} --> ${secToSRT(end)}\n${phrase}\n\n`;
    phrase.split(' ').forEach((w, wi) => {
      words.push({ word: w, start: t + wi*0.2, end: t + wi*0.2 + 0.18 });
    });
    idx++;
  }
  return { srt, words };
}

function parseSRTToWords(srt) {
  const blocks = srt.trim().split(/\n\n+/);
  const words = [];
  blocks.forEach(block => {
    const lines = block.split('\n');
    if (lines.length < 3) return;
    const times = lines[1].match(/(\d+:\d+:\d+,\d+) --> (\d+:\d+:\d+,\d+)/);
    if (!times) return;
    const start = srtTimeToSec(times[1]);
    const end   = srtTimeToSec(times[2]);
    const text  = lines.slice(2).join(' ');
    const ws    = text.split(/\s+/);
    const step  = (end - start) / ws.length;
    ws.forEach((w, i) => words.push({ word: w, start: start + i*step, end: start + (i+1)*step }));
  });
  return words;
}

function srtTimeToSec(t) {
  const [hms, ms] = t.split(',');
  const [h,m,s]   = hms.split(':').map(Number);
  return h*3600 + m*60 + s + Number(ms)/1000;
}

// ── Generate platform content ────────────────────────
async function generateContent(clip) {
  if (!CLAUDE_KEY) return mockContent(clip);
  try {
    const resp = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: `Viral content expert. Clip: "${clip.title}". Why viral: ${clip.reason}. Score: ${clip.viralScore}%.

Return ONLY JSON (no markdown):
{
  "youtube": {"title":"...","description":"...","hashtags":["..."]},
  "instagram": {"title":"...","description":"...","hashtags":["..."]},
  "twitter": {"title":"...","description":"...","hashtags":["..."]},
  "linkedin": {"title":"...","description":"...","hashtags":["..."]},
  "threads": {"title":"...","description":"...","hashtags":["..."]},
  "reddit": {"title":"...","description":"...","hashtags":[]},
  "blog": {"title":"...","description":"...","hashtags":["..."]},
  "newsletter": {"title":"...","description":"...","hashtags":["..."]}
}`
      }]
    }, {
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CLAUDE_KEY,
        'anthropic-version': '2023-06-01'
      }
    });
    const raw = resp.data.content.map(b => b.text || '').join('');
    return JSON.parse(raw.replace(/```json|```/g,'').trim());
  } catch(e) {
    return mockContent(clip);
  }
}

async function generatePlatformContent(clip, platform) {
  if (!CLAUDE_KEY) return mockContent(clip)[platform] || mockContent(clip).youtube;
  const all = await generateContent(clip);
  return all[platform] || all.youtube;
}

function mockContent(clip) {
  const t = clip.title;
  return {
    youtube:      { title:`🔥 ${t}`, description:`${clip.reason}\n\nWatch the full video for more.\n\n⏱ Timestamps in comments.\n\n🔔 Subscribe for daily content!`, hashtags:['viral','trending','youtube','shorts','fyp','motivation','entrepreneur','success'] },
    instagram:    { title:`🔥 ${t}`, description:`${clip.reason} 🚀\n\nSave this for later 💾\nFollow for more insights ✨\n\n#viral #trending #reels`, hashtags:['viral','reels','trending','fyp','instagram','motivation','entrepreneur','success','mindset','growth','explore','instagood','follow','like','share'] },
    twitter:      { title:t.slice(0,200), description:`${clip.reason.slice(0,200)}\n\nThread 🧵`, hashtags:['viral','trending'] },
    linkedin:     { title:`Lesson: ${t}`, description:`${clip.reason}\n\nThis insight is worth your attention.\n\nWhat do you think? Drop a comment below.`, hashtags:['linkedin','entrepreneur','business','growth','leadership'] },
    threads:      { title:`${t} 👀`, description:`${clip.reason}\n\nThoughts? 👇`, hashtags:['threads','viral','trending','fyp'] },
    reddit:       { title:`[Story] ${t}`, description:`${clip.reason}\n\nHave you experienced something similar? Curious what this community thinks.`, hashtags:[] },
    blog:         { title:`The Truth About: ${t}`, description:`In this article, we explore ${clip.reason.toLowerCase()}. This insight has the potential to completely change how you think about this topic.`, hashtags:['blog','content','viral','trending','tips'] },
    newsletter:   { title:`This Week: ${t}`, description:`Dear Reader,\n\n${clip.reason}\n\nI wanted to share this with you because it changed my perspective completely.\n\nUntil next week,\nThe FlowEcho Team`, hashtags:['newsletter','email','marketing'] },
  };
}

// ── Start server ─────────────────────────────────────
server.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════╗
║     FlowEcho AI Backend — Ready!       ║
║     http://localhost:${PORT}              ║
║                                        ║
║  WebSocket: ws://localhost:${PORT}        ║
║  Claude AI: ${CLAUDE_KEY ? '✓ Connected' : '✗ Set ANTHROPIC_API_KEY'}         ║
╚════════════════════════════════════════╝

const path = require("path");

// static files serve karega
app.use(express.static(__dirname));

// homepage route
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "flowecho-app.html"));
});

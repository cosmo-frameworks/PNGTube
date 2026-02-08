const express = require('express');
const { WebSocketServer } = require('ws');
const OBSWebSocket = require('obs-websocket-js').default;
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3377;

// pkg compatibility
const APP_DIR = process.pkg ? path.dirname(process.execPath) : __dirname;
const SNAPSHOT_DIR = __dirname;

const CONFIG_PATH = path.join(APP_DIR, 'config.json');
const IMAGES_DIR = path.join(APP_DIR, 'images');

if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });

// ── Default Config ──
const DEFAULT_CONFIG = {
  threshold: 15,
  closeDelay: 150,
  breathe: true,
  bounce: true,
  scale: 80,
  hotkey: 'F9',
  hotkeyCode: 'F9',
  hotkeyCtrl: false,
  hotkeyAlt: false,
  hotkeyShift: false,
  idleImage: null,
  talkImage: null,
  obsHost: 'localhost',
  obsPort: 4455,
  obsPassword: '',
  obsInputName: '',
};

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) };
    }
  } catch (e) { console.warn('Config load error:', e.message); }
  return { ...DEFAULT_CONFIG };
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

let config = loadConfig();

// ── Express ──
const app = express();
const server = http.createServer(app);

app.use(express.json({ limit: '10mb' }));
app.use('/images', express.static(IMAGES_DIR));

app.get('/', (req, res) => res.redirect('/panel'));
app.get('/panel', (req, res) => res.sendFile(path.join(SNAPSHOT_DIR, 'panel.html')));
app.get('/overlay', (req, res) => res.sendFile(path.join(SNAPSHOT_DIR, 'overlay.html')));

app.get('/api/config', (req, res) => res.json(config));

app.post('/api/config', (req, res) => {
  const prevObs = `${config.obsHost}:${config.obsPort}:${config.obsPassword}`;
  config = { ...config, ...req.body };
  saveConfig(config);
  broadcastClients({ type: 'config', data: config });

  const newObs = `${config.obsHost}:${config.obsPort}:${config.obsPassword}`;
  if (prevObs !== newObs) connectToOBS();

  res.json({ ok: true });
});

app.post('/api/upload/:type', express.raw({ type: 'image/*', limit: '10mb' }), (req, res) => {
  const { type } = req.params;
  if (!['idle', 'talk'].includes(type)) return res.status(400).json({ error: 'Invalid type' });

  const ct = req.headers['content-type'] || 'image/png';
  const ext = ct.includes('gif') ? 'gif' : ct.includes('webp') ? 'webp' : 'png';
  const filename = `${type}.${ext}`;

  fs.writeFileSync(path.join(IMAGES_DIR, filename), req.body);
  config[`${type}Image`] = filename;
  saveConfig(config);
  broadcastClients({ type: 'config', data: config });
  res.json({ ok: true, filename });
});

// OBS APIs for panel
app.get('/api/obs/inputs', async (req, res) => {
  if (!obsConnected) return res.json({ inputs: [], connected: false });
  try {
    const { inputs } = await obs.call('GetInputList');
    const audioInputs = [];
    for (const input of inputs) {
      try {
        await obs.call('GetInputVolume', { inputName: input.inputName });
        audioInputs.push(input.inputName);
      } catch (e) {}
    }
    res.json({ inputs: audioInputs, connected: true });
  } catch (e) {
    res.json({ inputs: [], connected: obsConnected, error: e.message });
  }
});

app.get('/api/obs/status', (req, res) => {
  res.json({ connected: obsConnected });
});

app.post('/api/obs/connect', async (req, res) => {
  await connectToOBS();
  res.json({ connected: obsConnected });
});

// Toggle avatar visibility (from panel button, Stream Deck, curl, etc.)
let avatarVisible = true;
app.post('/api/toggle', (req, res) => {
  avatarVisible = !avatarVisible;
  broadcastClients({ type: 'set-visible', visible: avatarVisible });
  // Also try to toggle OBS source visibility if connected
  toggleOBSSource(avatarVisible);
  res.json({ visible: avatarVisible });
});

app.get('/api/toggle', (req, res) => {
  avatarVisible = !avatarVisible;
  broadcastClients({ type: 'set-visible', visible: avatarVisible });
  toggleOBSSource(avatarVisible);
  res.json({ visible: avatarVisible });
});

async function toggleOBSSource(visible) {
  if (!obsConnected || !config.obsSourceName) return;
  try {
    // Find the scene the source is in
    const { currentProgramSceneName } = await obs.call('GetCurrentProgramScene');
    const { sceneItems } = await obs.call('GetSceneItemList', { sceneName: currentProgramSceneName });
    const item = sceneItems.find(i => i.sourceName === config.obsSourceName);
    if (item) {
      await obs.call('SetSceneItemEnabled', {
        sceneName: currentProgramSceneName,
        sceneItemId: item.sceneItemId,
        sceneItemEnabled: visible,
      });
    }
  } catch (e) {
    console.log('  ⚠️  No se pudo toggle la fuente en OBS:', e.message);
  }
}

// List OBS scenes and sources (for source picker in panel)
app.get('/api/obs/sources', async (req, res) => {
  if (!obsConnected) return res.json({ sources: [], connected: false });
  try {
    const { currentProgramSceneName } = await obs.call('GetCurrentProgramScene');
    const { sceneItems } = await obs.call('GetSceneItemList', { sceneName: currentProgramSceneName });
    const sources = sceneItems.map(i => i.sourceName);
    res.json({ sources, scene: currentProgramSceneName, connected: true });
  } catch (e) {
    res.json({ sources: [], connected: obsConnected, error: e.message });
  }
});

// ── WebSocket Server ──
const wss = new WebSocketServer({ server });
const clients = new Set();

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  ws.role = url.searchParams.get('role') || 'overlay';
  clients.add(ws);
  ws.send(JSON.stringify({ type: 'config', data: config }));
  ws.send(JSON.stringify({ type: 'obs-status', connected: obsConnected }));

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'toggle-visible') broadcastClients({ type: 'toggle-visible' });
    } catch (e) {}
  });

  ws.on('close', () => clients.delete(ws));
});

function broadcastClients(msg, except = null) {
  const data = typeof msg === 'string' ? msg : JSON.stringify(msg);
  for (const c of clients) {
    if (c !== except && c.readyState === 1) c.send(data);
  }
}

// ── OBS WebSocket ──
const obs = new OBSWebSocket();
let obsConnected = false;
let obsReconnectTimer = null;

async function connectToOBS() {
  if (obsReconnectTimer) { clearTimeout(obsReconnectTimer); obsReconnectTimer = null; }
  try { obs.disconnect(); } catch (e) {}
  obsConnected = false;

  const host = config.obsHost || 'localhost';
  const port = config.obsPort || 4455;
  const password = config.obsPassword || undefined;
  const url = `ws://${host}:${port}`;

  try {
    const { obsWebSocketVersion } = await obs.connect(url, password, {
      eventSubscriptions: (1 << 16), // InputVolumeMeters
    });
    obsConnected = true;
    console.log(`  ✅ Conectado a OBS (WebSocket v${obsWebSocketVersion})`);
    broadcastClients({ type: 'obs-status', connected: true });
  } catch (e) {
    obsConnected = false;
    console.log(`  ❌ OBS no disponible (${url}): ${e.message}`);
    broadcastClients({ type: 'obs-status', connected: false });
    obsReconnectTimer = setTimeout(connectToOBS, 5000);
  }
}

// Volume meter events from OBS
obs.on('InputVolumeMeters', (data) => {
  if (!config.obsInputName || !data.inputs) return;

  const input = data.inputs.find(i => i.inputName === config.obsInputName);
  if (!input || !input.inputLevelsMul || input.inputLevelsMul.length === 0) return;

  let maxLevel = 0;
  for (const channel of input.inputLevelsMul) {
    if (channel && channel.length > 0) {
      maxLevel = Math.max(maxLevel, channel[0] || 0);
    }
  }

  const volume = Math.min(100, maxLevel * 100);
  broadcastClients({ type: 'audio', volume });
});

obs.on('ConnectionClosed', () => {
  obsConnected = false;
  console.log('  ⚠️  OBS desconectado, reintentando...');
  broadcastClients({ type: 'obs-status', connected: false });
  obsReconnectTimer = setTimeout(connectToOBS, 5000);
});

// ── Start ──
server.listen(PORT, () => {
  console.log('');
  console.log('  ╔═══════════════════════════════════════════════╗');
  console.log('  ║           🎮 PNGTuber Server Ready            ║');
  console.log('  ╠═══════════════════════════════════════════════╣');
  console.log(`  ║  Panel:    http://localhost:${PORT}/panel        ║`);
  console.log(`  ║  Overlay:  http://localhost:${PORT}/overlay      ║`);
  console.log('  ╠═══════════════════════════════════════════════╣');
  console.log('  ║  Conectando a OBS WebSocket...                ║');
  console.log('  ╚═══════════════════════════════════════════════╝');
  console.log('');
  connectToOBS();
});

// Spygmo (pressure) web client
const socket = io();

// Chart setup
const ctx = document.getElementById('ppgChart').getContext('2d');
const maxPoints = 500;
const mvData = [];
const labels = [];

const chartColor = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#6366f1';

const chart = new Chart(ctx, {
  type: 'line',
  data: {
    labels,
    datasets: [{
      label: 'Spygmo (mV)',
      data: mvData,
      borderColor: chartColor,
      backgroundColor: 'rgba(99, 102, 241, 0.06)',
      borderWidth: 2,
      tension: 0.35,
      pointRadius: 0,
      fill: true,
    }],
  },
  options: {
    responsive: true,
    maintainAspectRatio: true,
    animation: { duration: 0 },
    scales: {
      x: { display: false },
      y: {
        display: true,
        ticks: {
          color: getComputedStyle(document.documentElement).getPropertyValue('--text-muted').trim() || '#94a3b8',
          font: { size: 11, family: 'JetBrains Mono, Inter, monospace' }
        },
        grid: { color: 'rgba(99, 102, 241, 0.05)', drawBorder: false },
      },
    },
    plugins: { legend: { display: false } },
  },
});

// State
let rawBuffer = [];
let mvBuffer = [];
let sampleRateHz = null;
let isRecording = false;
let recordStart = 0;
let recordTimer = null;
let recorded = [];
let recordings = [];
let currentAnalysis = null;

// === Supabase sync helpers ===
let isCloudAvailable = true;

async function apiSaveRecording(recording) {
  try {
    const res = await fetch('/api/recordings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: recording.id,
        name: recording.name,
        timestamp: recording.timestamp,
        duration: recording.duration,
        sampleCount: recording.sampleCount,
        data: recording.data
      })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    isCloudAvailable = true;
    return true;
  } catch (err) {
    console.warn('[SYNC] Save failed:', err.message);
    isCloudAvailable = false;
    return false;
  }
}

async function apiLoadRecordings() {
  try {
    const res = await fetch('/api/recordings');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json.offline) { isCloudAvailable = false; return null; }
    isCloudAvailable = true;
    return json.recordings;
  } catch (err) {
    console.warn('[SYNC] Load failed:', err.message);
    isCloudAvailable = false;
    return null;
  }
}

async function apiLoadRecordingFull(id) {
  try {
    const res = await fetch(`/api/recordings/${id}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    isCloudAvailable = true;
    return {
      id: json.id,
      name: json.name,
      timestamp: new Date(json.recorded_at),
      duration: json.duration,
      sampleCount: json.sample_count,
      data: json.data
    };
  } catch (err) {
    console.warn('[SYNC] Full load failed:', err.message);
    isCloudAvailable = false;
    return null;
  }
}

async function apiDeleteRecording(id) {
  try {
    const res = await fetch(`/api/recordings/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    isCloudAvailable = true;
    return true;
  } catch (err) {
    console.warn('[SYNC] Delete failed:', err.message);
    isCloudAvailable = false;
    return false;
  }
}

async function apiRenameRecording(id, newName) {
  try {
    const res = await fetch(`/api/recordings/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    isCloudAvailable = true;
    return true;
  } catch (err) {
    console.warn('[SYNC] Rename failed:', err.message);
    isCloudAvailable = false;
    return false;
  }
}

function showSyncStatus(message) {
  const toast = document.createElement('div');
  toast.className = 'sync-toast';
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

// BPM Detection State
let bpmBuffer = [];
let lastPeakTime = 0;
let peakThreshold = 0;
let isPeakDetectionActive = false;
let currentBPM = 0;
let bpmHistory = [];
const BPM_HISTORY_SIZE = 5;
const MIN_PEAK_DISTANCE = 400;

// UI refs
const portSelect = document.getElementById('portSelect');
const baudRate = document.getElementById('baudRate');
const refreshBtn = document.getElementById('refreshPorts');
const connectBtn = document.getElementById('connectBtn');
const disconnectBtn = document.getElementById('disconnectBtn');
const connectionIndicator = document.getElementById('connectionIndicator');
const recordBtn = document.getElementById('recordBtn');
const stopBtn = document.getElementById('stopRecordBtn');
const recordDuration = document.getElementById('recordDuration');
const importCsvBtn = document.getElementById('importCsvBtn');
const importCsvInput = document.getElementById('importCsvInput');
const recordingsList = document.getElementById('recordingsList');
const recordingsCard = document.getElementById('recordingsCard');
const noRecordingsMessage = document.getElementById('noRecordingsMessage');
const analysisCard = document.getElementById('analysisCard');

// Metrics refs
const currentRawEl = document.getElementById('currentRaw');
const currentMvEl = document.getElementById('currentMv');
const sampleRateEl = document.getElementById('sampleRate');
const dataCountEl = document.getElementById('dataCount');
const minMvEl = document.getElementById('minMv');
const maxMvEl = document.getElementById('maxMv');
const avgMvEl = document.getElementById('avgMv');
const rangeMvEl = document.getElementById('rangeMv');
const bpmWidget = document.getElementById('bpmWidget');
const bpmValueEl = document.getElementById('bpmValue');
const bpmHeart = document.getElementById('bpmHeart');
const bpmPulseRing = document.querySelector('.bpm-pulse-ring');

// Sidebar status refs
const sidebarStatusDot = document.getElementById('sidebarStatusDot');
const sidebarStatusText = document.getElementById('sidebarStatusText');

// Signal quality refs
const qualityPercent = document.getElementById('qualityPercent');
const qualityFill = document.getElementById('qualityFill');

// Page subtitle
const pageSubtitle = document.getElementById('pageSubtitle');

function updateMetrics(raw, mv) {
  if (mvBuffer.length === 0) return;
  const min = Math.min(...mvBuffer);
  const max = Math.max(...mvBuffer);
  const avg = mvBuffer.reduce((a, b) => a + b, 0) / mvBuffer.length;
  minMvEl.textContent = min.toFixed(3);
  maxMvEl.textContent = max.toFixed(3);
  avgMvEl.textContent = avg.toFixed(3);
  rangeMvEl.textContent = (max - min).toFixed(3);
  currentRawEl.textContent = raw;
  currentMvEl.textContent = mv.toFixed(3);
  dataCountEl.textContent = rawBuffer.length;
  sampleRateEl.textContent = sampleRateHz ? sampleRateHz.toFixed(1) : '--';

  detectPeak(mv);
  updateSignalQuality();
}

function updateChart() {
  const start = Math.max(0, mvBuffer.length - maxPoints);
  const slice = mvBuffer.slice(start);
  mvData.length = 0;
  mvData.push(...slice);
  labels.length = mvData.length;
  labels.fill('');
  chart.update('none');
}

// Signal Quality Estimation
function updateSignalQuality() {
  if (mvBuffer.length < 50) {
    qualityPercent.textContent = '--%';
    qualityFill.style.width = '0%';
    return;
  }

  const recent = mvBuffer.slice(-200);
  const min = Math.min(...recent);
  const max = Math.max(...recent);
  const range = max - min;

  // Quality based on signal range (good signal has clear pulse waves)
  // Also check noise level via standard deviation
  const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
  const variance = recent.reduce((a, v) => a + (v - avg) ** 2, 0) / recent.length;
  const stddev = Math.sqrt(variance);

  // Signal-to-noise ratio estimate
  let quality = 0;
  if (range > 0) {
    // Higher range with moderate stddev = good signal
    const snr = range / (stddev || 1);
    quality = Math.min(100, Math.max(0, snr * 15));
  }

  // Penalize if range is too small (flat signal)
  if (range < 10) quality *= 0.3;

  quality = Math.round(quality);
  qualityPercent.textContent = quality + '%';
  qualityFill.style.width = quality + '%';
}

// BPM Peak Detection
function detectPeak(mv) {
  if (!isPeakDetectionActive || mvBuffer.length < 50) return;

  const now = Date.now();
  const recentData = mvBuffer.slice(-100);
  const min = Math.min(...recentData);
  const max = Math.max(...recentData);
  const range = max - min;
  peakThreshold = min + (range * 0.7);

  if (mv > peakThreshold && (now - lastPeakTime) > MIN_PEAK_DISTANCE) {
    const recentValues = mvBuffer.slice(-5);
    const isLocalMax = mv >= Math.max(...recentValues);

    if (isLocalMax) {
      bpmBuffer.push(now);
      lastPeakTime = now;
      bpmBuffer = bpmBuffer.filter(t => (now - t) < 10000);

      // Trigger heartbeat animation on each peak
      triggerHeartBeat();

      if (bpmBuffer.length >= 2) {
        const intervals = [];
        for (let i = 1; i < bpmBuffer.length; i++) {
          intervals.push(bpmBuffer[i] - bpmBuffer[i - 1]);
        }
        const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
        const bpm = Math.round(60000 / avgInterval);

        if (bpm >= 40 && bpm <= 180) {
          bpmHistory.push(bpm);
          if (bpmHistory.length > BPM_HISTORY_SIZE) bpmHistory.shift();
          currentBPM = Math.round(bpmHistory.reduce((a, b) => a + b, 0) / bpmHistory.length);
          updateBPMDisplay(currentBPM);
        }
      }
    }
  }
}

// Animated heartbeat on peak detection
function triggerHeartBeat() {
  if (bpmHeart) {
    bpmHeart.classList.remove('beat');
    void bpmHeart.offsetWidth; // force reflow
    bpmHeart.classList.add('beat');
  }
  if (bpmPulseRing) {
    bpmPulseRing.classList.remove('animate');
    void bpmPulseRing.offsetWidth;
    bpmPulseRing.classList.add('animate');
  }
}

function updateBPMDisplay(bpm) {
  if (bpmValueEl) bpmValueEl.textContent = bpm;
}

function resetBPM() {
  bpmBuffer = [];
  bpmHistory = [];
  currentBPM = 0;
  lastPeakTime = 0;
  isPeakDetectionActive = false;
  if (bpmValueEl) bpmValueEl.textContent = '---';
  if (bpmWidget) bpmWidget.classList.add('hidden');
}

function startBPMDetection() {
  isPeakDetectionActive = true;
  resetBPM();
  isPeakDetectionActive = true;
  if (bpmWidget) bpmWidget.classList.remove('hidden');
}

// Connection indicator helper
function setConnectionStatus(status, text) {
  const indicator = connectionIndicator;
  const connText = indicator.querySelector('.conn-text');
  indicator.className = 'conn-indicator ' + status;
  connText.textContent = text;

  // Update sidebar status
  if (sidebarStatusDot && sidebarStatusText) {
    if (status === 'connected') {
      sidebarStatusDot.classList.add('online');
      sidebarStatusText.textContent = 'Connected';
    } else {
      sidebarStatusDot.classList.remove('online');
      sidebarStatusText.textContent = 'Offline';
    }
  }

  // Update page subtitle
  if (pageSubtitle) {
    if (status === 'connected') {
      pageSubtitle.textContent = 'Receiving live PPG data';
    } else {
      pageSubtitle.textContent = 'Real-time PPG monitoring';
    }
  }
}

// Ports
async function loadPorts() {
  try {
    const res = await fetch('/api/ports');
    const ports = await res.json();
    portSelect.innerHTML = '<option value="">Select Port</option>';
    ports.forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p.path;
      opt.textContent = p.friendlyName || `${p.path}${p.manufacturer ? ' - ' + p.manufacturer : ''}`;
      portSelect.appendChild(opt);
      if (p.path.startsWith('/dev/tty.')) {
        const alt = document.createElement('option');
        alt.value = p.path.replace('/dev/tty.', '/dev/cu.');
        alt.textContent = opt.textContent.replace('/dev/tty.', '/dev/cu.') + ' (cu)';
        portSelect.appendChild(alt);
      }
    });
    if (ports.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No ports detected';
      portSelect.appendChild(opt);
    }
  } catch (err) {
    alert('Failed to load ports: ' + err.message);
  }
}

async function connect() {
  const port = portSelect.value;
  if (!port) return alert('Select a COM port first');
  try {
    const res = await fetch('/api/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ portPath: port, baudRate: baudRate.value || 115200 }),
    });
    const r = await res.json();
    if (r.success) {
      setConnectionStatus('connected', 'Connected: ' + port);
      connectBtn.disabled = true;
      disconnectBtn.disabled = false;
      portSelect.disabled = true;
      baudRate.disabled = true;
      recordBtn.disabled = false;
      startBPMDetection();
    } else {
      alert(r.error || 'Connection failed');
    }
  } catch (err) {
    alert('Connection failed: ' + err.message);
  }
}

async function disconnect() {
  await fetch('/api/disconnect', { method: 'POST' });
  setConnectionStatus('disconnected', 'Disconnected');
  connectBtn.disabled = false;
  disconnectBtn.disabled = true;
  portSelect.disabled = false;
  baudRate.disabled = false;
  recordBtn.disabled = true;
  stopBtn.disabled = true;
  resetBPM();
  if (isRecording) stopRecording();
}

// Recording
function startRecording() {
  isRecording = true;
  recorded = [];
  recordStart = Date.now();
  recordBtn.disabled = true;
  stopBtn.disabled = false;
  document.getElementById('recordingStatus').classList.remove('hidden');
  recordTimer = setInterval(() => {
    const dur = Math.floor((Date.now() - recordStart) / 1000);
    recordDuration.textContent = `${dur}s`;
  }, 1000);
}

function stopRecording() {
  if (!isRecording) return;
  isRecording = false;
  recordBtn.disabled = false;
  stopBtn.disabled = true;
  document.getElementById('recordingStatus').classList.add('hidden');
  if (recordTimer) clearInterval(recordTimer);
  recordDuration.textContent = '0s';

  if (recorded.length > 0) {
    const timestamp = new Date();
    const recording = {
      id: Date.now(),
      timestamp: timestamp,
      name: `Recording ${timestamp.toLocaleString('id-ID')}`,
      data: [...recorded],
      duration: Math.floor((Date.now() - recordStart) / 1000),
      sampleCount: recorded.length
    };
    recordings.push(recording);
    currentAnalysis = recording;
    switchPage('analysis');
    updateAnalysisPage();

    // Async save to Supabase
    apiSaveRecording(recording).then(saved => {
      if (!saved) showSyncStatus('Recording saved locally only (cloud unavailable)');
    });
  }
  recorded = [];
}

// Socket listeners
socket.on('connection-status', (data) => {
  if (data.status === 'connected') {
    setConnectionStatus('connected', 'Connected: ' + data.port);
    connectBtn.disabled = true;
    disconnectBtn.disabled = false;
    portSelect.disabled = true;
    baudRate.disabled = true;
    recordBtn.disabled = false;
  }
  if (data.status === 'disconnected') {
    resetBPM();
    disconnect();
  }
});

socket.on('spygmo-rate', ({ dt }) => {
  if (dt > 0) {
    sampleRateHz = 1000 / dt;
    sampleRateEl.textContent = sampleRateHz.toFixed(1);
  }
});

socket.on('spygmo-data', ({ timestamp, raw, mv }) => {
  rawBuffer.push(raw);
  mvBuffer.push(mv);
  if (rawBuffer.length > 5000) {
    rawBuffer.shift();
    mvBuffer.shift();
  }

  if (isRecording) {
    recorded.push({ t: timestamp - recordStart, raw, mv });
  }

  updateMetrics(raw, mv);
  updateChart();
});

socket.on('error', (err) => {
  console.error(err);
});

// Analysis page functions
let analysisChart = null;

async function updateAnalysisPage() {
  // If no local recordings, try loading from Supabase
  if (recordings.length === 0) {
    const cloudRecordings = await apiLoadRecordings();
    if (cloudRecordings && cloudRecordings.length > 0) {
      recordings = cloudRecordings.map(r => ({
        id: r.id,
        name: r.name,
        timestamp: new Date(r.recorded_at),
        duration: r.duration,
        sampleCount: r.sample_count,
        data: null // lazy-loaded on "View"
      }));
    }
  }

  if (recordings.length === 0) {
    recordingsCard.classList.add('hidden');
    noRecordingsMessage.classList.remove('hidden');
    analysisCard.classList.add('hidden');
    return;
  }

  recordingsCard.classList.remove('hidden');
  noRecordingsMessage.classList.add('hidden');

  recordingsList.innerHTML = '';
  recordings.forEach((rec, index) => {
    const div = document.createElement('div');
    div.className = `recording-item ${currentAnalysis?.id === rec.id ? 'active' : ''}`;
    div.style.animationDelay = `${index * 50}ms`;
    div.innerHTML = `
      <div class="recording-info">
        <h4><span class="recording-name" data-id="${rec.id}">${rec.name}</span></h4>
        <p>${rec.sampleCount} samples &middot; ${rec.duration}s</p>
      </div>
      <div class="recording-actions">
        <button class="view-rec-btn btn btn-primary" data-id="${rec.id}" style="padding: 6px 12px; font-size: 12px;">View</button>
        <button class="download-rec-btn btn btn-ghost" data-id="${rec.id}" style="padding: 6px 12px; font-size: 12px;">CSV</button>
        <button class="delete-rec-btn btn btn-ghost" data-id="${rec.id}" style="padding: 6px 10px; font-size: 12px; color: var(--red); border-color: rgba(239,68,68,0.2);">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14"/></svg>
        </button>
      </div>
    `;
    recordingsList.appendChild(div);
  });

  document.querySelectorAll('.view-rec-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = parseInt(btn.getAttribute('data-id'));
      const rec = recordings.find(r => r.id === id);
      if (rec) {
        // Lazy-load full data from Supabase if not in memory
        if (!rec.data) {
          btn.textContent = 'Loading...';
          btn.disabled = true;
          const fullRec = await apiLoadRecordingFull(id);
          if (fullRec) {
            rec.data = fullRec.data;
            rec.timestamp = fullRec.timestamp;
          } else {
            alert('Could not load recording data');
            btn.textContent = 'View';
            btn.disabled = false;
            return;
          }
          btn.textContent = 'View';
          btn.disabled = false;
        }
        currentAnalysis = rec;
        showRecordingAnalysis(rec);
        updateAnalysisPage();
      }
    });
  });

  document.querySelectorAll('.download-rec-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = parseInt(btn.getAttribute('data-id'));
      const rec = recordings.find(r => r.id === id);
      if (rec) downloadRecording(rec);
    });
  });

  document.querySelectorAll('.delete-rec-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = parseInt(btn.getAttribute('data-id'));
      recordings = recordings.filter(r => r.id !== id);
      if (currentAnalysis?.id === id) {
        currentAnalysis = null;
        analysisCard.classList.add('hidden');
      }
      updateAnalysisPage();
      apiDeleteRecording(id);
    });
  });

  document.querySelectorAll('.recording-name').forEach(nameEl => {
    nameEl.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = parseInt(nameEl.getAttribute('data-id'));
      const rec = recordings.find(r => r.id === id);
      if (rec) makeNameEditable(nameEl, rec);
    });
  });

  if (currentAnalysis) {
    showRecordingAnalysis(currentAnalysis);
  }
}

function showRecordingAnalysis(recording) {
  analysisCard.classList.remove('hidden');

  const mvValues = recording.data.map(d => d.mv);
  const minMv = Math.min(...mvValues);
  const maxMv = Math.max(...mvValues);
  const avgMv = mvValues.reduce((a, b) => a + b, 0) / mvValues.length;
  const rangeMv = maxMv - minMv;

  // Calculate estimated BPM from recording data
  let estBPM = '--';
  if (mvValues.length > 50) {
    const threshold = minMv + (rangeMv * 0.7);
    const peaks = [];
    for (let i = 2; i < mvValues.length - 2; i++) {
      if (mvValues[i] > threshold && mvValues[i] >= mvValues[i-1] && mvValues[i] >= mvValues[i+1]) {
        if (peaks.length === 0 || (i - peaks[peaks.length - 1]) > 20) {
          peaks.push(i);
        }
      }
    }
    if (peaks.length >= 2 && recording.duration > 0) {
      const avgSamplesPerBeat = (peaks[peaks.length-1] - peaks[0]) / (peaks.length - 1);
      const samplesPerSec = mvValues.length / recording.duration;
      const beatsPerSec = samplesPerSec / avgSamplesPerBeat;
      const bpm = Math.round(beatsPerSec * 60);
      if (bpm >= 40 && bpm <= 180) estBPM = bpm;
    }
  }

  const content = `
    <div class="analysis-header">
      <h4>${recording.name}</h4>
      <div class="analysis-meta">
        <span>${recording.sampleCount} samples</span>
        <span>${recording.duration}s duration</span>
        <span>${new Date(recording.timestamp).toLocaleString('id-ID')}</span>
      </div>
    </div>

    <div class="analysis-metrics">
      <div class="analysis-metric">
        <div class="analysis-metric-label">Min mV</div>
        <div class="analysis-metric-value">${minMv.toFixed(3)}</div>
      </div>
      <div class="analysis-metric">
        <div class="analysis-metric-label">Max mV</div>
        <div class="analysis-metric-value">${maxMv.toFixed(3)}</div>
      </div>
      <div class="analysis-metric">
        <div class="analysis-metric-label">Avg mV</div>
        <div class="analysis-metric-value">${avgMv.toFixed(3)}</div>
      </div>
      <div class="analysis-metric">
        <div class="analysis-metric-label">Est. BPM</div>
        <div class="analysis-metric-value" style="color: var(--pink);">${estBPM}</div>
      </div>
    </div>

    <div class="analysis-chart-section">
      <div class="analysis-chart-header">
        <span class="analysis-chart-title">Signal Chart</span>
        <button id="downloadCurrentBtn" class="btn btn-ghost" style="padding: 6px 14px; font-size: 12px;">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
          Download CSV
        </button>
      </div>
      <div class="analysis-chart-body">
        <canvas id="analysisChart"></canvas>
      </div>
    </div>
  `;

  document.getElementById('analysisContent').innerHTML = content;

  const actx = document.getElementById('analysisChart').getContext('2d');
  if (analysisChart) analysisChart.destroy();

  const mutedColor = getComputedStyle(document.documentElement).getPropertyValue('--text-muted').trim() || '#94a3b8';

  analysisChart = new Chart(actx, {
    type: 'line',
    data: {
      labels: recording.data.map((_, i) => i),
      datasets: [{
        label: 'mV',
        data: mvValues,
        borderColor: '#ec4899',
        backgroundColor: 'rgba(236, 72, 153, 0.06)',
        borderWidth: 2,
        tension: 0.35,
        pointRadius: 0,
        fill: true,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      animation: { duration: 600, easing: 'easeOutQuart' },
      scales: {
        x: {
          display: true,
          title: { display: true, text: 'Sample', color: mutedColor, font: { size: 11, weight: '600', family: 'JetBrains Mono, Inter, monospace' } },
          ticks: { color: mutedColor, font: { size: 10, family: 'JetBrains Mono, Inter, monospace' } },
          grid: { color: 'rgba(236, 72, 153, 0.04)', drawBorder: false }
        },
        y: {
          display: true,
          title: { display: true, text: 'mV', color: mutedColor, font: { size: 11, weight: '600', family: 'JetBrains Mono, Inter, monospace' } },
          ticks: { color: mutedColor, font: { size: 10, family: 'JetBrains Mono, Inter, monospace' } },
          grid: { color: 'rgba(236, 72, 153, 0.04)', drawBorder: false }
        }
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(15, 23, 42, 0.9)',
          titleColor: '#f1f5f9',
          bodyColor: '#f1f5f9',
          padding: 12,
          cornerRadius: 8,
          titleFont: { family: 'JetBrains Mono, monospace', size: 11 },
          bodyFont: { family: 'JetBrains Mono, monospace', size: 12 },
          borderColor: 'rgba(99, 102, 241, 0.2)',
          borderWidth: 1,
          callbacks: {
            label: (context) => `mV: ${context.parsed.y.toFixed(3)}`
          }
        }
      }
    }
  });

  document.getElementById('downloadCurrentBtn').addEventListener('click', () => {
    downloadRecording(recording);
  });
}

function downloadRecording(recording) {
  const csv = 'time_ms,raw,mv\n' + recording.data.map((d) => `${d.t},${d.raw},${d.mv.toFixed(4)}`).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `spygmo_${new Date(recording.timestamp).toISOString().replace(/[:.]/g, '-')}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function importCsv() {
  const file = importCsvInput.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const text = e.target.result;
      const lines = text.split('\n').filter(l => l.trim());
      const header = lines[0];

      if (!header.includes('time_ms') || !header.includes('raw') || !header.includes('mv')) {
        alert('Invalid CSV format. Must have columns: time_ms,raw,mv');
        return;
      }

      const data = [];
      for (let i = 1; i < lines.length; i++) {
        const parts = lines[i].split(',');
        if (parts.length >= 3) {
          data.push({
            t: parseFloat(parts[0]),
            raw: parseInt(parts[1]),
            mv: parseFloat(parts[2])
          });
        }
      }

      if (data.length === 0) {
        alert('No valid data in CSV');
        return;
      }

      const recording = {
        id: Date.now(),
        timestamp: new Date(),
        name: `Imported: ${file.name}`,
        data: data,
        duration: Math.floor(data[data.length - 1].t / 1000),
        sampleCount: data.length
      };

      recordings.push(recording);
      currentAnalysis = recording;
      updateAnalysisPage();
      importCsvInput.value = '';

      // Async save to Supabase
      apiSaveRecording(recording).then(saved => {
        if (!saved) showSyncStatus('Imported recording saved locally only');
      });
    } catch (err) {
      alert('CSV import failed: ' + err.message);
    }
  };
  reader.readAsText(file);
}

// UI wiring
refreshBtn.addEventListener('click', loadPorts);
connectBtn.addEventListener('click', connect);
disconnectBtn.addEventListener('click', disconnect);
recordBtn.addEventListener('click', startRecording);
stopBtn.addEventListener('click', stopRecording);
importCsvBtn.addEventListener('click', () => importCsvInput.click());
importCsvInput.addEventListener('change', importCsv);

document.getElementById('goDashboardBtn')?.addEventListener('click', () => switchPage('dashboard'));

document.querySelectorAll('.nav-item').forEach((link) => {
  link.addEventListener('click', (e) => {
    e.preventDefault();
    const page = link.getAttribute('data-page');
    switchPage(page);
  });
});

function switchPage(page) {
  document.querySelectorAll('.page').forEach((p) => p.classList.add('hidden'));
  const pageTitle = document.getElementById('pageTitle');

  if (page === 'dashboard') {
    document.getElementById('dashboardPage').classList.remove('hidden');
    if (pageTitle) pageTitle.textContent = 'Dashboard';
    if (pageSubtitle) {
      const isConnected = connectionIndicator.classList.contains('connected');
      pageSubtitle.textContent = isConnected ? 'Receiving live PPG data' : 'Real-time PPG monitoring';
    }
  }
  if (page === 'analysis') {
    document.getElementById('analysisPage').classList.remove('hidden');
    if (pageTitle) pageTitle.textContent = 'Analysis';
    if (pageSubtitle) pageSubtitle.textContent = 'Recorded data analysis';
    updateAnalysisPage();
  }

  document.querySelectorAll('.nav-item').forEach((l) => l.classList.remove('active'));
  document.querySelector(`.nav-item[data-page="${page}"]`)?.classList.add('active');
}

// Sidebar toggle
const sidebar = document.getElementById('sidebar');
const mainContent = document.getElementById('mainContent');
const toggleSidebarBtn = document.getElementById('toggleSidebar');

toggleSidebarBtn.addEventListener('click', () => {
  sidebar.classList.toggle('collapsed');
  mainContent.classList.toggle('expanded');
});

// Theme toggle
const themeToggle = document.getElementById('themeToggle');
let isDark = localStorage.getItem('theme') === 'dark';

function applyTheme() {
  if (isDark) {
    document.body.classList.add('dark-theme');
  } else {
    document.body.classList.remove('dark-theme');
  }
}

applyTheme();

themeToggle.addEventListener('click', () => {
  isDark = !isDark;
  localStorage.setItem('theme', isDark ? 'dark' : 'light');
  applyTheme();
});

// Editable filename
function makeNameEditable(nameEl, recording) {
  const originalName = recording.name;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'recording-name-input';
  input.value = originalName;

  nameEl.replaceWith(input);
  input.focus();
  input.select();

  function saveName() {
    const newName = input.value.trim();
    if (newName && newName !== originalName) {
      recording.name = newName;
      apiRenameRecording(recording.id, newName);
    }

    const newSpan = document.createElement('span');
    newSpan.className = 'recording-name';
    newSpan.setAttribute('data-id', recording.id);
    newSpan.textContent = recording.name;
    input.replaceWith(newSpan);

    newSpan.addEventListener('click', (e) => {
      e.stopPropagation();
      makeNameEditable(newSpan, recording);
    });

    if (currentAnalysis?.id === recording.id) {
      currentAnalysis = recording;
      showRecordingAnalysis(recording);
    }
  }

  input.addEventListener('blur', saveName);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      saveName();
    } else if (e.key === 'Escape') {
      const cancelSpan = document.createElement('span');
      cancelSpan.className = 'recording-name';
      cancelSpan.setAttribute('data-id', recording.id);
      cancelSpan.textContent = originalName;
      input.replaceWith(cancelSpan);

      cancelSpan.addEventListener('click', (e) => {
        e.stopPropagation();
        makeNameEditable(cancelSpan, recording);
      });
    }
  });
}

// Init
loadPorts();
switchPage('dashboard');

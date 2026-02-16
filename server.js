require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

// Supabase client (optional - app works without it)
let supabase = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  console.log('[SUPABASE] Client initialized');
} else {
  console.warn('[SUPABASE] No credentials in .env - running in offline mode');
}

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

const PORT = 3000;
let serialPort = null;
let parser = null;
let lastTimestamp = null; // track incoming timestamps for sample rate estimation

// Middleware
app.use(express.static('public'));
app.use(express.json({ limit: '10mb' }));

// Serve HTML
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Get available COM ports
app.get('/api/ports', async (req, res) => {
  try {
    const ports = await SerialPort.list();
    console.log(`[PORTS] Found ${ports.length} ports`);
    
    const portList = ports.map(port => ({
      path: port.path,
      manufacturer: port.manufacturer,
      serialNumber: port.serialNumber,
      pnpId: port.pnpId,
      vendorId: port.vendorId,
      productId: port.productId,
      friendlyName: port.friendlyName
    }));
    
    res.json(portList);
  } catch (error) {
    console.error('[PORTS ERROR]', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Disconnect existing connection
function disconnectSerial() {
  return new Promise((resolve) => {
    if (serialPort && serialPort.isOpen) {
      serialPort.close((err) => {
        if (err) console.error('[CLOSE ERROR]', err.message);
        serialPort = null;
        parser = null;
        lastTimestamp = null;
        resolve();
      });
    } else {
      serialPort = null;
      parser = null;
      lastTimestamp = null;
      resolve();
    }
  });
}

// Connect to a specific COM port
app.post('/api/connect', async (req, res) => {
  const { portPath, baudRate = 9600 } = req.body;
  
  console.log(`[CONNECT] Attempting to connect to ${portPath} @ ${baudRate} baud`);
  
  // Disconnect existing connection first
  await disconnectSerial();
  
  try {
    serialPort = new SerialPort({
      path: portPath,
      baudRate: parseInt(baudRate),
      autoOpen: false
    });

    serialPort.on('open', () => {
      console.log(`[CONNECT] ✓ Connected to ${portPath} @ ${baudRate} baud`);
      
      // Create parser after port is open
      parser = serialPort.pipe(new ReadlineParser({ delimiter: '\n' }));
      
      io.emit('connection-status', { 
        status: 'connected', 
        port: portPath,
        baudRate: baudRate
      });
      
      if (!res.headersSent) {
        res.json({ success: true, message: 'Connected to Arduino' });
      }
      
      // Read data from serial port
      parser.on('data', (data) => {
        try {
          const line = data.trim();
          if (!line || line.startsWith('#')) return; // skip empty/comment
          if (/^raw/i.test(line)) return; // skip header lines like "raw,mV"

          // Accept formats: "raw,mV" or "raw mV" or "timestamp --> raw,mV"
          let payload = line;
          if (payload.includes('-->')) {
            const parts = payload.split('-->');
            payload = parts.pop().trim();
          }

          const pieces = payload.split(/[,\s]+/).map(v => v.trim()).filter(Boolean);
          if (pieces.length < 2) return;

          const raw = parseInt(pieces[0], 10);
          const mv = parseFloat(pieces[1]);
          if (Number.isNaN(raw) || Number.isNaN(mv)) return;

          const now = Date.now();
          if (lastTimestamp) {
            const dt = now - lastTimestamp;
            io.emit('spygmo-rate', { dt }); // client can estimate sample rate
          }
          lastTimestamp = now;

          io.emit('spygmo-data', {
            timestamp: now,
            raw,
            mv,
          });
        } catch (error) {
          console.error('[PARSE ERROR]', error.message);
        }
      });
    });

    serialPort.on('error', (err) => {
      console.error(`[SERIAL ERROR] ${err.message}`);
      if (!res.headersSent) {
        res.status(500).json({ error: err.message });
      }
      io.emit('connection-status', { 
        status: 'error', 
        message: err.message 
      });
    });

    serialPort.on('close', () => {
      console.log('[SERIAL] Port closed');
      io.emit('connection-status', { status: 'disconnected' });
    });

    // Open the port
    serialPort.open((err) => {
      if (err) {
        console.error(`[OPEN ERROR] ${err.message}`);
        if (!res.headersSent) {
          res.status(500).json({ error: err.message });
        }
      }
    });

  } catch (error) {
    console.error('[CONNECTION ERROR]', error.message);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});

// Disconnect from COM port
app.post('/api/disconnect', async (req, res) => {
  await disconnectSerial();
  io.emit('connection-status', { status: 'disconnected' });
  res.json({ success: true, message: 'Disconnected' });
});

// Get connection status
app.get('/api/status', (req, res) => {
  const status = serialPort && serialPort.isOpen ? 'connected' : 'disconnected';
  res.json({ 
    status,
    port: serialPort ? serialPort.path : null
  });
});

// ===== Recordings CRUD (Supabase) =====

// List recordings (without data field for performance)
app.get('/api/recordings', async (req, res) => {
  if (!supabase) return res.json({ offline: true, recordings: [] });
  try {
    const { data, error } = await supabase
      .from('recordings')
      .select('id, name, recorded_at, duration, sample_count, created_at')
      .order('recorded_at', { ascending: false });
    if (error) throw error;
    res.json({ recordings: data });
  } catch (error) {
    console.error('[SUPABASE ERROR]', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Get single recording with full data
app.get('/api/recordings/:id', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured' });
  try {
    const { data, error } = await supabase
      .from('recordings')
      .select('*')
      .eq('id', req.params.id)
      .single();
    if (error) throw error;
    res.json(data);
  } catch (error) {
    console.error('[SUPABASE ERROR]', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Save new recording
app.post('/api/recordings', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured' });
  try {
    const { id, name, timestamp, duration, sampleCount, data } = req.body;
    const { error } = await supabase
      .from('recordings')
      .insert({
        id,
        name,
        recorded_at: timestamp,
        duration,
        sample_count: sampleCount,
        data
      });
    if (error) throw error;
    console.log(`[SUPABASE] Saved recording: ${name} (${sampleCount} samples)`);
    res.json({ success: true });
  } catch (error) {
    console.error('[SUPABASE ERROR]', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Rename recording
app.put('/api/recordings/:id', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured' });
  try {
    const { name } = req.body;
    const { error } = await supabase
      .from('recordings')
      .update({ name, updated_at: new Date().toISOString() })
      .eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    console.error('[SUPABASE ERROR]', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Delete recording
app.delete('/api/recordings/:id', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Supabase not configured' });
  try {
    const { error } = await supabase
      .from('recordings')
      .delete()
      .eq('id', req.params.id);
    if (error) throw error;
    console.log(`[SUPABASE] Deleted recording: ${req.params.id}`);
    res.json({ success: true });
  } catch (error) {
    console.error('[SUPABASE ERROR]', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Socket.IO connection
io.on('connection', (socket) => {
  console.log(`[IO] Client connected: ${socket.id}`);
  
  socket.on('disconnect', () => {
    console.log(`[IO] Client disconnected: ${socket.id}`);
  });
});

// Start server
server.listen(PORT, () => {
  console.log(`\n╔════════════════════════════════════════╗`);
  console.log(`║  Spygmo Web Monitor - Server Started   ║`);
  console.log(`║  http://localhost:${PORT}                    ║`);
  console.log(`╚════════════════════════════════════════╝\n`);
});

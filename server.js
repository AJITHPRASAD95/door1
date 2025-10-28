const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// Enhanced Socket.IO configuration for ESP32 compatibility
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    credentials: true,
    allowedHeaders: ["Content-Type"]
  },
  transports: ['websocket', 'polling'],
  allowEIO3: true,
  pingTimeout: 60000,
  pingInterval: 25000,
  upgradeTimeout: 30000,
  maxHttpBufferSize: 1e6,
  allowUpgrades: true,
  perMessageDeflate: false,
  httpCompression: false
});

// Middleware
app.use(cors({
  origin: "*",
  credentials: true
}));
app.use(express.json());

// Serve static files from 'public' directory
app.use(express.static('public'));

// MongoDB Connection
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://ajithtest95:ajith%40123@cluster0.n3qvh.mongodb.net/door';

mongoose.connect(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => console.log('✅ Connected to MongoDB'))
.catch(err => console.error('❌ MongoDB connection error:', err));

// Conference Room Schema
const conferenceRoomSchema = new mongoose.Schema({
  roomName: {
    type: String,
    required: true,
    unique: true
  },
  doorAccess: {
    type: Boolean,
    default: false
  },
  lastAccessed: {
    type: Date,
    default: null
  },
  accessLog: [{
    timestamp: Date,
    action: String
  }]
}, {
  timestamps: true
});

const ConferenceRoom = mongoose.model('ConferenceRoom', conferenceRoomSchema);

// Store ESP32 socket connections with metadata
const esp32Devices = new Map();

// Socket.IO Connection Handling
io.on('connection', (socket) => {
  console.log('📱 Client connected:', socket.id, 'Transport:', socket.conn.transport.name);

  // Log transport upgrade
  socket.conn.on('upgrade', (transport) => {
    console.log('🔄 Transport upgraded to:', transport.name);
  });

  // ESP32 Registration
  socket.on('esp32_register', (data) => {
    console.log('🔌 ESP32 registration attempt:', data);
    
    const deviceInfo = {
      socket: socket,
      deviceId: data.deviceId || 'UNKNOWN',
      chipId: data.chipId || 'UNKNOWN',
      ip: data.ip || socket.handshake.address,
      registeredAt: new Date(),
      lastSeen: new Date()
    };
    
    esp32Devices.set(socket.id, deviceInfo);
    
    console.log('✅ ESP32 registered successfully:', {
      socketId: socket.id,
      deviceId: deviceInfo.deviceId,
      ip: deviceInfo.ip,
      totalDevices: esp32Devices.size
    });
    
    socket.emit('registered', { 
      status: 'success', 
      message: 'ESP32 registered successfully',
      socketId: socket.id
    });
  });

  // Handle ping/pong for connection health
  socket.on('ping', () => {
    socket.emit('pong');
    if (esp32Devices.has(socket.id)) {
      const device = esp32Devices.get(socket.id);
      device.lastSeen = new Date();
    }
  });

  // Handle disconnection
  socket.on('disconnect', (reason) => {
    console.log('📴 Client disconnected:', socket.id, 'Reason:', reason);
    
    if (esp32Devices.has(socket.id)) {
      const device = esp32Devices.get(socket.id);
      console.log('🔌 ESP32 disconnected:', device.deviceId);
      esp32Devices.delete(socket.id);
      console.log('📊 Remaining ESP32 devices:', esp32Devices.size);
    }
  });

  // Handle connection errors
  socket.on('error', (error) => {
    console.error('❌ Socket error:', error);
  });

  // Handle reconnection
  socket.on('reconnect', (attemptNumber) => {
    console.log('🔄 Client reconnected after', attemptNumber, 'attempts');
  });
});

// REST API Routes

// Get all conference rooms
app.get('/api/rooms', async (req, res) => {
  try {
    const rooms = await ConferenceRoom.find();
    res.json({ success: true, data: rooms });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get specific room
app.get('/api/rooms/:roomName', async (req, res) => {
  try {
    const room = await ConferenceRoom.findOne({ roomName: req.params.roomName });
    if (!room) {
      return res.status(404).json({ success: false, error: 'Room not found' });
    }
    res.json({ success: true, data: room });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Create or update room
app.post('/api/rooms', async (req, res) => {
  try {
    const { roomName, doorAccess } = req.body;
    
    let room = await ConferenceRoom.findOne({ roomName });
    
    if (room) {
      room.doorAccess = doorAccess !== undefined ? doorAccess : room.doorAccess;
      await room.save();
    } else {
      room = await ConferenceRoom.create({ roomName, doorAccess });
    }
    
    res.json({ success: true, data: room });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Update door access setting
app.patch('/api/rooms/:roomName/access', async (req, res) => {
  try {
    const { doorAccess } = req.body;
    const room = await ConferenceRoom.findOneAndUpdate(
      { roomName: req.params.roomName },
      { doorAccess },
      { new: true }
    );
    
    if (!room) {
      return res.status(404).json({ success: false, error: 'Room not found' });
    }
    
    res.json({ success: true, data: room });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Trigger door open (Main endpoint for Flutter app and Web interface)
app.post('/api/rooms/:roomName/trigger', async (req, res) => {
  try {
    const room = await ConferenceRoom.findOne({ roomName: req.params.roomName });
    
    if (!room) {
      return res.status(404).json({ 
        success: false, 
        error: 'Room not found' 
      });
    }
    
    // Check if door access is enabled
    if (!room.doorAccess) {
      return res.status(403).json({ 
        success: false, 
        error: 'Door access is disabled for this room' 
      });
    }
    
    // Check if any ESP32 is connected
    if (esp32Devices.size === 0) {
      return res.status(503).json({ 
        success: false, 
        error: 'No ESP32 devices connected' 
      });
    }
    
    // Send trigger command to all connected ESP32 devices
    let sentCount = 0;
    esp32Devices.forEach((device, socketId) => {
      try {
        device.socket.emit('door_trigger', { 
          roomName: req.params.roomName,
          duration: 3000, // 3 seconds
          timestamp: new Date().toISOString()
        });
        sentCount++;
        console.log('🚪 Door trigger sent to ESP32:', device.deviceId);
      } catch (error) {
        console.error('❌ Error sending to ESP32:', device.deviceId, error);
      }
    });
    
    if (sentCount === 0) {
      return res.status(503).json({ 
        success: false, 
        error: 'Failed to send trigger to ESP32 devices' 
      });
    }
    
    // Update last accessed time and log
    room.lastAccessed = new Date();
    room.accessLog.push({
      timestamp: new Date(),
      action: 'Door opened'
    });
    await room.save();
    
    res.json({ 
      success: true, 
      message: `Door trigger sent successfully to ${sentCount} device(s)`,
      data: room
    });
    
  } catch (error) {
    console.error('❌ Error in door trigger:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get access logs
app.get('/api/rooms/:roomName/logs', async (req, res) => {
  try {
    const room = await ConferenceRoom.findOne({ roomName: req.params.roomName });
    if (!room) {
      return res.status(404).json({ success: false, error: 'Room not found' });
    }
    res.json({ success: true, data: room.accessLog });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  const connectedDevices = Array.from(esp32Devices.values()).map(device => ({
    deviceId: device.deviceId,
    ip: device.ip,
    registeredAt: device.registeredAt,
    lastSeen: device.lastSeen
  }));

  res.json({ 
    success: true, 
    status: 'Server is running',
    esp32Connected: esp32Devices.size > 0,
    esp32Count: esp32Devices.size,
    connectedDevices: connectedDevices,
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// Get ESP32 devices status
app.get('/api/devices', (req, res) => {
  const devices = Array.from(esp32Devices.values()).map(device => ({
    socketId: device.socket.id,
    deviceId: device.deviceId,
    chipId: device.chipId,
    ip: device.ip,
    registeredAt: device.registeredAt,
    lastSeen: device.lastSeen,
    transport: device.socket.conn.transport.name
  }));

  res.json({
    success: true,
    count: devices.length,
    devices: devices
  });
});

// Root route
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

// Handle 404
app.use((req, res) => {
  res.status(404).json({ 
    success: false, 
    error: 'Route not found',
    path: req.path
  });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 WebSocket server ready`);
  console.log(`🌐 Web interface: http://localhost:${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/api/health`);
  console.log(`🔌 ESP32 devices: http://localhost:${PORT}/api/devices`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('👋 SIGTERM signal received: closing HTTP server');
  server.close(() => {
    console.log('✅ HTTP server closed');
    mongoose.connection.close(false, () => {
      console.log('✅ MongoDB connection closed');
      process.exit(0);
    });
  });
});

// Cleanup disconnected devices periodically
setInterval(() => {
  const now = new Date();
  esp32Devices.forEach((device, socketId) => {
    const timeSinceLastSeen = now - device.lastSeen;
    // Remove devices that haven't been seen in 5 minutes
    if (timeSinceLastSeen > 300000) {
      console.log('🧹 Removing stale ESP32 device:', device.deviceId);
      esp32Devices.delete(socketId);
    }
  });
}, 60000); // Check every minute
// --- server.js ---

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const http = require('http');
const dotenv = require('dotenv'); // For environment variables like MONGODB_URI

// FIX: For Socket.IO v2.x, the require returns the constructor function directly.
const SocketIOServer = require('socket.io'); 

// Load environment variables from .env file (if running locally)
dotenv.config();

const app = express();
const server = http.createServer(app);

// Enhanced Socket.IO configuration for ESP32 compatibility
// FIX: Call the constructor function directly
const io = SocketIOServer(server, { 
  cors: {
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    credentials: true,
    allowedHeaders: ["Content-Type"]
  },
  transports: ['websocket', 'polling'],
  allowEIO3: true, // CRITICAL: Allows older Engine.IO v3 clients (like ESP32) to connect
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

// -----------------------------------------------------------------------------
// MONGODB SCHEMA AND CONNECTION
// -----------------------------------------------------------------------------

// Define a simple schema for Rooms
const RoomSchema = new mongoose.Schema({
  roomName: { type: String, required: true, unique: true },
  deviceId: { type: String, required: true, unique: true },
  doorAccess: { type: Boolean, default: false }
});
const Room = mongoose.model('Room', RoomSchema);

// Define a simple schema for Logs
const LogSchema = new mongoose.Schema({
  roomName: { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
  action: { type: String, required: true }, // e.g., "DOOR_OPENED", "ACCESS_DENIED"
  type: { type: String, enum: ['success', 'failure'], required: true }
});
const Log = mongoose.model('Log', LogSchema);


// MongoDB Connection
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://ajithtest95:ajith%40123@cluster0.n3qvh.mongodb.net/door';

mongoose.connect(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => {
  console.log('✅ MongoDB connected successfully');
}).catch(err => {
  console.error('❌ MongoDB connection error:', err);
});

// -----------------------------------------------------------------------------
// SOCKET.IO LOGIC & DEVICE TRACKING
// -----------------------------------------------------------------------------

// Simple in-memory device tracking
let devices = [];
let esp32Connected = false;

// Function to find the room associated with a connected ESP32
const getRoomByDeviceId = (deviceId) => {
    return Room.findOne({ deviceId });
};

io.on('connection', (socket) => {
  console.log(`📱 Client connected: ${socket.id}. Transport: ${socket.conn.transport.name}`);
  
  socket.on('esp32_register', async (data) => {
    const { deviceId, chipId, ip } = data;
    
    // Check if device is already registered
    let existingDevice = devices.find(d => d.deviceId === deviceId);

    if (!existingDevice) {
        // Register new device
        const room = await getRoomByDeviceId(deviceId);
        
        devices.push({
            socketId: socket.id,
            deviceId: deviceId,
            chipId: chipId,
            roomName: room ? room.roomName : 'Unassigned',
            ip: ip,
            connectedAt: new Date(),
        });
        
        esp32Connected = true;
        
        console.log(`📡 ESP32 Registered: ${deviceId} (${room ? room.roomName : 'Unassigned'})`);
        socket.emit('registered', { success: true });
        
        // Notify web clients
        io.emit('device_update', { devices: devices, esp32Count: devices.length });

    } else {
        // Update existing device's socketId
        existingDevice.socketId = socket.id;
        existingDevice.ip = ip;
        esp32Connected = true;
    }
  });

  socket.on('door_opened_feedback', async (data) => {
    const { deviceId, roomName } = data;
    
    console.log(`🚪 Door opened feedback received for ${roomName}`);
    
    // Log the event
    await Log.create({ 
        roomName: roomName, 
        action: 'DOOR_OPENED',
        type: 'success'
    });

    // Notify web clients
    io.emit('log_update', { roomName: roomName, action: 'DOOR_OPENED', timestamp: new Date() });
  });

  socket.on('disconnect', () => {
    console.log(`❌ Client disconnected: ${socket.id}`);
    
    // Remove device from tracking
    const index = devices.findIndex(d => d.socketId === socket.id);
    if (index !== -1) {
        devices.splice(index, 1);
    }
    
    // Update global status
    esp32Connected = devices.some(d => d.roomName !== 'Unassigned');
    
    // Notify web clients
    io.emit('device_update', { devices: devices, esp32Count: devices.length });
  });
});

// Cleanup disconnected devices periodically
setInterval(() => {
    devices = devices.filter(d => io.sockets.connected[d.socketId]);
    esp32Connected = devices.some(d => d.roomName !== 'Unassigned');
    io.emit('device_update', { devices: devices, esp32Count: devices.length });
}, 60000); // Check every 60 seconds

// -----------------------------------------------------------------------------
// API ROUTES
// -----------------------------------------------------------------------------

// API to get all rooms
app.get('/api/rooms', async (req, res) => {
    try {
        const rooms = await Room.find({});
        res.status(200).json({ success: true, rooms });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// API to add a new room
app.post('/api/rooms', async (req, res) => {
    try {
        const { roomName, deviceId, doorAccess } = req.body;
        const newRoom = new Room({ roomName, deviceId, doorAccess });
        await newRoom.save();
        io.emit('room_update'); // Notify all clients
        res.status(201).json({ success: true, room: newRoom });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

// API to trigger the door
// API to trigger the door
app.post('/api/trigger/:deviceId', async (req, res) => {
    const { deviceId } = req.params;
    const { duration = 3000 } = req.body;
    
    console.log(`🔍 Looking for device: ${deviceId}`);
    console.log(`📊 Currently connected devices:`, devices.map(d => d.deviceId));
    
    // Try different device ID formats for flexibility
    let targetDevice = devices.find(d => d.deviceId === deviceId);
    
    // If not found, try without "ESP32_" prefix
    if (!targetDevice && deviceId.startsWith('ESP32_')) {
        const shortId = deviceId.replace('ESP32_', '');
        targetDevice = devices.find(d => d.deviceId === shortId || d.deviceId.endsWith(shortId));
    }
    
    // If still not found, try with "ESP32_" prefix
    if (!targetDevice && !deviceId.startsWith('ESP32_')) {
        const fullId = 'ESP32_' + deviceId;
        targetDevice = devices.find(d => d.deviceId === fullId);
    }
    
    if (!targetDevice) {
        console.log(`❌ Device not found: ${deviceId}`);
        await Log.create({ 
            roomName: deviceId, 
            action: `TRIGGER_FAILED: Device ${deviceId} not connected.`,
            type: 'failure'
        });
        return res.status(404).json({ 
            success: false, 
            error: `ESP32 device ${deviceId} not connected or not found.`,
            connectedDevices: devices.map(d => d.deviceId)
        });
    }
    
    const room = await getRoomByDeviceId(targetDevice.deviceId);

    console.log(`🎯 Sending trigger to device: ${targetDevice.deviceId}, room: ${room ? room.roomName : 'Unassigned'}`);
    
    // Send the Socket.IO command to the specific ESP32 client
    io.to(targetDevice.socketId).emit('door_trigger', {
        roomName: room ? room.roomName : targetDevice.deviceId,
        duration: duration
    });
    
    // Log the trigger event
    await Log.create({ 
        roomName: room ? room.roomName : targetDevice.deviceId, 
        action: `DOOR_TRIGGER_SENT`,
        type: 'success'
    });
    
    res.status(200).json({ 
        success: true, 
        message: `Trigger command sent to device: ${targetDevice.deviceId}`,
        roomName: room ? room.roomName : 'Unassigned'
    });
});
    const room = await getRoomByDeviceId(deviceId);

    // Send the Socket.IO command to the specific ESP32 client
    io.to(targetDevice.socketId).emit('door_trigger', {
        roomName: room ? room.roomName : deviceId,
        duration: duration
    });
    
    res.status(200).json({ success: true, message: `Trigger command sent to device: ${deviceId}` });
});

// API to get logs for a room
app.get('/api/logs/:roomName', async (req, res) => {
    const { roomName } = req.params;
    try {
        const logs = await Log.find({ roomName }).sort({ timestamp: -1 }).limit(50);
        res.status(200).json({ success: true, logs });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});


// Health check route
app.get('/api/health', (req, res) => {
  res.status(200).json({
    success: true,
    status: 'Server is running',
    esp32Connected: esp32Connected,
    esp32Count: devices.length,
    connectedDevices: devices.map(d => ({ deviceId: d.deviceId, roomName: d.roomName, ip: d.ip })),
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
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

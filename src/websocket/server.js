/**
 * WebSocket Server for Real-Time Updates
 * TOC Project - Airport Management System
 */

const { Server } = require('socket.io');

let io = null;

// Initialize WebSocket server
function initializeWebSocket(server) {
  io = new Server(server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    },
    pingTimeout: 60000,
    pingInterval: 25000
  });

  // Connection handlers
  io.on('connection', (socket) => {
    console.log(`[WS] Client connected: ${socket.id}, User: anonymous`);

    // Join room based on user role
    socket.join('admins');
    socket.join(`user_${socket.id}`);
    if (socket.user.branchId) {
      socket.join(`branch_${socket.user.branchId}`);
    }

    // Handle equipment subscription
    socket.on('subscribe:equipment', (equipmentId) => {
      socket.join(`equipment_${equipmentId}`);
      console.log(`[WS] Socket ${socket.id} subscribed to equipment ${equipmentId}`);
    });

    socket.on('unsubscribe:equipment', (equipmentId) => {
      socket.leave(`equipment_${equipmentId}`);
      console.log(`[WS] Socket ${socket.id} unsubscribed from equipment ${equipmentId}`);
    });

    // Handle airport subscription
    socket.on('subscribe:airport', (airportId) => {
      socket.join(`airport_${airportId}`);
      console.log(`[WS] Socket ${socket.id} subscribed to airport ${airportId}`);
    });

    socket.on('unsubscribe:airport', (airportId) => {
      socket.leave(`airport_${airportId}`);
    });

    // Handle disconnection
    socket.on('disconnect', (reason) => {
      console.log(`[WS] Client disconnected: ${socket.id}, Reason: ${reason}`);
    });

    // Handle ping
    socket.on('ping', () => {
      socket.emit('pong', { timestamp: Date.now() });
    });
  });

  console.log('[WS] WebSocket server initialized');
  return io;
}

module.exports = { initializeWebSocket };

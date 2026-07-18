require('dotenv').config();
const db = require('./src/database/db');
const { publishMessage } = require('./src/services/command_publisher') || require('./src/services/rabbitmq');

console.log("Checking DB connection and Publisher...");

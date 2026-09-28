const mysql = require('mysql2/promise');
require('dotenv').config();

const config = {
  host: process.env.CENTRAL_DB_HOST || '172.20.16.117',
  port: parseInt(process.env.CENTRAL_DB_PORT || '3306', 10),
  database: process.env.CENTRAL_DB_NAME || 'smart_toc',
  user: process.env.CENTRAL_DB_USER || 'smarttoc',
  password: process.env.CENTRAL_DB_PASS || 'OrangHebat3rnap!',
  connectionLimit: 10,
  connectTimeout: 3000
};

const pool = mysql.createPool(config);

async function queryWithRetry(sql, params = [], maxRetries = 3) {
  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      const [rows, fields] = await pool.query(sql, params);
      return [rows, fields];
    } catch (err) {
      attempt++;
      console.error(`[CENTRAL DB] Query failed (attempt ${attempt}/${maxRetries}): ${err.message}`);
      if (err.code === 'PROTOCOL_CONNECTION_LOST' || err.code === 'ECONNRESET') {
        if (attempt >= maxRetries) throw err;
        await new Promise(r => setTimeout(r, 1000 * attempt));
      } else {
        throw err;
      }
    }
  }
}

module.exports = {
  pool,
  queryWithRetry
};

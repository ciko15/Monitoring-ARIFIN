import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'test',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

async function diagnostic() {
  try {
    console.log('--- Database Diagnostic ---');
    console.log(`Connecting to: ${process.env.DB_NAME || 'test'} as ${process.env.DB_USER}`);

    const [users]: any = await pool.query('SELECT count(*) as count FROM users');
    console.log(`Users count: ${users[0].count}`);

    const [equipmentTemplates]: any = await pool.query('SELECT count(*) as count FROM equipment_templates');
    console.log(`Equipment Templates count: ${equipmentTemplates[0].count}`);

    const [snmpTemplates]: any = await pool.query('SELECT count(*) as count FROM snmp_templates');
    console.log(`SNMP Templates count: ${snmpTemplates[0].count}`);

    const [airports]: any = await pool.query('SELECT count(*) as count FROM airports');
    console.log(`Airports count: ${airports[0].count}`);

    if (users[0].count > 0) {
      const [userList]: any = await pool.query('SELECT id, username, role FROM users');
      console.log('Users preview:', userList);
    }

    process.exit(0);
  } catch (error) {
    console.error('Diagnostic failed:', error);
    process.exit(1);
  }
}

diagnostic();

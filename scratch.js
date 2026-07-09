const EquipmentService = require('./src/services/equipment.js');
const db = require('./db/database.js');

async function test() {
  const svc = new EquipmentService(db);
  const parsedData = { mode: 'PASSIVE' }; // Mimic what network_listener passes for TX 1 APP
  await svc.saveToLogs('1775111531489', parsedData, 'tcp', 'Normal');
  console.log("Done");
}
test().catch(console.error);

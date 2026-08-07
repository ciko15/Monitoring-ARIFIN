const db = require('./db/database.js');

async function test() {
    const eq = await db.getAllEquipment({ includeData: true });
    console.log(JSON.stringify(eq.data.map(e => ({ name: e.name, status: e.status, sources: Object.values(e.lastData || {}).map(s => s._status) })), null, 2));
}

test();

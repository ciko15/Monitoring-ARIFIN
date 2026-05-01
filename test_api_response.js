const db = require('./db/database');

async function test() {
    const result = await db.getAllEquipment({ includeData: true });
    const equipment = result.data.find(e => e.name === 'DME Sentani');
    console.log('DME Sentani lastData:', JSON.stringify(equipment.lastData, null, 2));
    console.log('DME Sentani lastUpdate:', equipment.lastUpdate);
}

test();

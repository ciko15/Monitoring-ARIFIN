const db = require('./db/database.js');
async function test() {
    const result = await db.getAllEquipment();
    const list = result.data || result;
    if(list.length > 0) {
        console.log("First:", JSON.stringify(list[0], null, 2));
    }
}
test().catch(console.error);

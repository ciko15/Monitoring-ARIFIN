const db = require('./src/database/db');
db.all('SELECT * FROM equipment', (err, rows) => {
  if (err) console.error(err);
  else console.log('Cabang Total Equipments:', rows.length);
});

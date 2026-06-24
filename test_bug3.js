const db = require('./db/database.js');
db.getAllEquipment({includeData: true}).then(res => {
  res.data.forEach(eq => {
    if (eq.lastData) {
      Object.keys(eq.lastData).forEach(src => {
        const d = eq.lastData[src];
        if (d && d._status === 'Disconnect' && Object.keys(d).some(k => typeof d[k] === 'number')) {
          console.log(`Found disconnected source WITH numbers: ${eq.name} -> ${src}`);
          console.log(d);
        }
      });
    }
  });
});

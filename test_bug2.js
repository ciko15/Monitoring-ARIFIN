const db = require('./db/database.js');
db.getAllEquipment({includeData: true}).then(res => {
  const eq = res.data.find(e => String(e.id) === '1777400000202');
  const mergedData = eq.lastData['Localizer'];
  const paramLabels = { CRS_RF: 'CRS RF Level' };
  Object.entries(paramLabels).forEach(([key, label]) => {
     console.log(`${key}: ${mergedData[key]}`);
  });
});

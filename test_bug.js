const db = require('./db/database.js');
db.getEquipmentById(1777400000202).then(res => {
  const mergedData = res.lastData['Localizer'];
  const paramLabels = { CRS_RF: 'CRS RF Level' };
  Object.entries(paramLabels).forEach(([key, label]) => {
     console.log(`${key}: ${mergedData[key]}`);
  });
});

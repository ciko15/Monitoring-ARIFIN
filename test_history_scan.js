const fs = require('fs');
const path = require('path');

function getLatestTimestampFromHistory(equipmentName) {
  try {
    const baseDir = path.resolve(__dirname, 'data');
    console.log('Scanning baseDir:', baseDir);
    if (!fs.existsSync(baseDir)) {
        console.log('baseDir does not exist');
        return null;
    }

    const safeName = equipmentName.toLowerCase().replace(/[^a-z0-9\s_-]/gi, '_').replace(/\s+/g, '_').substring(0, 50);
    const fileName = `${safeName}.log`;
    console.log('Looking for fileName:', fileName);

    const months = fs.readdirSync(baseDir)
      .filter(f => /^\d{4}-\d{2}$/.test(f))
      .sort((a, b) => b.localeCompare(a));
    console.log('Found months:', months);

    for (const month of months) {
      const monthPath = path.join(baseDir, month);
      const days = fs.readdirSync(monthPath)
        .filter(f => /^\d{2}$/.test(f))
        .sort((a, b) => b.localeCompare(a));
      console.log(`Checking month ${month}, found days:`, days);

      for (const day of days) {
        const filePath = path.join(monthPath, day, fileName);
        if (fs.existsSync(filePath)) {
          console.log('FOUND file at:', filePath);
          const stats = fs.statSync(filePath);
          const content = fs.readFileSync(filePath, 'utf8').trim().split('\n');
          if (content.length > 0) {
            try {
              const lastLine = JSON.parse(content[content.length - 1]);
              console.log('Last line timestamp:', lastLine.timestamp);
              return lastLine.timestamp;
            } catch (e) {
              console.log('Parse error, using mtime');
              return stats.mtime.toISOString();
            }
          }
          return stats.mtime.toISOString();
        }
      }
    }
  } catch (err) {
    console.error('Error:', err);
  }
  return null;
}

const result = getLatestTimestampFromHistory('DVOR Sentani');
console.log('Result for DVOR Sentani:', result);

const result2 = getLatestTimestampFromHistory('DME Sentani');
console.log('Result for DME Sentani:', result2);

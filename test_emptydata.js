const log = {
  data: {
    CRS_RF: "98.2",
    TX_MAIN: "Active"
  }
};
const mergedData = { default: { CRS_RF: "98.2", TX_MAIN: "Active" } };
const sourceName = "default";

const emptyData = {};
if (log.data) Object.keys(log.data).forEach(k => emptyData[k] = '-');

mergedData[sourceName] = { 
  ...mergedData[sourceName], 
  ...emptyData, 
  _status: 'Disconnect', 
  _logged_at: "2026-06-24", 
};
console.log(mergedData[sourceName]);

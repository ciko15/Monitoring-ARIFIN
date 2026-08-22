const ModbusRTU = require('modbus-serial');

const IP = process.argv[2] || '192.168.26.57';
const PORT = parseInt(process.argv[3]) || 502;

async function scanModbus() {
    console.log(`Starting Modbus scanner on ${IP}:${PORT}...`);
    
    for (let slaveId = 1; slaveId <= 20; slaveId++) {
        const client = new ModbusRTU();
        client.setTimeout(1000); 
        
        try {
            await client.connectTelnet(IP, { port: PORT });
            client.setID(slaveId);
            
            // Try to read holding registers 0-2 (typically Temp/Humidity)
            const res = await client.readHoldingRegisters(0, 2);
            console.log(`[SUCCESS] Found active Slave ID: ${slaveId} | Data: ${JSON.stringify(res.data)}`);
        } catch (err) {
            if (err.message.includes('ECONNREFUSED')) {
                console.log(`[ERROR] Connection refused to ${IP}:${PORT}. Gateway might be down or port is wrong.`);
                break; // Stop scanning if connection is refused
            } else {
                console.log(`[INFO] Slave ID ${slaveId} responded with error: ${err.message}`);
            }
        } finally {
            try { client.close(); } catch(e) {}
        }
    }
    
    console.log('Scanning finished.');
}

scanModbus();

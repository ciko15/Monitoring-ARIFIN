function crc16_ccitt(buffer) {
    let crc = 0xFFFF;
    for (let i = 0; i < buffer.length; i++) {
        crc ^= buffer[i] << 8;
        for (let j = 0; j < 8; j++) {
            if ((crc & 0x8000) > 0) crc = (crc << 1) ^ 0x1021;
            else crc = crc << 1;
        }
    }
    return (crc & 0xFFFF).toString(16).padStart(4, '0');
}

function crc16_modbus(buffer) {
    let crc = 0xFFFF;
    for (let i = 0; i < buffer.length; i++) {
        crc ^= buffer[i];
        for (let j = 0; j < 8; j++) {
            if ((crc & 1) > 0) crc = (crc >> 1) ^ 0xA001;
            else crc = crc >> 1;
        }
    }
    // Swap bytes for hex output if needed
    // return ((crc & 0xFF) << 8 | (crc >> 8)).toString(16).padStart(4, '0');
    return crc.toString(16).padStart(4, '0');
}

const ids = [4, 7, 29, 45, 48, 56, 104];
const checksums = ['3f4a', '5c7a', '27c9', '74ff', 'e83c', 'e0bd', '15e7'];

ids.forEach((id, i) => {
    let hex = '02020a3019061e0100010000' + id.toString(16).padStart(2, '0');
    let buf = Buffer.from(hex, 'hex');
    console.log(`ID ${id}: expected ${checksums[i]}`);
    console.log(`ccitt: ${crc16_ccitt(buf)}`);
    console.log(`modbus: ${crc16_modbus(buf)}`);
});

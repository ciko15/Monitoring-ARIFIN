'use strict';

const SENSOR_OID = {
    entPhysicalName:     [1, 3, 6, 1, 2, 1, 47, 1, 1, 1, 1, 7],
    entPhySensorType:    [1, 3, 6, 1, 2, 1, 99, 1, 1, 1, 1],
    entPhySensorScale:   [1, 3, 6, 1, 2, 1, 99, 1, 1, 1, 2],
    entPhySensorValue:   [1, 3, 6, 1, 2, 1, 99, 1, 1, 1, 4],
    entPhySensorOper:    [1, 3, 6, 1, 2, 1, 99, 1, 1, 1, 5],
    alcatelChassisBoardTemp: [1, 3, 6, 1, 4, 1, 6486, 800, 1, 1, 1, 3, 1, 1, 3, 1, 4],
    alcatelChassisTempLatest: [1, 3, 6, 1, 4, 1, 6486, 800, 1, 2, 1, 16, 1, 1, 1, 17, 0],
    ucdTemperatureLabel: [1, 3, 6, 1, 4, 1, 2021, 13, 16, 2, 1, 2],
    ucdTemperatureValue: [1, 3, 6, 1, 4, 1, 2021, 13, 16, 2, 1, 3],
};

const SENSOR_TYPE_CELSIUS = 8;
const SENSOR_SCALE_MAP = {
    1: 1e-24,
    2: 1e-21,
    3: 1e-18,
    4: 1e-15,
    5: 1e-12,
    6: 1e-9,
    7: 1e-6,
    8: 1e-3,
    9: 1,
    10: 1e3,
    11: 1e6,
    12: 1e9,
    13: 1e12,
    14: 1e15,
    15: 1e18,
    16: 1e21,
    17: 1e24,
};

function toIndexMap(vbs) {
    const map = {};
    for (const vb of vbs || []) {
        const idx = vb.oid[vb.oid.length - 1];
        map[idx] = vb.value;
    }
    return map;
}

function parseSensorNumber(value) {
    if (typeof value === 'bigint') return Number(value);
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function parseSensorText(value, fallback = 'sensor') {
    const text = String(value || '').trim();
    return text || fallback;
}

function isSensorOperational(code) {
    const value = Number(code);
    return !Number.isFinite(value) || value === 1;
}

function scaleSensorValue(rawValue, scaleCode) {
    const baseValue = parseSensorNumber(rawValue);
    if (baseValue === null) return null;

    const factor = SENSOR_SCALE_MAP[Number(scaleCode)] || 1;
    return baseValue * factor;
}

async function readTemperatureSensors(session, snmpWalk) {
    const [nameVbs, typeVbs, scaleVbs, valueVbs, operVbs] = await Promise.all([
        snmpWalk(session, SENSOR_OID.entPhysicalName),
        snmpWalk(session, SENSOR_OID.entPhySensorType),
        snmpWalk(session, SENSOR_OID.entPhySensorScale),
        snmpWalk(session, SENSOR_OID.entPhySensorValue),
        snmpWalk(session, SENSOR_OID.entPhySensorOper),
    ]);

    const nameMap = toIndexMap(nameVbs);
    const typeMap = toIndexMap(typeVbs);
    const scaleMap = toIndexMap(scaleVbs);
    const valueMap = toIndexMap(valueVbs);
    const operMap = toIndexMap(operVbs);

    const sensors = Object.keys(typeMap)
        .filter((idx) => Number(typeMap[idx]) === SENSOR_TYPE_CELSIUS)
        .map((idx) => {
            const scaledValue = scaleSensorValue(valueMap[idx], scaleMap[idx]);
            if (scaledValue === null) return null;

            return {
                index: idx,
                name: parseSensorText(nameMap[idx], `sensor-${idx}`),
                value_c: scaledValue,
                status: isSensorOperational(operMap[idx]) ? 'ok' : 'unavailable',
            };
        })
        .filter((sensor) => sensor && Number.isFinite(sensor.value_c));

    const activeSensors = sensors.filter((sensor) => sensor.status === 'ok');
    const hottest = activeSensors
        .slice()
        .sort((a, b) => b.value_c - a.value_c)[0] || null;

    return {
        sensors: activeSensors,
        hottest,
    };
}

async function readAlcatelTemperature(session, snmpWalk, snmpGet) {
    const [walkVbs, latestValue] = await Promise.all([
        snmpWalk(session, SENSOR_OID.alcatelChassisBoardTemp),
        snmpGet(session, SENSOR_OID.alcatelChassisTempLatest),
    ]);

    const walkMap = toIndexMap(walkVbs);
    const chassisValue = parseSensorNumber(walkMap[569]);
    const latest = parseSensorNumber(latestValue);
    const temperature = latest ?? chassisValue;

    if (temperature === null) {
        return { sensors: [], hottest: null };
    }

    return {
        sensors: [{
            index: '569',
            name: 'Chassis',
            value_c: temperature,
            status: 'ok',
        }],
        hottest: {
            index: '569',
            name: 'Chassis',
            value_c: temperature,
            status: 'ok',
        },
    };
}

async function readUcdTemperatureSensors(session, snmpWalk) {
    const [labelVbs, valueVbs] = await Promise.all([
        snmpWalk(session, SENSOR_OID.ucdTemperatureLabel),
        snmpWalk(session, SENSOR_OID.ucdTemperatureValue),
    ]);

    const labelMap = toIndexMap(labelVbs);
    const valueMap = toIndexMap(valueVbs);

    const sensors = Object.keys(valueMap)
        .map((idx) => {
            const rawValue = parseSensorNumber(valueMap[idx]);
            if (rawValue === null) return null;

            return {
                index: idx,
                name: parseSensorText(labelMap[idx], `sensor-${idx}`),
                value_c: rawValue / 1000,
                status: 'ok',
            };
        })
        .filter((sensor) => sensor && Number.isFinite(sensor.value_c));

    const hottest = sensors
        .slice()
        .sort((a, b) => b.value_c - a.value_c)[0] || null;

    return {
        sensors,
        hottest,
    };
}

module.exports = {
    readAlcatelTemperature,
    readUcdTemperatureSensors,
    readTemperatureSensors,
};

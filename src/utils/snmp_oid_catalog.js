'use strict';

const path = require('path');
const db = require('../../db/database');

const CATALOG_PATH = path.join(__dirname, '../../db/snmp_oid_catalog.json');

async function getCatalog() {
  return await db.readJson(CATALOG_PATH, []);
}

function normalizeOid(oid) {
  const value = Array.isArray(oid) ? oid.join('.') : String(oid || '');
  return value.startsWith('.') ? value.slice(1) : value;
}

function lookupOidEntry(oid, catalog) {
  const normalized = normalizeOid(oid);
  let bestMatch = null;
  let bestLength = -1;

  for (const entry of catalog) {
    if (entry.oid && normalizeOid(entry.oid) === normalized) {
      return entry;
    }

    if (entry.oid_prefix) {
      const prefix = normalizeOid(entry.oid_prefix);
      if ((normalized === prefix || normalized.startsWith(`${prefix}.`)) && prefix.length > bestLength) {
        bestMatch = entry;
        bestLength = prefix.length;
      }
    }
  }

  return bestMatch;
}

function formatValue(rawValue, entry) {
  if (!entry) return String(rawValue ?? '');

  if (entry.scale && rawValue !== null && rawValue !== undefined && !Number.isNaN(Number(rawValue))) {
    const scaled = Number(rawValue) / Number(entry.scale);
    return entry.unit === 'milliC' ? `${scaled.toFixed(1)} C` : String(scaled);
  }

  if (entry.unit) {
    return `${rawValue} ${entry.unit}`;
  }

  return String(rawValue ?? '');
}

function enrichVarBind(vb, catalog) {
  const oid = normalizeOid(vb?.oid);
  const entry = lookupOidEntry(oid, catalog);

  return {
    oid: `.${oid}`,
    rawOid: oid,
    value: String(vb?.value ?? ''),
    displayValue: formatValue(vb?.value, entry),
    name: entry?.name || null,
    label: entry?.label || null,
    category: entry?.category || null,
    mib: entry?.mib || null,
    description: entry?.description || null,
    profiles: entry?.profiles || [],
    matchedBy: entry?.oid ? 'exact' : (entry?.oid_prefix ? 'prefix' : null)
  };
}

function formatBindingLine(binding) {
  const title = binding.label || binding.name || 'Unknown OID';
  const meta = [binding.category, binding.mib].filter(Boolean).join(' | ');
  const metaSuffix = meta ? ` [${meta}]` : '';
  return `${binding.oid} = ${binding.displayValue}  // ${title}${metaSuffix}`;
}

module.exports = {
  getCatalog,
  enrichVarBind,
  formatBindingLine,
  lookupOidEntry,
  normalizeOid
};

const fs = require('fs');

let content = fs.readFileSync('db/database.js', 'utf8');

// Remove centralDb import
content = content.replace("const centralDb = require('./central_db');\n", "");

// Replace SNMP Templates
content = content.replace(/async function getAllSnmpTemplates\(\) \{[\s\S]*?async function getSnmpTemplateById/, `async function getAllSnmpTemplates() {
  const templates = await readJson(TEMPLATE_CONFIG_PATH);
  return templates.map(t => ({
    ...t,
    oidMappings: typeof t.oid_mappings === 'string' ? JSON.parse(t.oid_mappings || '{}') : (t.oid_mappings || t.oidMappings || {}),
    oidBase: t.oid_base || t.oidBase || '',
    category: t.category || '',
    isDefault: !!t.isDefault || !!t.is_default
  }));
}

async function getSnmpTemplateById`);

content = content.replace(/async function getSnmpTemplateById\(id\) \{[\s\S]*?async function createSnmpTemplate/, `async function getSnmpTemplateById(id) {
  const templates = await getAllSnmpTemplates();
  return templates.find(t => String(t.id) === String(id)) || null;
}

async function createSnmpTemplate`);

content = content.replace(/async function createSnmpTemplate\(data\) \{[\s\S]*?async function updateSnmpTemplate/, `async function createSnmpTemplate(data) {
  const templates = await readJson(TEMPLATE_CONFIG_PATH);
  const newId = data.id || \`custom_\${Date.now()}\`;
  const newItem = {
    id: newId,
    name: data.name,
    description: data.description || '',
    oid_base: data.oidBase || '',
    oid_mappings: data.oidMappings || {},
    category: data.category || '',
    is_default: data.isDefault ? 1 : 0
  };
  templates.push(newItem);
  await writeJson(TEMPLATE_CONFIG_PATH, templates);
  return await getSnmpTemplateById(newId);
}

async function updateSnmpTemplate`);

content = content.replace(/async function updateSnmpTemplate\(id, data\) \{[\s\S]*?async function deleteSnmpTemplate/, `async function updateSnmpTemplate(id, data) {
  const templates = await readJson(TEMPLATE_CONFIG_PATH);
  const index = templates.findIndex(t => String(t.id) === String(id));
  if (index !== -1) {
    if (data.name !== undefined) templates[index].name = data.name;
    if (data.description !== undefined) templates[index].description = data.description;
    if (data.oidBase !== undefined) { templates[index].oid_base = data.oidBase; templates[index].oidBase = data.oidBase; }
    if (data.oidMappings !== undefined) { templates[index].oid_mappings = data.oidMappings; templates[index].oidMappings = data.oidMappings; }
    if (data.category !== undefined) templates[index].category = data.category;
    if (data.isDefault !== undefined) { templates[index].is_default = data.isDefault ? 1 : 0; templates[index].isDefault = data.isDefault; }
    await writeJson(TEMPLATE_CONFIG_PATH, templates);
  }
  return await getSnmpTemplateById(id);
}

async function deleteSnmpTemplate`);

content = content.replace(/async function deleteSnmpTemplate\(id\) \{[\s\S]*?\/\/ --- SUP CATEGORIES ---/, `async function deleteSnmpTemplate(id) {
  const templates = await readJson(TEMPLATE_CONFIG_PATH);
  const newTemplates = templates.filter(t => String(t.id) !== String(id));
  await writeJson(TEMPLATE_CONFIG_PATH, newTemplates);
  return true;
}

// --- SUP CATEGORIES ---`);

// Replace Sup Categories
content = content.replace(/async function getAllSupCategories\(\) \{[\s\S]*?async function getSupCategoriesByCategory/, `async function getAllSupCategories() {
  return await readJson(SUP_CATEGORY_PATH);
}

async function getSupCategoriesByCategory`);

content = content.replace(/async function getSupCategoriesByCategory\(category\) \{[\s\S]*?async function createSupCategory/, `async function getSupCategoriesByCategory(category) {
  const all = await readJson(SUP_CATEGORY_PATH);
  if (!category) return all;
  return all.find(c => c.category === category) || { category: category, sub_categories: [] };
}

async function createSupCategory`);

content = content.replace(/async function createSupCategory\(data\) \{[\s\S]*?async function deleteSupCategory/, `async function createSupCategory(data) {
  let all = await readJson(SUP_CATEGORY_PATH);
  let existing = all.find(c => c.category === data.category);
  if (!existing) {
    existing = { id: data.category.toLowerCase(), category: data.category, sub_categories: [] };
    all.push(existing);
  }
  
  const subs = data.sub_categories || [];
  for (const sub of subs) {
    if (!existing.sub_categories.includes(sub)) {
      existing.sub_categories.push(sub);
    }
  }
  
  await writeJson(SUP_CATEGORY_PATH, all);
  return existing;
}

async function deleteSupCategory`);

content = content.replace(/async function deleteSupCategory\(id\) \{[\s\S]*?async function updateSupCategory/, `async function deleteSupCategory(id) {
  let all = await readJson(SUP_CATEGORY_PATH);
  all = all.filter(c => c.category !== id && c.id !== id);
  await writeJson(SUP_CATEGORY_PATH, all);
  return true;
}

async function updateSupCategory`);

content = content.replace(/async function updateSupCategory\(category, subCategories\) \{[\s\S]*?\/\/ --- EQUIPMENT OTENTICATION/, `async function updateSupCategory(category, subCategories) {
  let all = await readJson(SUP_CATEGORY_PATH);
  let existing = all.find(c => c.category === category);
  if (!existing) {
    existing = { id: category.toLowerCase(), category: category, sub_categories: [] };
    all.push(existing);
  }
  existing.sub_categories = [...new Set([...existing.sub_categories, ...subCategories])];
  await writeJson(SUP_CATEGORY_PATH, all);
  return true;
}

// --- EQUIPMENT OTENTICATION`);

// Replace Limitations
content = content.replace(/async function getAllLimitations\(\) \{[\s\S]*?async function getLimitationsByEquipment/, `async function getAllLimitations() {
  return await readJson(LIMITATION_CONFIG_PATH);
}

async function getLimitationsByEquipment`);

content = content.replace(/async function createLimitation\(data\) \{[\s\S]*?async function updateLimitation/, `async function createLimitation(data) {
  let all = await readJson(LIMITATION_CONFIG_PATH);
  const id = Date.now();
  const unit = data.value_type === 'percent' ? '%' : (data.unit || '');
  const newItem = {
    id: id,
    template_id: data.template_id || null,
    name: data.name,
    label: data.name,
    source: data.source || data.name.toLowerCase().replace(/\\s+/g, '_'),
    unit: unit,
    value_type: data.value_type,
    min_warning_limit: data.min_warning_limit || data.wlv || null,
    min_alarm_limit: data.min_alarm_limit || data.alv || null,
    max_warning_limit: data.max_warning_limit || data.whv || null,
    max_alarm_limit: data.max_alarm_limit || data.ahv || null,
    sup_category: data.sup_category || null,
    category: data.category || 'Support'
  };
  all.push(newItem);
  await writeJson(LIMITATION_CONFIG_PATH, all);
  return newItem;
}

async function updateLimitation`);

content = content.replace(/async function updateLimitation\(id, data\) \{[\s\S]*?async function deleteLimitation/, `async function updateLimitation(id, data) {
  let all = await readJson(LIMITATION_CONFIG_PATH);
  const index = all.findIndex(l => String(l.id) === String(id));
  
  if (index !== -1) {
    const { configType, configId, configMode, ...cleanData } = data;
    
    if (cleanData.name !== undefined) { all[index].name = cleanData.name; all[index].label = cleanData.name; }
    if (cleanData.source !== undefined) all[index].source = cleanData.source;
    if (cleanData.value_type !== undefined || cleanData.unit !== undefined) { 
      all[index].unit = cleanData.value_type === 'percent' ? '%' : (cleanData.unit || '');
      all[index].value_type = cleanData.value_type;
    }
  
    const alv = cleanData.min_alarm_limit !== undefined ? cleanData.min_alarm_limit : cleanData.alv;
    const ahv = cleanData.max_alarm_limit !== undefined ? cleanData.max_alarm_limit : cleanData.ahv;
    const wlv = cleanData.min_warning_limit !== undefined ? cleanData.min_warning_limit : cleanData.wlv;
    const whv = cleanData.max_warning_limit !== undefined ? cleanData.max_warning_limit : cleanData.whv;
  
    if (alv !== undefined) all[index].min_alarm_limit = alv;
    if (ahv !== undefined) all[index].max_alarm_limit = ahv;
    if (wlv !== undefined) all[index].min_warning_limit = wlv;
    if (whv !== undefined) all[index].max_warning_limit = whv;
    
    await writeJson(LIMITATION_CONFIG_PATH, all);
    return all[index];
  }
  return null;
}

async function deleteLimitation`);

content = content.replace(/async function deleteLimitation\(id\) \{[\s\S]*?\/\/ --- USERS ---/, `async function deleteLimitation(id) {
  let all = await readJson(LIMITATION_CONFIG_PATH);
  all = all.filter(l => String(l.id) !== String(id));
  await writeJson(LIMITATION_CONFIG_PATH, all);
  return true;
}

// --- USERS ---`);

fs.writeFileSync('db/database.js', content);
console.log('Done!');

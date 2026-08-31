const fs = require('fs');
let content = fs.readFileSync('public/app.js', 'utf8');

// 1. Replace init logic in renderUniversalApiConfig
const initSearch = `      const container = document.getElementById('univApiMappingsContainer');
      if (container && univExtra.mappings && Array.isArray(univExtra.mappings)) {
          container.innerHTML = '';
          if (univExtra.mappings.length === 0) {
              container.innerHTML = '<div style="font-size:10px; color:#a0b4c4; text-align:center;">Klik "Sync Data" untuk memuat struktur JSON dari alat.</div>';
          } else {
              univExtra.mappings.forEach(map => {
                  const div = document.createElement('div');
                  div.style.display = 'flex';
                  div.style.gap = '8px';
                  div.style.alignItems = 'center';
                  div.style.borderBottom = '1px dashed rgba(255,255,255,0.1)';
                  div.style.paddingBottom = '4px';
                  div.innerHTML = \`
                      <input type="checkbox" class="univ-api-check" data-path="\${map.json_path}" checked style="cursor:pointer;">
                      <span style="font-size:11px; color:#fff; flex:1;" title="\${map.json_path}">
                          \${map.json_path}
                      </span>
                      <input type="text" class="univ-api-group" data-path="\${map.json_path}" value="\${map.group || ''}" placeholder="Group (Opsional)" style="width:100px; font-size:10px; padding:4px; border:1px solid #1a3a5c; background:#000; color:#0f0;">
                      <input type="text" class="univ-api-name" data-path="\${map.json_path}" value="\${map.name || ''}" placeholder="Nama Custom" style="width:110px; font-size:10px; padding:4px;">
                      <input type="number" class="univ-api-divisor" data-path="\${map.json_path}" value="\${map.divisor || 1}" placeholder="Divisor" style="width:60px; font-size:10px; padding:4px;">
                  \`;
                  container.appendChild(div);
              });
          }
      }`;

const initReplace = `      // Re-initialize Sortable groups
      window.univApiSortables = [];
      const availContainer = document.getElementById('univApiAvailableFields');
      const groupsContainer = document.getElementById('univApiGroupsContainer');
      if (availContainer) {
          availContainer.innerHTML = '';
          initUnivApiSortable(availContainer);
      }
      if (groupsContainer) {
          // Clear custom groups but keep root
          const customGroups = groupsContainer.querySelectorAll('.univ-api-group-box[data-is-custom="true"]');
          customGroups.forEach(g => g.remove());
          
          const rootDropzone = groupsContainer.querySelector('.univ-api-group-dropzone');
          if (rootDropzone) {
              rootDropzone.innerHTML = '';
              initUnivApiSortable(rootDropzone);
          }
      }
      
      if (univExtra.mappings && Array.isArray(univExtra.mappings)) {
          // Group mappings by group name
          const grouped = {};
          univExtra.mappings.forEach(m => {
              const g = m.group || '';
              if (!grouped[g]) grouped[g] = [];
              grouped[g].push(m);
          });
          
          for (const [gName, maps] of Object.entries(grouped)) {
              let dropzone = null;
              if (gName === '') {
                  dropzone = groupsContainer?.querySelector('.univ-api-group-dropzone');
              } else {
                  const box = addUnivApiGroup(gName);
                  dropzone = box.querySelector('.univ-api-group-dropzone');
              }
              
              if (dropzone) {
                  maps.forEach(map => {
                      dropzone.appendChild(createUnivApiMappingRow(map.json_path, map.name, map.divisor, true));
                  });
              }
          }
      }`;

content = content.replace(initSearch, initReplace);

// 2. Replace empty reset
const resetSearch = `    } else if (univApiDiv) {
      univApiDiv.style.display = 'none';
      const container = document.getElementById('univApiMappingsContainer');
      if (container) container.innerHTML = '<div style="font-size:10px; color:#a0b4c4; text-align:center;">Klik "Sync Data" untuk memuat struktur JSON dari alat.</div>';
    }`;

const resetReplace = `    } else if (univApiDiv) {
      univApiDiv.style.display = 'none';
      const container = document.getElementById('univApiAvailableFields');
      if (container) container.innerHTML = '<div style="font-size:10px; color:#a0b4c4; text-align:center; padding-top:20px;">Klik "Sync Data" untuk memuat struktur JSON dari alat.</div>';
    }`;

content = content.replace(resetSearch, resetReplace);

// 3. Update Sync Data handler
const syncSearch = `    const container = document.getElementById('univApiMappingsContainer');
    const icon = document.getElementById('syncApiIcon');
    if (icon) icon.className = 'fas fa-spinner fa-spin';
    if (container) container.innerHTML = '<div style="color:#00d4ff;">Fetching data dari API...</div>';`;

const syncReplace = `    const container = document.getElementById('univApiAvailableFields');
    const icon = document.getElementById('syncApiIcon');
    if (icon) icon.className = 'fas fa-spinner fa-spin';
    if (container) container.innerHTML = '<div style="color:#00d4ff; padding:8px;">Fetching data dari API...</div>';
    initUnivApiSortable(container); // Ensure available fields is sortable`;

content = content.replace(syncSearch, syncReplace);

// 4. Update Sync Data response parsing
const syncResultSearch = `            if (container) {
                container.innerHTML = '';
                flatKeys.forEach(key => {
                    const val = getNestedValue(data.data, key);
                    const displayVal = typeof val === 'object' ? JSON.stringify(val) : String(val);
                    const safeTitle = displayVal.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                    const safeDisplay = safeTitle; // Use same escaped string for display
                    let defaultName = key.split('.').pop();
                    const pathParts = key.split('.');
                    if ((defaultName === 'value' || defaultName === 'string_value') && pathParts.length >= 2) {
                        defaultName = pathParts[pathParts.length - 2]; // Ambil nama parameternya, bukan kata 'value'
                    }
                    const div = document.createElement('div');
                    div.className = 'univ-api-row';
                    div.setAttribute('data-path', key);
                    div.style.display = 'flex';
                    div.style.gap = '8px';
                    div.style.alignItems = 'center';
                    div.style.borderBottom = '1px dashed rgba(255,255,255,0.1)';
                    div.style.paddingBottom = '4px';
                    // Apply filter immediately if one exists
                    const filterTerm = document.getElementById('univApiFilter')?.value?.toLowerCase();
                    if (filterTerm && !key.toLowerCase().includes(filterTerm)) {
                        div.style.display = 'none';
                    }
                    
                    div.innerHTML = \`
                        <input type="checkbox" class="univ-api-check" data-path="\${key}" checked style="cursor:pointer;">
                        <span style="font-size:11px; color:#fff; flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="\${key} (Value: \${safeTitle})">
                            \${key} <span style="color:#a0b4c4;">(\${safeDisplay})</span>
                        </span>
                        <input type="text" class="univ-api-group" data-path="\${key}" value="" placeholder="Group (Opsional)" style="width:100px; font-size:10px; padding:4px; border:1px solid #1a3a5c; background:#000; color:#0f0;">
                        <input type="text" class="univ-api-name" data-path="\${key}" value="\${defaultName}" placeholder="Nama Custom" style="width:110px; font-size:10px; padding:4px;">
                        <input type="number" class="univ-api-divisor" data-path="\${key}" value="1" placeholder="Divisor" style="width:60px; font-size:10px; padding:4px;">
                    \`;
                    container.appendChild(div);
                });
            }`;

const syncResultReplace = `            if (container) {
                container.innerHTML = '';
                
                // Keep track of existing mapped paths so we don't duplicate them in available fields
                const existingPaths = new Set(getUniversalApiConfigs().map(m => m.json_path));
                
                flatKeys.forEach(key => {
                    if (existingPaths.has(key)) return; // Skip if already mapped
                    
                    let defaultName = key.split('.').pop();
                    const pathParts = key.split('.');
                    if ((defaultName === 'value' || defaultName === 'string_value') && pathParts.length >= 2) {
                        defaultName = pathParts[pathParts.length - 2]; 
                    }
                    
                    const row = createUnivApiMappingRow(key, defaultName, 1, false);
                    
                    const filterTerm = document.getElementById('univApiFilter')?.value?.toLowerCase();
                    if (filterTerm && !key.toLowerCase().includes(filterTerm)) {
                        row.style.display = 'none';
                    }
                    
                    container.appendChild(row);
                });
            }`;

content = content.replace(syncResultSearch, syncResultReplace);

// 5. Update getUniversalApiConfigs
const getSearch = `function getUniversalApiConfigs() {
    const container = document.getElementById('univApiMappingsContainer');
    if (!container) return [];
    const checks = container.querySelectorAll('.univ-api-check');
    const mappings = [];
    checks.forEach(check => {
        if (check.checked) {
            const path = check.getAttribute('data-path');
            const nameInput = container.querySelector(\`.univ-api-name[data-path="\${path}"]\`);
            const divInput = container.querySelector(\`.univ-api-divisor[data-path="\${path}"]\`);
            const groupInput = container.querySelector(\`.univ-api-group[data-path="\${path}"]\`);
            mappings.push({
                json_path: path,
                name: (nameInput && nameInput.value) ? nameInput.value : path.split('.').pop(),
                divisor: (divInput && divInput.value) ? parseFloat(divInput.value) : 1,
                group: (groupInput && groupInput.value) ? groupInput.value.trim() : ''
            });
        }
    });
    return mappings;
}`;

const getReplace = `function getUniversalApiConfigs() {
    const mappings = [];
    const groupBoxes = document.querySelectorAll('.univ-api-group-box');
    groupBoxes.forEach(box => {
        const groupName = box.getAttribute('data-group-name') || '';
        const rows = box.querySelectorAll('.univ-api-row');
        
        rows.forEach(row => {
            const path = row.getAttribute('data-path');
            const nameInput = row.querySelector('.univ-api-name');
            const divInput = row.querySelector('.univ-api-divisor');
            
            mappings.push({
                json_path: path,
                name: (nameInput && nameInput.value) ? nameInput.value.trim() : path.split('.').pop(),
                divisor: (divInput && divInput.value) ? parseFloat(divInput.value) : 1,
                group: groupName
            });
        });
    });
    return mappings;
}

// --- UNIVERSAL API DRAG & DROP HELPERS ---

window.univApiSortables = [];

function initUnivApiSortable(el) {
    if (!el || !window.Sortable) return;
    
    // Check if already initialized
    if (el._sortable) return;
    
    const sortable = new Sortable(el, {
        group: 'univApiGroup',
        animation: 150,
        ghostClass: 'sortable-ghost',
        onAdd: function (evt) {
            // When dropped into a group box, show inputs
            const item = evt.item;
            const inputs = item.querySelector('.univ-api-inputs');
            if (evt.to.id !== 'univApiAvailableFields' && inputs) {
                inputs.style.display = 'flex';
                item.style.background = 'rgba(0,255,136,0.1)';
                item.style.borderColor = '#00ff88';
            }
        },
        onRemove: function (evt) {
            // When moved back to available list, hide inputs
            if (evt.to.id === 'univApiAvailableFields') {
                const item = evt.item;
                const inputs = item.querySelector('.univ-api-inputs');
                if (inputs) {
                    inputs.style.display = 'none';
                    item.style.background = '#112238';
                    item.style.borderColor = '#1a3a5c';
                }
            }
        }
    });
    el._sortable = sortable;
    window.univApiSortables.push(sortable);
}

function createUnivApiMappingRow(path, defaultName, divisor = 1, showInputs = false) {
    const div = document.createElement('div');
    div.className = 'univ-api-row';
    div.setAttribute('data-path', path);
    div.style.border = showInputs ? '1px solid #00ff88' : '1px solid #1a3a5c';
    div.style.background = showInputs ? 'rgba(0,255,136,0.1)' : '#112238';
    div.style.padding = '6px';
    div.style.borderRadius = '4px';
    div.style.display = 'flex';
    div.style.flexDirection = 'column';
    div.style.gap = '6px';
    div.style.cursor = 'grab';
    
    div.innerHTML = \`
        <div style="font-size:11px; color:#fff; word-break:break-all; display:flex; align-items:center;">
            <i class="fas fa-grip-vertical" style="color:#5a8aaa; margin-right:6px;"></i>
            \${path}
        </div>
        <div class="univ-api-inputs" style="display:\${showInputs ? 'flex' : 'none'}; gap:6px; align-items:center;">
            <input type="text" class="univ-api-name" value="\${defaultName}" placeholder="Alias" style="flex:1; font-size:10px; padding:4px; background:#0a1628; color:#0f0; border:1px solid #1a3a5c; border-radius:3px;">
            <input type="number" class="univ-api-divisor" value="\${divisor}" placeholder="Divisor" style="width:50px; font-size:10px; padding:4px; background:#0a1628; color:#fff; border:1px solid #1a3a5c; border-radius:3px;">
        </div>
    \`;
    return div;
}

let univApiGroupCounter = 0;
window.addUnivApiGroup = function(name = '') {
    univApiGroupCounter++;
    const container = document.getElementById('univApiGroupsContainer');
    if (!container) return;
    
    const groupId = 'univ_api_group_' + univApiGroupCounter;
    
    const groupDiv = document.createElement('div');
    groupDiv.className = 'univ-api-group-box';
    groupDiv.setAttribute('data-is-custom', 'true');
    groupDiv.setAttribute('data-group-name', name);
    groupDiv.style.border = '1px dashed #00d4ff';
    groupDiv.style.borderRadius = '4px';
    groupDiv.style.padding = '6px';
    groupDiv.style.background = '#0a1628';
    
    groupDiv.innerHTML = \`
        <div style="display:flex; justify-content:space-between; margin-bottom:6px;">
            <input type="text" class="univ-api-group-name" value="\${name}" placeholder="Nama Group (Cth: Transmitter)" style="flex:1; font-size:10px; padding:2px 4px; background:#112238; color:#00d4ff; border:1px solid #1a3a5c; margin-right:8px;" onchange="this.closest('.univ-api-group-box').setAttribute('data-group-name', this.value.trim())">
            <button type="button" class="btn btn-secondary btn-sm" onclick="this.closest('.univ-api-group-box').remove()" style="padding:2px 6px; font-size:9px; color:#ff3355; background:none; border:1px solid #ff3355;"><i class="fas fa-trash"></i></button>
        </div>
        <div class="univ-api-group-dropzone sortable-list" id="\${groupId}_dropzone" style="min-height:40px; display:flex; flex-direction:column; gap:4px; background:rgba(0,0,0,0.3); padding:4px; border-radius:2px;"></div>
    \`;
    
    container.appendChild(groupDiv);
    
    const dropzone = groupDiv.querySelector('.univ-api-group-dropzone');
    initUnivApiSortable(dropzone);
    
    return groupDiv;
};`;

content = content.replace(getSearch, getReplace);

fs.writeFileSync('public/app.js', content);

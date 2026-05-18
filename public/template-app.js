/**
 * Template Management JavaScript
 * TOC Project - Equipment Templates UI
 * Updated for JSON Storage Integration
 */

// Global state
let authToken = localStorage.getItem('authToken');
const API_URL = '/api';

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  authToken = localStorage.getItem('authToken');
  initTemplateForm();

  // Add template button
  const addTemplateBtn = document.getElementById('addTemplateBtn');
  if (addTemplateBtn) {
    addTemplateBtn.addEventListener('click', () => openTemplateModal('Add Equipment Template'));
  }

  // Close modal buttons
  const closeBtn = document.getElementById('closeTemplateModal');
  if (closeBtn) closeBtn.addEventListener('click', closeTemplateModal);

  const cancelBtn = document.getElementById('cancelTemplateEdit');
  if (cancelBtn) cancelBtn.addEventListener('click', closeTemplateModal);

  const closeDetailBtn = document.getElementById('closeTemplateDetailModal');
  if (closeDetailBtn) {
    closeDetailBtn.addEventListener('click', () => {
      document.getElementById('templateDetailModal').classList.add('hidden');
    });
  }
});

/**
 * Global function called by config-nav.js
 */
window.loadSnmpTemplates = async function () {
  const tableBody = document.getElementById('templateTableBody');
  if (!tableBody) return;

  tableBody.innerHTML = '<tr><td colspan="7" class="loading-state"><i class="fas fa-spinner fa-spin"></i> Loading templates...</td></tr>';

  try {
    const response = await fetch(`${API_URL}/templates`, {
      headers: {
        'Authorization': `Bearer ${authToken}`
      }
    });

    if (!response.ok) throw new Error('Failed to load templates');

    const templates = await response.json();
    renderTemplateTable(templates);
  } catch (error) {
    console.error('Error loading templates:', error);
    tableBody.innerHTML = `<tr><td colspan="7" class="error-state">Error: ${error.message}</td></tr>`;
  }
};

/**
 * Render template table
 */
function renderTemplateTable(templates) {
  const tableBody = document.getElementById('templateTableBody');
  if (!tableBody) return;

  if (!templates || templates.length === 0) {
    tableBody.innerHTML = `<tr><td colspan="7" class="empty-state">No templates available. Create one to begin.</td></tr>`;
    return;
  }

  tableBody.innerHTML = templates.map(template => `
    <tr>
      <td><strong>${template.name}</strong></td>
      <td><span class="category-badge ${template.equipment_type?.toLowerCase() || 'support'}">${template.equipment_type || '-'}</span></td>
      <td>${template.brand || '-'}</td>
      <td>${template.model || '-'}</td>
      <td>${template.is_system ? '<span class="system-badge">System</span>' : '<span class="custom-badge">Custom</span>'}</td>
      <td>${template.description || '-'}</td>
      <td>
        <div class="action-buttons">
          <button class="btn-view" onclick="viewTemplate('${template.id}')" title="View">
            <i class="fas fa-eye"></i>
          </button>
          ${!template.is_system ? `
          <button class="btn-edit" onclick="editTemplate('${template.id}')" title="Edit">
            <i class="fas fa-edit"></i>
          </button>
          <button class="btn-delete" onclick="deleteTemplate('${template.id}')" title="Delete">
            <i class="fas fa-trash"></i>
          </button>
          ` : ''}
        </div>
      </td>
    </tr>
  `).join('');
}

/**
 * Initialize form listeners
 */
function initTemplateForm() {
  const form = document.getElementById('templateForm');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    await saveTemplate();
  });

  const addParamBtn = document.getElementById('addParameterBtn');
  if (addParamBtn) {
    addParamBtn.addEventListener('click', () => addParameterRow());
  }
}

/**
 * Add a parameter row to the form
 */
function addParameterRow(data = {}) {
  const container = document.getElementById('parameterContainer');
  if (!container) return;

  const row = document.createElement('div');
  row.className = 'parameter-row';
  row.innerHTML = `
    <div class="parameter-form-row">
      <div class="form-group">
        <label>Label</label>
        <input type="text" name="paramLabel" value="${data.label || ''}" placeholder="e.g., Temp" required>
      </div>
      <div class="form-group">
        <label>OID/Key</label>
        <input type="text" name="paramSource" value="${data.source || ''}" placeholder="e.g., 1.3.6..." required>
      </div>
      <div class="form-group">
        <label>Unit</label>
        <input type="text" name="paramUnit" value="${data.unit || ''}" style="width: 60px;">
      </div>
      <div class="threshold-group">
        <div class="form-group">
          <label>W.Min</label>
          <input type="number" step="0.1" name="warningMin" value="${data.warning_min || ''}">
        </div>
        <div class="form-group">
          <label>W.Max</label>
          <input type="number" step="0.1" name="warningMax" value="${data.warning_max || ''}">
        </div>
        <div class="form-group">
          <label>A.Min</label>
          <input type="number" step="0.1" name="alarmMin" value="${data.alarm_min || ''}">
        </div>
        <div class="form-group">
          <label>A.Max</label>
          <input type="number" step="0.1" name="alarmMax" value="${data.alarm_max || ''}">
        </div>
      </div>
      <button type="button" class="btn-delete" title="Remove Parameter" onclick="this.parentElement.parentElement.remove()">
        <i class="fas fa-trash"></i>
      </button>
    </div>
  `;
  container.appendChild(row);
}

/**
 * Save Template logic
 */
async function saveTemplate() {
  const idValue = document.getElementById('templateId').value;

  const templateData = {
    name: document.getElementById('templateName').value,
    equipment_type: document.getElementById('templateEquipmentType').value,
    brand: document.getElementById('templateBrand').value,
    model: document.getElementById('templateModel').value,
    protocol: document.getElementById('templateProtocol').value,
    description: document.getElementById('templateDescription').value,
    parsing_logic: document.getElementById('templateParsingLogic').value,
    parameters: []
  };

  const paramRows = document.querySelectorAll('.parameter-row');
  paramRows.forEach(row => {
    const label = row.querySelector('[name="paramLabel"]').value;
    const source = row.querySelector('[name="paramSource"]').value;
    if (label && source) {
      templateData.parameters.push({
        label,
        source,
        unit: row.querySelector('[name="paramUnit"]').value,
        warning_min: row.querySelector('[name="warningMin"]').value || null,
        warning_max: row.querySelector('[name="warningMax"]').value || null,
        alarm_min: row.querySelector('[name="alarmMin"]').value || null,
        alarm_max: row.querySelector('[name="alarmMax"]').value || null
      });
    }
  });

  try {
    const method = idValue ? 'PUT' : 'POST';
    const url = idValue ? `${API_URL}/templates/${idValue}` : `${API_URL}/templates`;

    const response = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      },
      body: JSON.stringify(templateData)
    });

    if (!response.ok) throw new Error('Failed to save template');

    showToast(`Template ${idValue ? 'updated' : 'created'} successfully!`, 'success');
    closeTemplateModal();
    window.loadSnmpTemplates();
  } catch (error) {
    console.error('Error saving template:', error);
    showToast('Error saving template: ' + error.message, 'error');
  }
}

/**
 * View Detail logic
 */
window.viewTemplate = async (id) => {
  try {
    const response = await fetch(`${API_URL}/templates/${id}`, {
      headers: { 'Authorization': `Bearer ${authToken}` }
    });
    if (!response.ok) throw new Error('Failed to fetch template');
    const template = await response.json();

    const title = document.querySelector('#templateDetailModal h3');
    if (title) title.textContent = template.name;

    const content = document.getElementById('templateDetailContent');
    if (content) {
      const params = template.parameters || [];
      const paramsHtml = params.map(p => `
        <tr>
          <td>${p.label}</td>
          <td><code>${p.source}</code></td>
          <td>${p.unit || '-'}</td>
          <td>${p.warning_min || '-'} / ${p.warning_max || '-'}</td>
          <td>${p.alarm_min || '-'} / ${p.alarm_max || '-'}</td>
        </tr>
      `).join('');

      content.innerHTML = `
        <div class="template-info">
          <p><strong>Category:</strong> ${template.equipment_type}</p>
          <p><strong>Brand/Model:</strong> ${template.brand} / ${template.model}</p>
          <p><strong>Description:</strong> ${template.description || '-'}</p>
        </div>
        <div class="template-parsing-info" style="margin-top: 15px; padding: 10px; background: var(--bg-secondary); border-radius: 4px;">
          <h4 style="margin-top: 0;">Parsing Logic</h4>
          <pre style="white-space: pre-wrap; font-size: 0.85rem; font-family: monospace; color: var(--accent-color);">${template.parsing_logic || 'No logic defined'}</pre>
        </div>
        <div class="template-parameters">
          <h4>Parameters (${params.length})</h4>
          <table class="detail-table">
            <thead><tr><th>Label</th><th>Source</th><th>Unit</th><th>Warning (Min/Max)</th><th>Alarm (Min/Max)</th></tr></thead>
            <tbody>${paramsHtml || '<tr><td colspan="5">No parameters defined</td></tr>'}</tbody>
          </table>
        </div>
      `;
    }

    document.getElementById('templateDetailModal').classList.remove('hidden');
  } catch (error) {
    showToast('Error: ' + error.message, 'error');
  }
};

/**
 * Edit Mode logic
 */
window.editTemplate = async (id) => {
  try {
    const response = await fetch(`${API_URL}/templates/${id}`, {
      headers: { 'Authorization': `Bearer ${authToken}` }
    });
    if (!response.ok) throw new Error('Failed to fetch template');
    const template = await response.json();

    openTemplateModal('Edit Template');
    document.getElementById('templateId').value = template.id;
    document.getElementById('templateName').value = template.name;
    document.getElementById('templateEquipmentType').value = template.equipment_type;
    document.getElementById('templateBrand').value = template.brand || '';
    document.getElementById('templateModel').value = template.model || '';
    document.getElementById('templateProtocol').value = template.protocol || 'snmp';
    document.getElementById('templateDescription').value = template.description || '';
    document.getElementById('templateParsingLogic').value = template.parsing_logic || '';

    const container = document.getElementById('parameterContainer');
    container.innerHTML = '';
    (template.parameters || []).forEach(p => addParameterRow(p));

  } catch (error) {
    showToast('Error: ' + error.message, 'error');
  }
};

/**
 * Delete logic
 */
window.deleteSnmpTemplate = async function (id) {
  const confirmed = await showConfirm(
    'Hapus Template?', 
    'Are you sure you want to delete this template?',
    { type: 'danger', confirmText: 'Hapus' }
  );
  if (!confirmed) return;
  try {
    const response = await fetch(`${API_URL}/templates/${id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${authToken}` }
    });
    if (!response.ok) throw new Error('Delete failed');
    showToast('Template deleted', 'success');
    window.loadSnmpTemplates();
  } catch (error) {
    showToast('Error: ' + error.message, 'error');
  }
};

/**
 * Modal visibility
 */
function openTemplateModal(title = 'Add Template') {
  const modal = document.getElementById('templateModal');
  const titleEl = document.getElementById('templateModalFormTitle');
  if (modal) {
    if (titleEl) titleEl.textContent = title;
    modal.classList.remove('hidden');
  }
}

function closeTemplateModal() {
  const modal = document.getElementById('templateModal');
  if (modal) {
    modal.classList.add('hidden');
    const form = document.getElementById('templateForm');
    if (form) form.reset();
    document.getElementById('templateId').value = '';
    document.getElementById('templateParsingLogic').value = '';
    document.getElementById('parameterContainer').innerHTML = '';
  }
}

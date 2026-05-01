// Configuration Navigation Handler with State Management

var liveDataTimer = window.liveDataTimer;

// State to track active sub-menu
let activeSubMenu = 'snmp-templates';

function initConfigurationNav() {
  console.log('[DEBUG] Initializing Configuration Navigation');

  const configNavItems = document.querySelectorAll('.config-nav-item');
  const configContents = document.querySelectorAll('.config-content-item');

  if (!configNavItems || configNavItems.length === 0) {
    console.log('[DEBUG] No config nav items found');
    return;
  }

  // Add click event listeners to each nav item
  configNavItems.forEach(item => {
    item.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();

      const configType = this.dataset.config;
      console.log('[DEBUG] Config item clicked:', configType);

      // Update active state in nav - remove from all, add to clicked
      configNavItems.forEach(n => n.classList.remove('active'));
      this.classList.add('active');

      // Hide all content items first
      configContents.forEach(content => {
        content.classList.add('hidden');
      });

      // Show only the corresponding content based on configType
      switch (configType) {
        case 'equipment-templates':
        case 'snmp-templates':
          document.getElementById('configSnmpTemplatesContent')?.classList.remove('hidden');
          // Also handle Alt version if exists
          document.getElementById('configSnmpTemplatesContentAlt')?.classList.remove('hidden');
          // Load SNMP templates when tab is clicked
          if (typeof loadSnmpTemplates === 'function') {
            console.log('[DEBUG] Loading SNMP templates...');
            loadSnmpTemplates();
          }
          break;

        case 'snmp-tools':
          document.getElementById('configSnmpToolsContent')?.classList.remove('hidden');
          // Also handle Alt version if exists
          document.getElementById('configSnmpToolsContentAlt')?.classList.remove('hidden');
          // Initialize SNMP tools if needed
          if (typeof initSnmpTools === 'function') {
            initSnmpTools();
          }
          break;

        case 'threshold-settings':
          document.getElementById('configThresholdSettingsContent')?.classList.remove('hidden');
          // Also handle Alt version if exists
          document.getElementById('configThresholdSettingsContentAlt')?.classList.remove('hidden');
          // Initialize threshold settings
          if (typeof initThresholdSettings === 'function') {
            initThresholdSettings();
          }
          break;

        default:
          console.log('[DEBUG] Unknown config type:', configType);
          // Default to SNMP Templates
          document.getElementById('configSnmpTemplatesContent')?.classList.remove('hidden');
          document.getElementById('configSnmpTemplatesContentAlt')?.classList.remove('hidden');
      }

      // Update state
      activeSubMenu = configType;
      console.log('[DEBUG] Active sub-menu updated to:', activeSubMenu);
    });
  });

  // Initialize with first item active
  initializeDefaultState();
}

function initializeDefaultState() {
  const configNavItems = document.querySelectorAll('.config-nav-item');
  const configContents = document.querySelectorAll('.config-content-item');

  // Hide all contents first
  configContents.forEach(content => {
    content.classList.add('hidden');
  });

  // Find and activate the first nav item (SNMP Templates by default)
  const firstNavItem = document.querySelector('.config-nav-item[data-config="snmp-templates"]');
  if (firstNavItem) {
    // Remove active from all
    configNavItems.forEach(n => n.classList.remove('active'));
    // Add active to first
    firstNavItem.classList.add('active');
    // Show corresponding content
    document.getElementById('configSnmpTemplatesContent')?.classList.remove('hidden');
    document.getElementById('configSnmpTemplatesContentAlt')?.classList.remove('hidden');
    activeSubMenu = 'snmp-templates';
  }

  console.log('[DEBUG] Default state initialized, active:', activeSubMenu);
}

// Function to programmatically set active sub-menu (for external calls)
function setActiveConfig(configType) {
  const configNavItems = document.querySelectorAll('.config-nav-item');
  const configContents = document.querySelectorAll('.config-content-item');

  // Hide all contents
  configContents.forEach(content => {
    content.classList.add('hidden');
  });

  // Remove active from all nav items
  configNavItems.forEach(n => n.classList.remove('active'));

  // Add active to selected nav item
  const selectedNavItem = document.querySelector(`.config-nav-item[data-config="${configType}"]`);
  if (selectedNavItem) {
    selectedNavItem.classList.add('active');
  }

  // Show corresponding content
  switch (configType) {
    case 'equipment-templates':
    case 'snmp-templates':
      document.getElementById('configSnmpTemplatesContent')?.classList.remove('hidden');
      document.getElementById('configSnmpTemplatesContentAlt')?.classList.remove('hidden');
      if (typeof loadSnmpTemplates === 'function') {
        loadSnmpTemplates();
      }
      break;
    case 'snmp-tools':
      document.getElementById('configSnmpToolsContent')?.classList.remove('hidden');
      document.getElementById('configSnmpToolsContentAlt')?.classList.remove('hidden');
      break;
    case 'threshold-settings':
      document.getElementById('configThresholdSettingsContent')?.classList.remove('hidden');
      document.getElementById('configThresholdSettingsContentAlt')?.classList.remove('hidden');
      if (typeof initThresholdSettings === 'function') {
        initThresholdSettings();
      }
      break;
  }

  activeSubMenu = configType;
}

// Get current active sub-menu
function getActiveConfig() {
  return activeSubMenu;
}

// Make functions available globally
window.initConfigurationNav = initConfigurationNav;
window.setActiveConfig = setActiveConfig;
window.getActiveConfig = getActiveConfig;

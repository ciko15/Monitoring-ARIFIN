/**
 * Threshold Evaluation Utility
 * TOC Project - Smart Template Threshold Logic
 */

/**
 * Evaluates a value against threshold configuration
 * @param {number|string} value - The value to evaluate
 * @param {object} config - Threshold configuration object
 * @param {number} [config.warning_min] - Warning minimum threshold
 * @param {number} [config.warning_max] - Warning maximum threshold
 * @param {number} [config.alarm_min] - Alarm minimum threshold
 * @param {number} [config.alarm_max] - Alarm maximum threshold
 * @returns {string} Status: 'Normal', 'Warning', 'Alert', or 'Disconnect'
 */
function checkThreshold(value, config = {}) {
  // Handle null/undefined values
  if (value === null || value === undefined) {
    return 'Disconnect';
  }

  // Parse value to number if it's a string
  let numericValue;
  if (typeof value === 'string') {
    // Handle percentage strings like "80%"
    if (value.endsWith('%')) {
      numericValue = parseFloat(value.replace('%', ''));
    } else {
      numericValue = parseFloat(value);
    }
  } else {
    numericValue = Number(value);
  }

  // Check if parsing failed
  if (isNaN(numericValue)) {
    return 'Disconnect';
  }

  const { warning_min, warning_max, alarm_min, alarm_max } = config;

  // Priority: Alarm > Warning > Normal
  // Check alarm conditions first (highest priority)
  if ((alarm_min !== undefined && numericValue <= alarm_min) ||
      (alarm_max !== undefined && numericValue >= alarm_max)) {
    return 'Alert';
  }

  // Check warning conditions
  if ((warning_min !== undefined && numericValue <= warning_min) ||
      (warning_max !== undefined && numericValue >= warning_max)) {
    return 'Warning';
  }

  // Default to normal
  return 'Normal';
}

/**
 * Evaluates multiple parameters and returns overall status
 * @param {object} parameters - Object with parameter values {paramName: value}
 * @param {object} thresholds - Object with threshold configs {paramName: config}
 * @returns {object} {overallStatus: string, parameterStatuses: object}
 */
function evaluateParameters(parameters, thresholds) {
  const parameterStatuses = {};
  let overallStatus = 'Normal';
  const triggeredParameters = [];

  // Status priority order (highest to lowest)
  const statusPriority = { 'Alert': 3, 'Warning': 2, 'Normal': 1, 'Disconnect': 0 };

  for (const [paramName, value] of Object.entries(parameters)) {
    const config = thresholds[paramName] || {};
    const status = checkThreshold(value, config);
    parameterStatuses[paramName] = status;

    if (status === 'Warning' || status === 'Alert') {
      triggeredParameters.push(paramName);
    }

    // Update overall status if this parameter has higher priority
    if (statusPriority[status] > statusPriority[overallStatus]) {
      overallStatus = status;
    }
  }

  return {
    overallStatus,
    parameterStatuses,
    triggeredParameters
  };
}

/**
 * Gets status color class for UI
 * @param {string} status - Status string
 * @returns {string} CSS class name
 */
function getStatusColorClass(status) {
  switch (status) {
    case 'Alert': return 'alert';
    case 'Warning': return 'warning';
    case 'Normal': return 'normal';
    case 'Disconnect': return 'disconnect';
    default: return 'normal';
  }
}

/**
 * Gets status icon class for UI
 * @param {string} status - Status string
 * @returns {string} FontAwesome icon class
 */
function getStatusIconClass(status) {
  switch (status) {
    case 'Alert': return 'fas fa-times-circle';
    case 'Warning': return 'fas fa-exclamation-triangle';
    case 'Normal': return 'fas fa-check-circle';
    case 'Disconnect': return 'fas fa-unlink';
    default: return 'fas fa-question-circle';
  }
}

module.exports = {
  checkThreshold,
  evaluateParameters,
  getStatusColorClass,
  getStatusIconClass
};
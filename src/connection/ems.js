const { Ems, AirNavServiceQueue, LogType } = require('ems-airnav-package');

const ems = new Ems({
  host: '172.20.17.104',
  port: 5672,
  username: 'snc',
  password: 'sncsnc123!',
  vhost: '/',
  serviceName: 'TOC',
  serviceVersion: '1.0.0',
});

/**
 * Generic reusable wrapper for EMS internal producer.
 * Supports Promise flow and optional callback for backward compatibility.
 */
function produceInternalMessage(queue, metadata = {}, payload = {}, callback) {
  return new Promise((resolve, reject) => {
    ems.produceInternal(queue, metadata, payload, (msg, error) => {
      if (error) {
        if (typeof callback === 'function') callback(null, error);
        reject(error);
        return;
      }

      if (typeof callback === 'function') callback(msg, null);
      resolve(msg);
    });
  });
}

/**
 * Reusable helper for standard service log publishing.
 */
function publishServiceLog(payload = {}, options = {}, callback) {
  const queue = options.queue || AirNavServiceQueue.TEST;
  const metadata = {
    REQUEST_TYPE: options.requestType || 'SERVICE_LOG',
    ...options.metadata,
  };

  return produceInternalMessage(queue, metadata, payload, callback);
}

module.exports = {
  ems,
  produceInternalMessage,
  publishServiceLog,
  AirNavServiceQueue,
  LogType,
};

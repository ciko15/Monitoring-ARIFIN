process.env.SERVICE_ROLE = process.env.SERVICE_ROLE || 'web';
process.env.PIPELINE_MODE = process.env.PIPELINE_MODE || 'split';

require('./server.ts');

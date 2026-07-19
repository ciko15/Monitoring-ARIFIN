const amqp = require('amqplib/callback_api'); // use callback api to get full error

console.log('Testing AMQP 0-9-1 connection...');
amqp.connect('amqp://smart-toc-hq:smarthq123!@172.20.16.123:5672/', (err, conn) => {
    if (err) {
        console.error('Connection failed:', err);
    } else {
        console.log('SUCCESS! AMQP 0-9-1 connected!');
        conn.close();
    }
});

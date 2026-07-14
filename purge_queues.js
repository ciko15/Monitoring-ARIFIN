const amqp = require('amqplib');
async function purge() {
  const conn = await amqp.connect('amqp://smart-toc-hq:smarthq123!@172.20.17.104:5672/dev-smart');
  const ch = await conn.createChannel();
  const queues = ['Q.NAV', 'Q.COM', 'Q.SUR', 'Q.DAT', 'Q.SUP'];
  for (const q of queues) {
    try {
      const res = await ch.purgeQueue(q);
      console.log(`Purged ${q}: ${res.messageCount} messages`);
    } catch (e) {
      console.log(`Failed to purge ${q}: ${e.message}`);
    }
  }
  await conn.close();
}
purge().catch(console.error);

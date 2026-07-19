/* 
  Solace AMQP 1.0 Migration:
  Script purge_queues ini sebelumnya menggunakan fungsi khusus amqplib (RabbitMQ).
  Di Solace (AMQP 1.0), purge queue biasanya dilakukan lewat Solace PubSub+ Manager (GUI) 
  atau SEMP API.
*/

console.warn("⚠️ PERINGATAN: Fitur purge queue tidak didukung secara natif melalui standar protokol AMQP 1.0.");
console.log("Silakan gunakan Dashboard Solace PubSub+ Manager untuk melakukan 'Purge Queue'.");


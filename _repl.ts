// Create a new consumer `ReadableStream`
const consumer = new ReadableStream({
  async pull(controller) {
    controller.enqueue("Hello, World!");
    controller.close();
  },

  async cancel(reason) {
    console.log("Consumer canceled:", reason);
  },
});

const reader1 = consumer.getReader();

await reader1.releaseLock();
await consumer.cancel("Consumer canceled early");


const reader2 = consumer.getReader();

// await reader.cancel("Consumer canceled");

let { value, done } = await reader2.read();
console.log({
  value,
  done,
});


// await reader.cancel("Consumer canceled");
// reader.releaseLock();

({ value, done } = await reader2.read());
console.log({
  value,
  done,
});

console.log({
  reader2,
  consumer,

  locked: consumer.locked,
  closed: await reader2.closed,
})

await reader1.cancel("Done early");
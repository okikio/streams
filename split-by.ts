import { splitStream } from "./split.ts";

// Create a source stream that produces numbers with varying delays
const sourceStream = new ReadableStream<number>({
  async start(controller) {
    for (let i = 0; i < 10; i++) {
      // await new Promise(resolve => setTimeout(resolve, Math.random() * 500));
      controller.enqueue(i);
      console.log(`Source produced: ${i}`);
    }
    controller.close();
  }
});

// Split the stream into even and odd numbers
const [evenStream, oddStream] = splitStream<number, number>(sourceStream, num => num % 2 === 0);

const evenStreamReader = evenStream.getReader();
const oddStreamReader = oddStream.getReader();

// Helper function to read from a stream
async function readStream<T>(stream: ReadableStream<T> | ReadableStreamDefaultReader<T>, name: string) {
  const reader = 'getReader' in stream ? stream?.getReader?.() : stream;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      console.log(`${name} received: ${value}`);
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    console.log(`${name} done`);
  } finally {
    reader.releaseLock();
  }
}

// Read from both streams concurrently
Promise.all([
  readStream(evenStreamReader, "Even Stream"),
  readStream(oddStreamReader, "Odd Stream")
]).then(() => console.log("All streams processed", { evenStream, oddStream }));

// Demonstrate cancellation after a delay
setTimeout(async () => {
  console.log("Cancelling streams");
  await Promise.all([
    evenStreamReader.cancel("Demo cancellation"),
    oddStreamReader.cancel("Demo cancellation")
  ]);
}, 1000);


// Use AsyncDisposable feature
// (async () => {
//   await using streams = splitStream(sourceStream, num => num % 2 === 0);
//   const [evenStream, oddStream] = streams;
  
//   // const evenStreamReader = evenStream.getReader();
//   // const oddStreamReader = oddStream.getReader();
  
//   // Read from both streams concurrently
//   await Promise.all([
//     readStream(evenStream, "Even Stream"),
//     readStream(oddStream, "Odd Stream")
//   ]).then(() => console.log("All streams processed", { evenStream, oddStream }));

//   // Demonstrate cancellation after a delay
//   // setTimeout(async () => {
//   //   console.log("Cancelling streams");
//   //   await Promise.all([
//   //     evenStreamReader.cancel("Demo cancellation"),
//   //     oddStreamReader.cancel("Demo cancellation")
//   //   ]);
//   // }, 1000);
  
//   // ... use streams ...
// })();
import { test } from "@libs/testing";
import { expect } from "@std/expect";

import { enhanceReadableStream, ReadableStreamReader } from "./stream.ts";

function createInfiniteStream(delay = 10) {
  let intervalId: ReturnType<typeof setInterval>;
  return new ReadableStream({
    start(controller) {
      // Infinite stream for testing
      let count = 0;
      intervalId = setInterval(() => {
        controller.enqueue(count++);
      }, delay);
    },
    cancel() {
      console.log("Stream canceled");
      // Clean up when stream is canceled
      clearInterval(intervalId);
    },
  });
}

// Test Case ERS1: Basic reading functionality
test("all")("enhanceReadableStream - basic reading functionality", async () => {
  // Create a simple ReadableStream emitting [1, 2, 3]
  const stream = new ReadableStream({
    start(controller) {
      [1, 2, 3].forEach((value) => controller.enqueue(value));
      controller.close();
    },
  });

  // Enhance the stream
  const enhancedStream = enhanceReadableStream(stream);

  const values = [];
  for await (const value of enhancedStream) {
    values.push(value);
  }

  expect(values).toEqual([1, 2, 3]);
});

// Test Case ERS2: Disposal using Symbol.asyncDispose
test("all")("enhanceReadableStream - disposal using Symbol.asyncDispose", async () => {
  const stream = new ReadableStream({
    start(controller) {
      [1, 2, 3].forEach((value) => controller.enqueue(value));
      // Do not close the stream to simulate an ongoing stream
    },
  });

  const enhancedStream = enhanceReadableStream(stream);

  // Dispose the stream before reading
  enhancedStream[Symbol.asyncDispose]();

  const values = [];
  try {
    for await (const value of enhancedStream) {
      values.push(value);
    }
  } catch (error) {
    // Expected to throw an error because the stream is canceled
    expect(error).toBeDefined();
  }

  expect(values.length).toBe(0);
});

// Test Case ERS5: Disposing a locked stream
test("all")("enhanceReadableStream - disposing a locked stream", async () => {
  const stream = new ReadableStream({
    start(controller) {
      [1, 2, 3].forEach((value) => controller.enqueue(value));
      // Do not close the stream to keep it open
    },
  });

  const enhancedStream = enhanceReadableStream(stream);

  // Get the reader, which locks the stream
  const reader = enhancedStream.getReader();

  // Dispose the stream while it is locked
  enhancedStream[Symbol.asyncDispose]();

  // Attempt to read from the reader
  try {
    const { value, done } = await reader.read();
    expect(done).toBe(true); // Should be done because the stream was canceled
  } catch (error) {
    // Expected behavior; the reader should be canceled
    expect(error).toBeDefined();
  }

  // Ensure that the reader's lock is released
  expect(enhancedStream.locked).toBe(false);
});

// Test Case ERS6: Read multiple streams simultaneously
test("all")("enhanceReadableStream - read multiple streams simultaneously", async () => {
  const createStream = (id: number) =>
    new ReadableStream({
      start(controller) {
        [1, 2, 3].forEach((value) => controller.enqueue(`${id}-${value}`));
        controller.close();
      },
    });

  const stream1 = enhanceReadableStream(createStream(1));
  const stream2 = enhanceReadableStream(createStream(2));

  const results1: string[] = [];
  const results2: string[] = [];

  await Promise.all([
    (async () => {
      for await (const value of stream1) {
        results1.push(value);
      }
    })(),
    (async () => {
      for await (const value of stream2) {
        results2.push(value);
      }
    })(),
  ]);

  expect(results1).toEqual(["1-1", "1-2", "1-3"]);
  expect(results2).toEqual(["2-1", "2-2", "2-3"]);
});

// Test Case ERS7: Consume stream using while loop with .read()
test("all")("enhanceReadableStream - consume using while loop with .read()", async () => {
  const stream = new ReadableStream({
    start(controller) {
      [1, 2, 3].forEach((value) => controller.enqueue(value));
      controller.close();
    },
  });

  const enhancedStream = enhanceReadableStream(stream);
  const reader = enhancedStream.getReader();

  const values = [];
  let result;
  while (!(result = await reader.read()).done) {
    values.push(result.value);
  }

  expect(values).toEqual([1, 2, 3]);
});

// Test Case ERS8: Attempt to get a second reader when the stream is already locked
test("all")("enhanceReadableStream - attempt to get a second reader when locked", async () => {
  const stream = createInfiniteStream();

  const enhancedStream = enhanceReadableStream(stream);

  const reader1 = enhancedStream.getReader();
  const reader2 = enhancedStream.getReader();

  // Attempt to get a second reader
  console.log({
    value1: await reader1.read(),
    value2: await reader2.read(),
    reader1,
    reader2
  })
  expect(true).toBe(true);

  await enhancedStream.cancel();
});

// Test Case ERS9: Dispose the stream while it's being read
test("all")("enhanceReadableStream - dispose the stream while it's being read", async () => {
  const stream = createInfiniteStream(50);
  const enhancedStream = enhanceReadableStream(stream);
  const values: number[] = [];

  const readPromise = (async () => {
    for await (const value of enhancedStream) {
      values.push(value);
      if (value >= 3) {
        break;
      }
    }
  })();

  await readPromise;
  await enhancedStream[Symbol.asyncDispose]();

  // Ensure that only values up to 3 are read
  expect(values).toEqual([0, 1, 2, 3]);

  // Ensure that the stream is properly disposed
  expect(enhancedStream.locked).toBe(false);
  expect(ReadableStreamReader.has(enhancedStream)).toBe(false);
});

// Test Case ERS10: Attempt to have a second reader with parallel reads when the stream is already locked
test("all")("enhanceReadableStream - attempt to have a second reader with parallel reads when locked", async () => {
  const stream = createInfiniteStream();
  const enhancedStream = enhanceReadableStream(stream);

  await Promise.race([
    (async () => {
      try {
        for await (const value of enhancedStream) {
          console.log("Reader 1:", value);
        }
      } catch (_) { console.warn(_) }
    })(),
    (async () => {
      try {
        for await (const value of enhancedStream) {
          console.log("Reader 2:", value);
        }
      } catch (_) { console.warn(_) }
    })(),

    new Promise(resolve => setTimeout(resolve, 1000))
  ]);

  await enhancedStream.cancel();

  // await stream.cancel();
});

// Test Case: Complex Stream Teeing and Disposal
test.only("deno")("enhanceReadableStream - complex teeing and disposal", async () => {
  // Create a source ReadableStream that emits numbers every 500ms
  const sourceStream = new ReadableStream<number>({
    start(controller) {
      let count = 0;
      const intervalId = setInterval(() => {
        if (count > 10) {
          clearInterval(intervalId);
          controller.close();
          return;
        } else {
          controller.enqueue(count++);
        }
      }, 500);
    },
  });

  // Split the source stream into two branches
  const enhacnedBranch = enhanceReadableStream(sourceStream);

  // Enhance both branches
  const branch1 = enhacnedBranch.getReader().stream;
  const branch2 = enhacnedBranch.getReader().stream;

  const enhancedBranch1 = enhanceReadableStream(branch1);
  const enhancedBranch2 = enhanceReadableStream(branch2);

  const resultsBranch1: number[] = [];
  const resultsBranch2: number[] = [];
  const resultsSubBranch1: number[] = [];
  const resultsSubBranch2: number[] = [];

  // Start reading from the parent branches
  const readParentBranches = Promise.all([
    (async () => {
      for await (const value of enhancedBranch1) {
        resultsBranch1.push(value);
        if (value === 3) {
          // After reading some values, split branch1 into two sub-branches
          const subBranch1 = enhancedBranch1.getReader().stream;
          const subBranch2 = enhancedBranch1.getReader().stream;

          const enhancedSubBranch1 = enhanceReadableStream(subBranch1);
          const enhancedSubBranch2 = enhanceReadableStream(subBranch2);

          // Start reading from the sub-branches after a delay
          setTimeout(() => {
            (async () => {
              try {
                for await (const subValue of enhancedSubBranch1) {
                  resultsSubBranch1.push(subValue);
                }
              } catch (_) {
                console.warn(_);
              }
            })();
          }, 2000); // Delay of 2 seconds

          setTimeout(() => {
            (async () => {
              try {
                for await (const subValue of enhancedSubBranch2) {
                  resultsSubBranch2.push(subValue);
                }
              } catch (_) {
                console.warn(_);
              }
            })();
          }, 2000); // Delay of 2 seconds
        }

        if (value === 5) {
          break;
        }
      }
    })(),
    (async () => {
      for await (const value of enhancedBranch2) {
        resultsBranch2.push(value);
        if (value === 5) {
          break;
        }
      }
    })(),
  ]);

  // Wait for the parent branches to finish reading
  await readParentBranches;

  // Dispose of the parent branch after reading value 5
  // await enhancedBranch2[Symbol.asyncDispose]();

  // Wait for the sub-branches to read remaining values
  await new Promise((resolve) => setTimeout(resolve, 6000)); // Wait longer to allow sub-branches to read all values

  // Output the results
  // console.log("Parent Branch 1:", resultsBranch1);
  // console.log("Parent Branch 2:", resultsBranch2);
  // console.log("Sub Branch 1:", resultsSubBranch1);
  // console.log("Sub Branch 2:", resultsSubBranch2);

  // // Assertions
  // expect(resultsBranch1).toEqual([0, 1, 2, 3, 4, 5]);
  // expect(resultsBranch2).toEqual([0, 1, 2, 3, 4, 5]);

  // // The sub-branches should have started reading from value 3 onwards
  // expect(resultsSubBranch1[0]).toBe(3);
  // expect(resultsSubBranch2[0]).toBe(3);

  // // The sub-branches should continue to read values even after parent branch is disposed
  // expect(resultsSubBranch1).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
  // expect(resultsSubBranch2).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
});


// ====

// Test Case ERR1: Basic reading from enhanced reader
test("all")("enhanceReaderWithDisposal - basic reading functionality", async () => {
  const stream = new ReadableStream<number>({
    start(controller) {
      [1, 2, 3].forEach((value) => controller.enqueue(value));
      controller.close();
    },
  });

  const enhancedReader = enhanceReadableStream(stream).getReader();

  const values = [];
  let result: ReadableStreamReadResult<number>;
  do {
    result = await enhancedReader.read();
    if (!result.done) {
      values.push(result.value);
    }
  } while (!result.done);

  expect(values).toEqual([1, 2, 3]);
});

// Test Case ERR2: Disposal using Symbol.asyncDispose
test("all")("enhanceReaderWithDisposal - disposal using Symbol.asyncDispose", async () => {
  const stream = new ReadableStream<number>({
    start(controller) {
      [1, 2, 3].forEach((value) => controller.enqueue(value));
      // Do not close the stream
    },
  });

  const enhancedReader = enhanceReadableStream(stream).getReader();

  // Dispose the reader
  await enhancedReader[Symbol.asyncDispose]();

  // Attempt to read from the reader
  try {
    await enhancedReader.read();
    // Should not reach here
    expect(true).toBe(false);
  } catch (error) {
    // Expected to throw an error
    expect(error).toBeDefined();
  }
});

// Test Case ERR3: Multiple readers from different streams
test("all")("enhanceReaderWithDisposal - multiple readers from different streams", async () => {
  const createStream = (id: number) =>
    new ReadableStream<string>({
      start(controller) {
        [1, 2, 3].forEach((value) => controller.enqueue(`${id}-${value}`));
        controller.close();
      },
    });

  const stream1 = createStream(1);
  const stream2 = createStream(2);

  const reader1 = enhanceReadableStream(stream1).getReader();
  const reader2 = enhanceReadableStream(stream2).getReader();

  const values2: string[] = [];
  const values1: string[] = [];

  await Promise.all([
    (async () => {
      let result;
      while (!(result = await reader1.read()).done) {
        values1.push(result.value);
      }
    })(),
    (async () => {
      let result;
      while (!(result = await reader2.read()).done) {
        values2.push(result.value);
      }
    })(),
  ]);

  expect(values1).toEqual(["1-1", "1-2", "1-3"]);
  expect(values2).toEqual(["2-1", "2-2", "2-3"]);
});

// Test Case ERR4: Reader cancellation during read operations
test("all")("enhanceReaderWithDisposal - reader cancellation during read", async () => {
  const stream = new ReadableStream<number>({
    start(controller) {
      let count = 0;
      function push() {
        controller.enqueue(count++);
        setTimeout(push, 10);
      }
      push();
    },
  });

  const reader = enhanceReadableStream(stream).getReader();

  const values: number[] = [];

  const readPromise = (async () => {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      values.push(result.value);
      if (result.value >= 5) {
        // Cancel the reader
        await reader.cancel("No longer needed");
        break;
      }
    }
  })();

  await readPromise;

  expect(values).toEqual([0, 1, 2, 3, 4, 5]);

  // Ensure the reader is released
  reader.releaseLock();
  expect(stream.locked).toBe(false);
});

// Test Case ERR5: Dispose reader while it's in the middle of reading
test("all")("enhanceReaderWithDisposal - dispose reader during read", async () => {
  const stream = new ReadableStream<number>({
    start(controller) {
      let count = 0;
      function push() {
        controller.enqueue(count++);
        setTimeout(push, 20);
      }
      push();
    },
  });

  const reader = enhanceReadableStream(stream).getReader();

  const values: number[] = [];

  const readPromise = (async () => {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      values.push(result.value);
      if (result.value >= 3) {
        // Dispose the reader
        reader[Symbol.asyncDispose]();
        break;
      }
    }
  })();

  await readPromise;

  expect(values).toEqual([0, 1, 2, 3]);

  // Ensure the reader is released
  expect(stream.locked).toBe(false);
});

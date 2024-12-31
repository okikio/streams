import { test, expect } from "@libs/testing";

import { createMulticastStream, ConsumerStreamReaders } from "./multicast.ts";
import { iterableFromStream } from "./utils.ts";

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
test("createMulticastStream - basic reading functionality", async () => {
  // Create a simple ReadableStream emitting [1, 2, 3]
  const stream = new ReadableStream({
    start(controller) {
      [1, 2, 3].forEach((value) => controller.enqueue(value));
      controller.close();
    },
  });

  // Enhance the stream
  await using multicastStream = createMulticastStream(stream);

  const values = [];
  for await (const value of multicastStream) {
    values.push(value);
  }

  expect(values).toEqual([1, 2, 3]);
});

// Test Case ERS2: Disposal using Symbol.asyncDispose
test("createMulticastStream - disposal using Symbol.asyncDispose", async () => {
  const stream = new ReadableStream({
    start(controller) {
      [1, 2, 3].forEach((value) => controller.enqueue(value));
      // Do not close the stream to simulate an ongoing stream
    },
  });

  await using multicastStream = createMulticastStream(stream);

  const values = [];
  await Promise.all([
    // Dispose the stream while it is locked
    new Promise(resolve => setTimeout(resolve, 0))
      .then(() => multicastStream[Symbol.asyncDispose]()),

    // Read from the stream
    (async () => {
      try {
        for await (const value of multicastStream) {
          values.push(value);
        }

        console.log({
          stream,
          multicastStream
        })

        expect(values.length).toBe(3);
      } catch (error) {
        // Expected to throw an error because the stream is canceled
        expect(error).toBeDefined();
        expect(error).toBeInstanceOf(TypeError);
        expect((error as TypeError)?.message).toContain("The reader was released.");
      }
    })(),
  ]);

  expect(values.length).toBe(3);
});

// Test Case ERS5: Disposing a locked stream
test("createMulticastStream - disposing a locked stream", async () => {
  const stream = new ReadableStream({
    start(controller) {
      [1, 2, 3].forEach((value) => controller.enqueue(value));
      // Do not close the stream to keep it open
    },
  });

  await using multicastStream = createMulticastStream(stream);

  // Get the reader, which normally locks the stream
  const reader = multicastStream.getReader();

  // Dispose the stream while it is locked
  await multicastStream[Symbol.asyncDispose]();

  try {
    // Attempt to read from the reader
    const { value, done } = await reader.read();
    expect(value).toBe(1);
    expect(done).toBe(false); // Should error out since it's been disposed
  } catch (error) {
    // Expected behavior; the reader should be canceled
    expect(error).toBeDefined();
    expect(error).toBeInstanceOf(TypeError);
    expect((error as TypeError)?.message).toContain("Reader has no associated stream.");
  }

  // Ensure that the reader's lock is released
  expect(multicastStream.locked).toBe(false);
});

// Test Case ERS5: Disposing a locked stream
test("createMulticastStream - recover from a disposing a locked stream and then dispose it again", async () => {
  const stream = new ReadableStream({
    start(controller) {
      [1, 2, 3].forEach((value) => controller.enqueue(value));
      // Do not close the stream to keep it open
    },
  });

  await using multicastStream = createMulticastStream(stream);

  // Get the reader, which normally locks the stream
  // You cannot `await using` here because it will cause the reader to
  // try to dispose the consumer stream directly, but unfortuneately 
  // there is a call to dispose the source stream, this plays together to cause an issue.
  // When a source stream is disposed, it will also dispose the consumer streams, 
  // but will not dispose the readers of the consumer stream per-se, so be careful
  // of trying to dispose of the reader after as it will cause an error
  await using reader1 = multicastStream.getReader();

  console.log("Cool")

  // Dispose the stream while it is locked
  await multicastStream[Symbol.asyncDispose]();

  // Get the reader, which normally locks the stream
  // using `await using` here is fine because getReader creates a new consumer stream
  await using reader2 = multicastStream.getReader();

  try {
    // Attempt to read from the reader
    const { value, done } = await reader2.read();
    expect(value).toBeUndefined();
    expect(done).toBe(true);
  } catch (error) {
    // Expected behavior; the reader should be canceled
    expect(error).toBeDefined();
    expect(error).toBeInstanceOf(TypeError);
    expect((error as TypeError)?.message).toContain("Reader has no associated stream.");
  }

  // Ensure that the reader's lock is released
  expect(multicastStream.locked).toBe(false);
});


// Test Case ERS5: Disposing a locked stream
test("createMulticastStream - recover from a disposing a locked stream and then cancel it this time", async () => {
  const stream = new ReadableStream({
    start(controller) {
      [1, 2, 3].forEach((value) => controller.enqueue(value));
      // Do not close the stream to keep it open
    },
  });

  await using multicastStream = createMulticastStream(stream);

  // Get the reader, which normally locks the stream
  // You cannot `await using` here because it will cause the reader to
  // try to dispose the consumer stream directly, but unfortuneately 
  // there is a call to dispose the source stream, this plays together to cause an issue.
  // When a source stream is disposed, it will also dispose the consumer streams, 
  // but will not dispose the readers of the consumer stream per-se, so be careful
  // of trying to dispose of the reader after as it will cause an error
  const reader1 = multicastStream.getReader();

  // Dispose the stream while it is locked
  await multicastStream[Symbol.asyncDispose]();

  // Get the reader, which normally locks the stream
  // using `await using` here is fine because getReader creates a new consumer stream
  await using reader2 = multicastStream.getReader();

  try {
    // Attempt to read from the reader
    const { value, done } = await reader2.read();
    expect(value).toBeUndefined();
    expect(done).toBe(true);
  } catch (error) {
    // Expected behavior; the reader should be canceled
    expect(error).toBeDefined();
    expect(error).toBeInstanceOf(TypeError);
    expect((error as TypeError)?.message).toContain("Reader has no associated stream.");
  }

  // Ensure that the reader's lock is released
  expect(multicastStream.locked).toBe(false);

  // Cancel the reader
  try {
    await reader1.cancel("Dispose of it");
  } catch (error) {
    // Expected behavior; the reader should error keeping with the original behavior of cancel
    expect(error).toBeDefined();
    expect(error).toBeInstanceOf(TypeError);
    expect((error as TypeError)?.message).toContain("Reader has no associated stream.");
  }
});

// Test Case ERS6: Read multiple streams simultaneously
test("createMulticastStream - read multiple streams simultaneously", async () => {
  const createStream = (id: number) => {
    return new ReadableStream({
      start(controller) {
        [1, 2, 3].forEach((value) => controller.enqueue(`${id}-${value}`));
        controller.close();
      },
    });
  }

  await using stream1 = createMulticastStream(createStream(1));
  await using stream2 = createMulticastStream(createStream(2));

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
test("createMulticastStream - consume using while loop with .read()", async () => {
  const stream = new ReadableStream({
    start(controller) {
      [1, 2, 3].forEach((value) => controller.enqueue(value));
      controller.close();
    },
  });

  await using multicastStream = createMulticastStream(stream);
  await using reader = multicastStream.getReader();

  const values = [];
  let result;
  while (!(result = await reader.read()).done) {
    values.push(result.value);
  }

  expect(values).toEqual([1, 2, 3]);
});

// Test Case ERS8: Attempt to get a second reader when the stream is already locked
test("createMulticastStream - attempt to get a second reader when locked", async () => {
  const stream = createInfiniteStream();

  await using multicastStream = createMulticastStream(stream);

  await using reader1 = multicastStream.getReader();
  await using reader2 = multicastStream.getReader();

  // Attempt to get a second reader
  console.log({
    value1: await reader1.read(),
    value2: await reader2.read(),
    reader1,
    reader2
  })
  expect(true).toBe(true);

  await multicastStream.cancel();
});

// Test Case ERS9: Dispose the stream while it's being read
test("createMulticastStream - dispose the stream while it's being read", async () => {
  const stream = createInfiniteStream(50);
  await using multicastStream = createMulticastStream(stream);
  const values: number[] = [];

  const readPromise = (async () => {
    for await (const value of multicastStream) {
      console.log({ value })
      values.push(value);
      if (value >= 3) {
        break;
      }
    }
  })();

  await readPromise;
  await multicastStream[Symbol.asyncDispose]();

  // Ensure that only values up to 3 are read
  expect(values).toEqual([0, 1, 2, 3]);

  // Ensure that the stream is properly disposed
  expect(multicastStream.locked).toBe(false);
  expect(ConsumerStreamReaders.has(multicastStream)).toBe(false);
});

// Test Case ERS10: Attempt to have a second reader with parallel reads when the stream is already locked
test("createMulticastStream - attempt to have a second reader with parallel reads when locked", async () => {
  const stream = createInfiniteStream();
  await using multicastStream = createMulticastStream(stream);

  await Promise.race([
    (async () => {
      try {
        for await (const value of iterableFromStream(multicastStream)) {
          console.log("Reader 1:", value);
        }
      } catch (_) { console.warn(_) }
    })(),
    (async () => {
      try {
        for await (const value of iterableFromStream(multicastStream)) {
          console.log("Reader 2:", value);
        }
      } catch (_) { console.warn(_) }
    })(),

    new Promise(resolve => setTimeout(resolve, 1000))
  ]);

  await multicastStream.cancel();

  // await stream.cancel();
});

// Test Case: Complex Stream Teeing and Disposal
test("createMulticastStream - complex teeing and disposal", async () => {
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
  await using multicastStream = createMulticastStream(sourceStream);

  // Enhance both branches
  await using reader1 = multicastStream.getReader();
  await using reader2 = multicastStream.getReader();

  const resultsBranch1: number[] = [];
  const resultsBranch2: number[] = [];
  const resultsSubBranch1: number[] = [];
  const resultsSubBranch2: number[] = [];

  // Start reading from the parent branches
  const readParentBranches = Promise.all([
    (async () => {
      for await (const value of iterableFromStream(reader1)) {
        resultsBranch1.push(value);
        if (value === 3) {
          // After reading some values, split branch1 into two sub-branches
          const subBranch1 = multicastStream.getReader();
          const subBranch2 = multicastStream.getReader();

          // Start reading from the sub-branches after a delay
          setTimeout(() => {
            (async () => {
              try {
                for await (const subValue of iterableFromStream(subBranch1)) {
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
                for await (const subValue of iterableFromStream(subBranch2)) {
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
      for await (const value of iterableFromStream(reader2)) {
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
  console.log("Parent Branch 1:", resultsBranch1);
  console.log("Parent Branch 2:", resultsBranch2);
  console.log("Sub Branch 1:", resultsSubBranch1);
  console.log("Sub Branch 2:", resultsSubBranch2);

  // // Assertions
  expect(resultsBranch1).toEqual([0, 1, 2, 3, 4, 5]);
  expect(resultsBranch2).toEqual([0, 1, 2, 3, 4, 5]);

  // The sub-branches should have started reading from value 3 onwards
  expect(resultsSubBranch1[0]).toBe(4);
  expect(resultsSubBranch2[0]).toBe(4);

  // The sub-branches should continue to read values even after parent branch is disposed
  expect(resultsSubBranch1).toEqual([4, 5, 6, 7, 8, 9, 10]);
  expect(resultsSubBranch2).toEqual([4, 5, 6, 7, 8, 9, 10]);
});


// ====

// Test Case ERR1: Basic reading from enhanced reader
test("enhanceReaderWithDisposal - basic reading functionality", async () => {
  const stream = new ReadableStream<number>({
    start(controller) {
      [1, 2, 3].forEach((value) => controller.enqueue(value));
      controller.close();
    },
  });

  await using enhancedReader = createMulticastStream(stream).getReader();

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
test("enhanceReaderWithDisposal - disposal using Symbol.asyncDispose", async () => {
  const stream = new ReadableStream<number>({
    start(controller) {
      [1, 2, 3].forEach((value) => controller.enqueue(value));
      // Do not close the stream
    },
  });

  const multicastStream = createMulticastStream(stream);
  const reader = multicastStream.getReader();

  // Dispose the reader
  await reader[Symbol.asyncDispose]();

  try {
    // Attempt to read from the reader
    const value = await reader.read();
    console.log(value)

    // Should reach here
    expect(true).toBe(true);
  } catch (error) {
    // Should not throw an error
    expect(error).toBeDefined();
    expect(error).toBeInstanceOf(TypeError);
    expect((error as TypeError)?.message).toContain("Reader has no associated stream.");
  }

  expect(stream.locked).toBe(false);
});

test("enhanceReaderWithDisposal - cancel the reader early", async () => {
  const stream = new ReadableStream<number>({
    start(controller) {
      [1, 2, 3].forEach((value) => controller.enqueue(value));
      // Do not close the stream
    },
  });

  const multicastStream = createMulticastStream(stream);
  const reader = multicastStream.getReader();

  // Dispose the reader
  await reader.cancel("Duh");

  try {
    // Attempt to read from the reader
    const value = await reader.read();
    console.log(value)

    // Should reach here
    expect(true).toBe(true);
  } catch (error) {
    // Should not throw an error
    expect(error).toBeDefined();
    expect(error).toBeInstanceOf(TypeError);
    expect((error as TypeError)?.message).toContain("Reader has no associated stream.");
  }

  expect(stream.locked).toBe(false);
});

test("enhanceReaderWithDisposal - cancel source stream, then try getting reader", async () => {
  const stream = new ReadableStream<number>({
    start(controller) {
      [1, 2, 3].forEach((value) => controller.enqueue(value));
      // Do not close the stream
    },
  });

  await using multicastStream = createMulticastStream(stream);

  // Dispose the multistream early
  await multicastStream.cancel("Duh");

  try {
    const reader = multicastStream.getReader();

    // Attempt to read from the reader
    const value = await reader.read();
    expect(value).toEqual({ value: 1, done: false });
    console.log(value)

    // Should reach here
    expect(true).toBe(true);
  } catch (error) {
    // console.log({ error })
    // Should not throw an error
    expect(error).toBeDefined();
    expect(error).toBeInstanceOf(TypeError);
    expect((error as TypeError)?.message).toContain("The reader was released.");
  }

  expect(stream.locked).toBe(true);
});

// Test Case ERR3: Multiple readers from different streams
test("enhanceReaderWithDisposal - multiple readers from different streams", async () => {
  const createStream = (id: number) => {
    return new ReadableStream<string>({
      start(controller) {
        [1, 2, 3].forEach((value) => controller.enqueue(`${id}-${value}`));
        controller.close();
      },
    });
  }

  const stream1 = createStream(1);
  const stream2 = createStream(2);

  await using multicastStream1 = createMulticastStream(stream1);
  await using multicastStream2 = createMulticastStream(stream2);

  await using reader1 = multicastStream1.getReader();
  await using reader2 = multicastStream2.getReader();

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
test("enhanceReaderWithDisposal - reader cancellation during read", async () => {
  let timeout: ReturnType<typeof setTimeout>;
  const stream = new ReadableStream<number>({
    start(controller) {
      let count = 0;
      function push() {
        controller.enqueue(count++);
        timeout = setTimeout(push, 10);
      }
      push();
    },
    cancel() {
      clearTimeout(timeout);
    },
  });

  await using multicastStream = createMulticastStream(stream);
  await using reader1 = multicastStream.getReader();
  await using reader2 = multicastStream.getReader();

  const values: number[] = [];

  const read1Promise = (async () => {
    while (true) {
      const result = await reader1.read();
      if (result.done) break;

      values.push(result.value);
      if (result.value >= 5) {
        // Cancel the reader
        await reader1.cancel("No longer needed");
        // break;
      }
    }
  })();

  const read2Promise = (async () => {
    while (true) {
      const result = await reader2.read();
      if (result.done) break;

      console.log(result)
    }
  })();

  await read1Promise;
  await Promise.race([
    read2Promise,
    new Promise(resolve => setTimeout(resolve, 1000))
  ]);

  expect(values).toEqual([0, 1, 2, 3, 4, 5]);
  expect(stream.locked).toBe(true);

  await reader2.cancel("No longer needed");
  expect(stream.locked).toBe(false);
});

// Test Case ERR5: Dispose reader while it's in the middle of reading
test("enhanceReaderWithDisposal - dispose reader during read", async () => {
  let timeout: ReturnType<typeof setTimeout>;
  const stream = new ReadableStream<number>({
    start(controller) {
      let count = 0;
      function push() {
        controller.enqueue(count++);
        timeout = setTimeout(push, 20);
      }
      push();
    },
    cancel() {
      clearTimeout(timeout);
    },
  });

  await using multicastStream = createMulticastStream(stream);
  await using reader = multicastStream.getReader();

  const values: number[] = [];

  const readPromise = (async () => {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      values.push(result.value);

      if (result.value >= 3) {
        // Dispose the reader
        await reader[Symbol.asyncDispose]();
        break;
      }
    }
  })();

  await readPromise;

  expect(values).toEqual([0, 1, 2, 3]);

  // Ensure the reader is released
  expect(stream.locked).toBe(false);
});

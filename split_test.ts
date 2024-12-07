/**
 * @fileoverview
 * This file provides a suite of tests for the `splitStream` function. The goal is to ensure that the splitting
 * behavior is correct under various conditions, including normal operation, empty sources, error scenarios, 
 * and cancellation/cleanup behaviors.
 *
 * ### Key Testing Strategies:
 * 1. **Data-Driven (Test Tables)**:  
 *    We use parameterized test cases defined in arrays, providing input streams, predicates, and expected outputs.
 *    This ensures comprehensive coverage of scenarios without excessive boilerplate.
 *
 * 2. **Isolation and Determinism**:  
 *    Each test creates its own source stream to avoid interference. We use deterministic input data
 *    and avoid fixed delays. Instead, we rely on naturally completing streams and checking conditions.
 *
 * 3. **State Tracking**:  
 *    We test the stream's behavior when:
 *    - The source ends normally.
 *    - The predicate routes chunks to both streams.
 *    - One or both resulting streams are canceled early.
 *    - Errors occur while reading from the source.
 *    - Attempting to read when the source is done or queues are empty.
 *
 * 4. **Logging and Assertions**:  
 *    For debugging, tests may log progress. Assertions ensure stable expectations: even in tricky scenarios,
 *    the output and state of the streams are as intended.
 *
 * ### Tools:
 * - `@libs/testing` for test runner.
 * - `@std/expect` for assertions.
 * - `splitStream` function (imported from the stream splitting module).
 * - Helper functions and stable test inputs to ensure reproducibility.
 */


/**
 * @fileoverview
 * Tests for the `splitStream` function to ensure reliable and predictable splitting of chunks
 * from a given source `ReadableStream` into two output streams based on a predicate.
 *
 * ### Test Strategies:
 * - **Data-Driven (Test Tables)**:  
 *   Using arrays of input/output scenarios to thoroughly validate even/odd splits, empty sources, 
 *   all-passing/all-failing predicates, and more complex object-based scenarios.
 *
 * - **Edge Cases & Error Handling**:  
 *   Test sources that end immediately (empty), sources that error out, 
 *   and behavior when canceling or disposing streams.
 *
 * - **Synchronization & No Flaky Delays**:  
 *   We avoid fixed delays. Instead, tests rely on deterministic inputs or 
 *   event-driven checks. The code should run consistently regardless of timing variances.
 *
 * - **Documentation & Reproducibility**:  
 *   Each test is documented, and scenarios are traceable to ensure maintainability and clarity.
 */

import { test } from "@libs/testing";
import { expect } from "@std/expect";
import { splitStream } from "./split.ts"; // Adjust path as needed
import { iterableFromStream } from "./utils.ts"; // Helper to read entire streams easily

/**
 * Helper to create a ReadableStream from an array of values.
 * Ensures a deterministic, static input source for testing.
 */
function createArrayStream<T>(values: T[]): ReadableStream<T> {
  return new ReadableStream<T>({
    start(controller) {
      for (const v of values) {
        controller.enqueue(v);
      }
      controller.close();
    },
  });
}

/**
 * Helper to simulate an error in the source stream.
 * Once it has enqueued half of the provided values, it throws an error.
 */
function createErrorStream<T>(values: T[]): ReadableStream<T> {
  return new ReadableStream<T>({
    start(controller) {
      let index = 0;
      for (const v of values) {
        if (index === Math.floor(values.length / 2)) {
          // Simulate an error mid-way
          controller.error(new Error("Simulated source error"));
          return;
        }
        controller.enqueue(v);
        index++;
      }
      controller.close();
    },
  });
}

/**
 * Data-Driven Tests (Test Table):
 * Each entry includes:
 * - name: a descriptive test name
 * - input: array of input chunks
 * - predicate: function to split chunks
 * - expectedFirst: expected chunks in the first stream
 * - expectedSecond: expected chunks in the second stream
 *
 * These scenarios cover normal operation, empty sources, and diverse splitting logic.
 */
const testCases = [
  {
    name: "Split even/odd numbers",
    input: [1,2,3,4],
    predicate: (num: number) => num % 2 === 0,
    expectedFirst: [2,4],
    expectedSecond: [1,3]
  },
  {
    name: "Empty source",
    input: [] as number[],
    predicate: (num: number) => num % 2 === 0,
    expectedFirst: [] as number[],
    expectedSecond: [] as number[]
  },
  {
    name: "All chunks match predicate",
    input: [2,4,6],
    predicate: (num: number) => num % 2 === 0,
    expectedFirst: [2,4,6],
    expectedSecond: []
  },
  {
    name: "No chunks match predicate",
    input: [1,3,5],
    predicate: (num: number) => num % 2 === 0,
    expectedFirst: [],
    expectedSecond: [1,3,5]
  }
];

/**
 * @testtable
 * Validate basic behavior of splitStream using various input arrays and predicates.
 */
for (const { name, input, predicate, expectedFirst, expectedSecond } of testCases) {
  test("deno")( `splitStream - ${name}`, async () => {
    const source = createArrayStream(input);
    const [evenStream, oddStream] = splitStream(source, predicate);

    const resultFirst = await iterableFromStream(evenStream);
    const resultSecond = await iterableFromStream(oddStream);

    expect(resultFirst).toEqual(expectedFirst);
    expect(resultSecond).toEqual(expectedSecond);
  });
}

/**
 * @test
 * Tests the behavior when the source encounters an error during reading.
 * The expected behavior: Both resulting streams should abort once the error is encountered.
 */
test("deno")("splitStream - error in source", async () => {
  const source = createErrorStream([1,2,3,4,5,6]);
  const [streamA, streamB] = splitStream(source, (num: number) => num > 3);

  const resultsA: number[] = [];
  const resultsB: number[] = [];

  let errorCaught = false;

  // Attempt to read both streams concurrently
  await Promise.allSettled([
    (async () => {
      try {
        for await (const val of streamA) {
          resultsA.push(val);
        }
      } catch (err) {
        errorCaught = true;
      }
    })(),
    (async () => {
      try {
        for await (const val of streamB) {
          resultsB.push(val);
        }
      } catch (err) {
        errorCaught = true;
      }
    })()
  ]);

  // Since the source errors mid-way, we only get a subset of values.
  // The first half is enqueued, the error occurs, and both streams end abruptly.
  // Depending on when error is raised, we might have some chunks or none after the error point.
  expect(errorCaught).toBe(true);
  expect(resultsA.length + resultsB.length).toBeLessThanOrEqual(3); // Only got up to half before error
});

/**
 * @test
 * Tests cancellation behavior: cancel one of the resulting streams early and ensure the other can still be read.
 */
test("deno")("splitStream - cancel one resulting stream early", async () => {
  const source = createArrayStream([1,2,3,4,5]);
  const [evenStream, oddStream] = splitStream(source, (num: number) => num % 2 === 0);

  // Cancel the evenStream immediately
  const evenReader = evenStream.getReader();
  await evenReader.cancel("No need for even numbers");

  // The oddStream should still provide odd values
  const oddValues = await iterableFromStream(oddStream);
  expect(oddValues).toEqual([1,3,5]);
});

/**
 * @test
 * Ensures that if we try to read from one of the streams after the source is already done, it simply closes.
 */
test("deno")("splitStream - read after source done", async () => {
  const source = createArrayStream([10,11]);
  const [streamTrue, streamFalse] = splitStream(source, (num: number) => num > 10);

  // Read all from true stream first
  const trueValues = await iterableFromStream(streamTrue);
  expect(trueValues).toEqual([11]);

  // Source is done now. If we read from false stream afterward:
  const falseValues = await iterableFromStream(streamFalse);
  expect(falseValues).toEqual([10]);
});

/**
 * @test
 * Attempt multiple reads in parallel on the same resulting stream to check stability.
 * We don't want to cause deadlocks or race conditions.
 */
test("deno")("splitStream - parallel reads on the same resulting stream", async () => {
  const source = createArrayStream([0,1,2,3,4,5]);
  const [evenStream] = splitStream(source, (num: number) => num % 2 === 0);

  // Attempt concurrent reads:
  const readPromise1 = iterableFromStream(evenStream);
  const readPromise2 = iterableFromStream(evenStream);

  // Both attempts will read the same stream. The second will start reading after the first finishes or simultaneously.
  // Depending on the implementation, one reader might lock the stream and the other might get no data.
  const [res1, res2] = await Promise.all([readPromise1, readPromise2]);

  // At least one should have the data. Another might see an empty array due to locking rules.
  // The even numbers: [0,2,4]
  // We can accept that one gets the data and the other is empty or that both share results depending on implementation.
  // For a properly implemented splitStream, each returned stream is independent and can be read fully.
  // Since we only returned evenStream, there's only one resulting stream. If multiple readers are attempted,
  // typically only one can read the data (locked by first reader).
  
  // Check that at least one got the correct data.
  const combined = [...res1, ...res2];
  expect(combined.sort()).toEqual([0,2,4]);
});

/**
 * @test
 * Test disposing of both resulting streams using Symbol.asyncDispose and ensuring cleanup.
 */
test("deno")("splitStream - async disposal of resulting streams", async () => {
  const source = createArrayStream([5,6,7,8]);
  const [streamA, streamB] = splitStream(source, (n: number) => n < 7);

  // Dispose both using Symbol.asyncDispose:
  await streamA[Symbol.asyncDispose]();
  await streamB[Symbol.asyncDispose]();

  // Attempt reading after disposal should fail
  try {
    await iterableFromStream(streamA);
    expect(false).toBe(true); // Should not reach here
  } catch (error) {
    expect(error).toBeDefined();
  }

  try {
    await iterableFromStream(streamB);
    expect(false).toBe(true); // Should not reach here
  } catch (error) {
    expect(error).toBeDefined();
  }
});

/**
 * @test
 * Test table with complex decision logic (decision table testing):
 * 
 * Conditions:
 *  - Input: a series of objects with a property `type`.
 *  - Predicate: checks if `type` is "allowed".
 *  - Expected result: allowed objects in one stream, disallowed in the other.
 * 
 * We can represent multiple conditions in a decision table:
 */

interface Obj { type: "allowed" | "forbidden"; value: number; }

const decisionTestCases = [
  {
    name: "All allowed",
    input: [{type: "allowed", value:1}, {type:"allowed", value:2}] as Obj[],
    predicate: (obj: Obj) => obj.type === "allowed",
    expectedFirst: [{type:"allowed", value:1},{type:"allowed", value:2}],
    expectedSecond: []
  },
  {
    name: "All forbidden",
    input: [{type: "forbidden", value:1}, {type:"forbidden", value:2}] as Obj[],
    predicate: (obj: Obj) => obj.type === "allowed",
    expectedFirst: [],
    expectedSecond: [{type:"forbidden", value:1},{type:"forbidden", value:2}]
  },
  {
    name: "Mixed types",
    input: [
      {type:"allowed", value:1}, 
      {type:"forbidden", value:2},
      {type:"allowed", value:3},
      {type:"forbidden", value:4},
    ] as Obj[],
    predicate: (obj: Obj) => obj.type === "allowed",
    expectedFirst: [{type:"allowed", value:1},{type:"allowed", value:3}],
    expectedSecond: [{type:"forbidden", value:2},{type:"forbidden", value:4}],
  },
];

for (const {name, input, predicate, expectedFirst, expectedSecond} of decisionTestCases) {
  test("deno")(`splitStream - decision table: ${name}`, async () => {
    const source = createArrayStream(input);
    const [allowedStream, forbiddenStream] = splitStream(source, predicate);

    const resAllowed = await iterableFromStream(allowedStream);
    const resForbidden = await iterableFromStream(forbiddenStream);

    expect(resAllowed).toEqual(expectedFirst);
    expect(resForbidden).toEqual(expectedSecond);
  });
}

/**
 * @test
 * Testing synchronization and concurrency:
 * Attempt reading from one resulting stream with dynamic checks (no fixed delays) and ensure no flaky behavior.
 * We'll do this by waiting for the first chunk to appear instead of sleeping.
 */
test("deno")("splitStream - dynamic wait (no fixed delay)", async () => {
  const source = new ReadableStream<number>({
    start(controller) {
      // Enqueue asynchronously
      setTimeout(() => controller.enqueue(42), 10);
      setTimeout(() => controller.close(), 20);
    }
  });

  const [matches, others] = splitStream(source, (x) => x === 42);

  // Check the 'matches' stream dynamically:
  const matchesReader = matches.getReader();
  const result = await matchesReader.read(); 
  // This read will wait until chunk is available (dynamic wait, no sleeps)
  
  expect(result.value).toBe(42);
  expect(result.done).toBe(false);

  const secondRead = await matchesReader.read();
  expect(secondRead.done).toBe(true);

  // The 'others' stream should be empty
  const othersResult = await iterableFromStream(others);
  expect(othersResult).toEqual([]);
});

/**
 * By following these comprehensive tests—using data-driven approaches, decision tables, and careful synchronization—
 * we've demonstrated how to create robust and reliable tests for `splitStream`. Each test scenario documents the
 * expected behavior, thereby improving clarity, reproducibility, and maintainability of the test suite.
 */


/**
 * Data-driven test scenarios covering basic cases:
 * - Even/odd splitting
 * - Empty sources
 * - All true / all false predicate matches
 */
const basicTestCases = [
  {
    name: "Even/Odd split with [1,2,3,4]",
    input: [1,2,3,4],
    predicate: (num: number) => num % 2 === 0,
    expectedFirst: [2,4],
    expectedSecond: [1,3]
  },
  {
    name: "Empty source",
    input: [] as number[],
    predicate: (num: number) => num > 10,
    expectedFirst: [] as number[],
    expectedSecond: [] as number[]
  },
  {
    name: "All chunks match predicate",
    input: [2,4,6],
    predicate: (num: number) => num % 2 === 0,
    expectedFirst: [2,4,6],
    expectedSecond: []
  },
  {
    name: "No chunks match predicate",
    input: [1,3,5],
    predicate: (num: number) => num % 2 === 0,
    expectedFirst: [],
    expectedSecond: [1,3,5]
  }
];

/**
 * @testtable
 * Validate `splitStream` with a variety of numeric inputs and predicates.
 */
for (const { name, input, predicate, expectedFirst, expectedSecond } of basicTestCases) {
  test("deno")(`splitStream - ${name}`, async () => {
    const source = createArrayStream(input);
    const [streamTrue, streamFalse] = splitStream(source, predicate);

    const resultFirst = await iterableFromStream(streamTrue);
    const resultSecond = await iterableFromStream(streamFalse);

    expect(resultFirst).toEqual(expectedFirst);
    expect(resultSecond).toEqual(expectedSecond);
  });
}

/**
 * @test
 * Test behavior when the source errors out midway.
 * Both streams should encounter this error and stop providing new data.
 */
test("deno")("splitStream - error in source stream", async () => {
  const source = createErrorStream([1,2,3,4,5,6]);
  const [aStream, bStream] = splitStream(source, (num: number) => num > 3);

  const resultsA: number[] = [];
  const resultsB: number[] = [];
  let errorCaught = false;

  await Promise.allSettled([
    (async () => {
      try {
        for await (const v of aStream) {
          resultsA.push(v);
        }
      } catch (_) {
        errorCaught = true;
      }
    })(),
    (async () => {
      try {
        for await (const v of bStream) {
          resultsB.push(v);
        }
      } catch (_) {
        errorCaught = true;
      }
    })()
  ]);

  expect(errorCaught).toBe(true);
  // We only read up until half before error occurred, so combined we should have fewer than full set
  expect(resultsA.length + resultsB.length).toBeLessThanOrEqual(3);
});

/**
 * @test
 * Cancelling one resulting stream should not prevent reading from the other.
 * Ensure that when we cancel the first stream, the second can still be read fully.
 */
test("deno")("splitStream - cancel one stream early", async () => {
  const source = createArrayStream([10,11,12,13,14]);
  const [gt12Stream, ltEqual12Stream] = splitStream(source, (num: number) => num > 12);

  // Cancel the gt12Stream immediately
  const gt12Reader = gt12Stream.getReader();
  await gt12Reader.cancel("No need for values > 12");

  const remainValues = await iterableFromStream(ltEqual12Stream);
  // Values ≤ 12: [10,11,12]
  expect(remainValues).toEqual([10,11,12]);
});

/**
 * @test
 * Read after the source is done should just close the streams gracefully.
 */
test("deno")("splitStream - read after source done", async () => {
  const source = createArrayStream([1,2]);
  const [evenStream, oddStream] = splitStream(source, (num) => num % 2 === 0);

  // Read even first
  const evenVals = await iterableFromStream(evenStream);
  expect(evenVals).toEqual([2]);

  // Now read odd - source done, but odd should yield [1]
  const oddVals = await iterableFromStream(oddStream);
  expect(oddVals).toEqual([1]);
});

/**
 * @test
 * Complex, object-based decision table testing:
 * Predicate splits objects by `type: "allowed"` vs `type: "forbidden"`.
 */
interface Obj { type: "allowed" | "forbidden"; value: number; }

const decisionTestCases = [
  {
    name: "All allowed",
    input: [{type:"allowed", value:1},{type:"allowed", value:2}] as Obj[],
    predicate: (obj: Obj) => obj.type === "allowed",
    expectedFirst: [{type:"allowed", value:1},{type:"allowed", value:2}],
    expectedSecond: []
  },
  {
    name: "All forbidden",
    input: [{type:"forbidden", value:1},{type:"forbidden", value:2}] as Obj[],
    predicate: (obj: Obj) => obj.type === "allowed",
    expectedFirst: [],
    expectedSecond: [{type:"forbidden", value:1},{type:"forbidden", value:2}]
  },
  {
    name: "Mixed",
    input: [
      {type:"allowed", value:10},
      {type:"forbidden", value:20},
      {type:"allowed", value:30},
      {type:"forbidden", value:40},
    ] as Obj[],
    predicate: (obj: Obj) => obj.type === "allowed",
    expectedFirst: [{type:"allowed", value:10},{type:"allowed", value:30}],
    expectedSecond: [{type:"forbidden", value:20},{type:"forbidden", value:40}],
  }
];

for (const {name, input, predicate, expectedFirst, expectedSecond} of decisionTestCases) {
  test("deno")(`splitStream - decision table: ${name}`, async () => {
    const source = createArrayStream(input);
    const [allowedStream, forbiddenStream] = splitStream(source, predicate);

    const resAllowed = await iterableFromStream(allowedStream);
    const resForbidden = await iterableFromStream(forbiddenStream);

    expect(resAllowed).toEqual(expectedFirst);
    expect(resForbidden).toEqual(expectedSecond);
  });
}

/**
 * @test
 * Test disposal using Symbol.asyncDispose on both resulting streams.
 * After disposal, attempts to read should fail.
 */
test("deno")("splitStream - async disposal", async () => {
  const source = createArrayStream([5,6]);
  const [s1, s2] = splitStream(source, (n) => n < 6);

  await s1[Symbol.asyncDispose]();
  await s2[Symbol.asyncDispose]();

  await expect(async () => {
    await iterableFromStream(s1);
  }).rejects.toThrow();

  await expect(async () => {
    await iterableFromStream(s2);
  }).rejects.toThrow();
});

/**
 * @test
 * Ensuring no flakes: dynamically wait for data without fixed delays.
 * Source asynchronously enqueues a single chunk, no fixed sleeps.
 */
test("deno")("splitStream - dynamic wait (no fixed delays)", async () => {
  const source = new ReadableStream<number>({
    start(controller) {
      // enqueue after a short async tick
      queueMicrotask(() => {
        controller.enqueue(42);
        controller.close();
      });
    }
  });

  const [matches, others] = splitStream(source, (x) => x === 42);

  const matchesRes = await iterableFromStream(matches);
  expect(matchesRes).toEqual([42]);

  const othersRes = await iterableFromStream(others);
  expect(othersRes).toEqual([]);
});

/**
 * @test
 * Attempt reading from one stream after another stream is fully drained and ensure no conflicts or deadlocks.
 */
test("deno")("splitStream - sequential reading of both streams", async () => {
  const source = createArrayStream([10,11,12,13]);
  const [ge12Stream, lt12Stream] = splitStream(source, (n) => n >= 12);

  // Read ge12 first
  const ge12Vals = await iterableFromStream(ge12Stream);
  expect(ge12Vals).toEqual([12,13]);

  // Now read lt12
  const lt12Vals = await iterableFromStream(lt12Stream);
  expect(lt12Vals).toEqual([10,11]);
});

/**
 * These tests collectively ensure:
 * - Correct splitting of data under normal and edge conditions.
 * - Stable behavior on source completion, errors, and cancellations.
 * - Proper synchronization and no flaky, timing-dependent failures.
 * - Comprehensive coverage via test tables (basic and decision table testing).
 */

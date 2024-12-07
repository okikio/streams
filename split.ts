/**
 * Context object to hold shared state between `splitStream` and `readFromSource`.
 *
 * This context tracks the source reader, the predicate used for splitting, and the state of
 * the two target queues. Each queue corresponds to one of the resulting `ReadableStream`s.
 * 
 * ### State Variables:
 * - `source`: A `ReadableStreamDefaultReader` for the original source stream.
 * - `predicate`: A function to determine which queue a chunk should be routed to.
 * - `queues`: An array of two objects, each containing:
 *    - `readable`: The `ReadableStream` linked to this queue.
 *    - `writer`: A `WritableStreamDefaultWriter` to enqueue chunks into this queue.
 *    - `size`: The current number of chunks buffered in this queue.
 *    - `closed`: Whether this queue has been fully closed.
 * - `sourceDone`: Indicates if the source stream has ended.
 *
 * The `splitStream` mechanism uses these variables to track the progress of reading from
 * the source and distributing chunks. As chunks flow from the source, `predicate` decides
 * which queue they belong to. When the source completes, both queues are closed.
 */
export interface SplitStreamContext<T, F = unknown> {
  source: ReadableStreamDefaultReader<T | F> | null;
  predicate: ((chunk: T | F) => boolean) | null;
  queues: [
    { readable: ReadableStream<T> | null, writer: WritableStreamDefaultWriter<T> | null, size: number, closed: boolean },
    { readable: ReadableStream<F> | null, writer: WritableStreamDefaultWriter<F> | null, size: number, closed: boolean },
  ];
  sourceDone: boolean;
}

/**
 * Splits a source `ReadableStream` into two separate `ReadableStreams` based on a predicate function.
 *
 * ### Predicate-Based Splitting:
 * Each chunk from the source stream is evaluated using the provided predicate function.
 * - If `predicate(chunk)` returns `true`, the chunk is routed into the first resulting stream.
 * - If `predicate(chunk)` returns `false`, the chunk is routed into the second resulting stream.
 *
 * ### Backpressure and Flow Control:
 * Internally, two `TransformStream`s are used as queues (`highWaterMark: Infinity`) to
 * allow buffering multiple chunks. Each resulting stream pulls chunks on-demand,
 * triggering reads from the source only as needed.
 *
 * ### Lifecycle and Resource Management:
 * - When the source is exhausted (`sourceDone = true`), both target streams will eventually
 *   close once all buffered chunks are read.
 * - Cancelling either resulting stream triggers cleanup of resources and may also lead to
 *   cancellation of the source if both streams are fully released.
 *
 * @template T The type of chunks that pass the predicate.
 * @template F The type of chunks that do not pass the predicate.
 * 
 * @param sourceStream The original source `ReadableStream` to be split.
 * @param predicate A function that evaluates each chunk. `true` routes the chunk to the first stream, `false` to the second.
 * @returns A tuple of two `ReadableStream`s:
 *  - The first contains chunks where `predicate(chunk) === true`.
 *  - The second contains chunks where `predicate(chunk) === false`.
 *
 * @example
 * ```ts
 * import { splitStream } from "./stream.ts";
 *
 * // Example source stream with numbers
 * const sourceStream = new ReadableStream({
 *   start(controller) {
 *     controller.enqueue(1);
 *     controller.enqueue(2);
 *     controller.enqueue(3);
 *     controller.enqueue(4);
 *     controller.close();
 *   }
 * });
 *
 * const isEven = (value: number) => value % 2 === 0;
 * const [evenStream, oddStream] = splitStream(sourceStream, isEven);
 *
 * // Reading from the even stream
 * const evenReader = evenStream.getReader();
 * evenReader.read().then(({ value }) => console.log("Even:", value)); // Logs: 2
 *
 * // Reading from the odd stream
 * const oddReader = oddStream.getReader();
 * oddReader.read().then(({ value }) => console.log("Odd:", value)); // Logs: 1
 * ```
 *
 * @example
 * ```ts
 * // A more complex example tracking state changes:
 * // Consider a source producing: [10, 15, 20, 25, 2]
 * // Predicate: chunk > 10
 * // Initially: sourceDone = false, queues = [{size: 0, closed: false}, {size: 0, closed: false}]
 * 
 * const source = new ReadableStream<number>({
 *   start(controller) {
 *     [10, 15, 20, 25, 2].forEach(n => controller.enqueue(n));
 *     controller.close(); // After enqueuing all
 *   }
 * });
 *
 * const isGreaterThan10 = (val: number) => val > 10;
 * const [above10Stream, atOrBelow10Stream] = splitStream(source, isGreaterThan10);
 *
 * // Reading from above10Stream:
 * // 1st pull: queue empty, triggers readFromSource -> reads 10
 * // predicate(10) = false -> goes to atOrBelow10 queue: size=1
 * // above10 queue still empty, tries another readFromSource -> reads 15
 * // predicate(15) = true -> goes to above10 queue: size=1
 * // now above10 pull can dequeue 15
 * 
 * // After more pulls:
 * // Chunks >10 (15,20,25) go to above10: eventually above10: size will track these until read
 * // Chunks ≤10 (10,2) go to atOrBelow10
 * // When source is done: sourceDone = true, no more reads
 * // Reading continues until all sizes are down to zero, and both queues close
 * 
 * const r1 = above10Stream.getReader();
 * const r2 = atOrBelow10Stream.getReader();
 * 
 * async function readAll(reader: ReadableStreamDefaultReader<number>, label: string) {
 *   let result;
 *   while (!(result = await reader.read()).done) {
 *     console.log(`${label} got: ${result.value}`);
 *   }
 *   console.log(`${label} done`);
 * }
 *
 * await Promise.all([readAll(r1, "Above10"), readAll(r2, "AtOrBelow10")]);
 * // Output:
 * // AtOrBelow10 got: 10
 * // Above10 got: 15
 * // Above10 got: 20
 * // Above10 got: 25
 * // AtOrBelow10 got: 2
 * // Above10 done
 * // AtOrBelow10 done
 * ```
 */
export function splitStream<T, F = unknown>(
  sourceStream: ReadableStream<T | F>,
  predicate: (chunk: T | F) => boolean
):
  & readonly [ReadableStream<T>, ReadableStream<F>]
  & AsyncDisposable {
  // Create TransformStreams to act as minimal queues.
  // We use highWaterMark = Infinity so we don't block writes due to backpressure too early.
  const { writable: queue1, readable: readable1 } = new TransformStream<T>(undefined, undefined, { highWaterMark: Infinity });
  const { writable: queue2, readable: readable2 } = new TransformStream<F>(undefined, undefined, { highWaterMark: Infinity });

  const context: SplitStreamContext<T, F> = {
    source: sourceStream.getReader(),
    predicate,
    queues: [
      { readable: readable1, writer: queue1.getWriter(), size: 0, closed: false },
      { readable: readable2, writer: queue2.getWriter(), size: 0, closed: false },
    ],
    sourceDone: false,
  };

  const trueStream = createPullStream<T, F, T>(context, { index: 0 });
  const falseStream = createPullStream<T, F, F>(context, { index: 1 });

  return Object.assign([
    trueStream,
    falseStream
  ] as const, {
    async [Symbol.asyncDispose]() {
      await Promise.all([
        trueStream.cancel("Symbol.asyncDispose"),
        falseStream.cancel("Symbol.asyncDispose"),
      ]);
    },
  })
}

/**
 * Creates a `ReadableStream` that, upon each pull, attempts to ensure there is data available in the corresponding queue.
 * It triggers `readFromSource` if needed to fetch more chunks and routes them through the predicate.
 * 
 * @internal
 *
 * @param context The shared `SplitStreamContext`.
 * @param param0 The index of the queue to connect this pull stream to.
 * @returns A `ReadableStream` that will yield only the filtered chunks for this queue.
 */
function createPullStream<T, F = unknown, V = T | F>(context: SplitStreamContext<T, F>, { index: currentQueueIndex }: { index: number }): ReadableStream<V> {
  const queue = context.queues[currentQueueIndex];
  const readable = queue.readable as ReadableStream<V> | null;

  return new ReadableStream<V>({
    async pull(controller) {
      if (context.sourceDone) {
        // If the source is done and no more data is expected, close the stream.
        controller.close();
        return;
      }

      // If the queue is empty and source is not done, try reading more from source.
      while (queue.size === 0 && !context.sourceDone) {
        await readFromSource(context);
      }

      const reader = readable?.getReader();
      try {
        // Attempt to read a chunk from the queue
        const { value, done } = await reader?.read() ?? { value: undefined, done: true };

        if (done) {
          // If this queue is empty but source isn't done,
          // don't close the readable stream, wait for more data
          if (!context.sourceDone) return; 

          // Otherwise close the readable stream if source is also done
          controller.close();
        } else {
          // Retrieve chunk and add it to the stream; decrement total size of queue
          controller.enqueue(value as V);
          queue.size--;
        }
      } catch (error) {
        // If an error occurs while reading, report it to the consumer
        controller.error(error);
      } finally {
        // Always release the reader lock after use
        reader?.releaseLock?.();
      }
    },
    async cancel(reason) {
      // Called when the consumer cancels reading.
      await readable?.cancel(reason);

      // Mark this queue as closed and release resources
      const allQueuesCancelled = context.queues.every((queue) => {
        if ((queue?.readable as V) === readable) {
          try {
            queue.writer?.releaseLock();
            queue.closed = true;
          } finally {
            queue.readable = null;
            queue.writer = null;
          }
        }

        return queue?.readable === null;
      });

      // If all queues are cancelled, we can safely cancel the source reader
      if (allQueuesCancelled && context.source) {
        try {
          if (!context.sourceDone) {
            await context.source?.cancel?.(reason);
          }

          context.source?.releaseLock?.();
        } finally {
          context.sourceDone = true;
          context.source = null;
        }
      }
    }
  });
}

/**
 * Reads a single chunk from the source stream and routes it to the appropriate queue.
 * If the source is done, it closes all queues and marks the source as done.
 * 
 * Non-exported function. Internally used by `createPullStream` to ensure data availability.
 *
 * ### Steps:
 * 1. Attempt to read from `context.source`.
 * 2. If `done` is true, mark `sourceDone` and close all queues.
 * 3. If `done` is false, use `predicate` to determine which queue to write the chunk to.
 * 4. Increase the `size` counter of the chosen queue.
 *
 * @param context The shared `SplitStreamContext`.
 */
async function readFromSource<T, F = unknown>(context: SplitStreamContext<T, F>) {
  const { source, predicate } = context;
  if (context.sourceDone) return;

  try {
    const { value, done } = (await source?.read()) ?? { value: undefined, done: true };
    if (done) {
      // No more chunks from source, mark as done and close queues
      context.sourceDone = true;
      return await Promise.all(
        context.queues.map(async (queue) => {
          if (queue.closed) return;
          queue.closed = true;

          try {
            await queue?.writer?.close();
            queue.writer?.releaseLock();
          } finally {
            queue.readable = null;
            queue.writer = null;
          }
        })
      );
    }

    // Route chunk based on predicate
    if (predicate?.(value)) {
      await context.queues[0]?.writer?.write(value as T);
      context.queues[0].size++;
    } else {
      await context.queues[1]?.writer?.write(value as F);
      context.queues[1].size++;
    }
  } catch (error) {
    // If an error occurs reading from source, abort both queues
    console.log("Error reading from source", error);
    await Promise.all(
      context.queues.map((queue) => queue?.writer?.abort(error))
    );
  }
}

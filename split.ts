/**
 * Context object to hold shared state between splitStream and readFromSource.
 */
export interface SplitStreamContext<T, F = unknown> {
  source: ReadableStreamDefaultReader<T | F> | null;
  predicate: ((chunk: T | F) => boolean) | null;
  queues: [
    { readable: ReadableStream<T> | null, writer: WritableStreamDefaultWriter<T> | null, size: number },
    { readable: ReadableStream<F> | null, writer: WritableStreamDefaultWriter<F> | null, size: number },
  ];
  readInProgress: boolean;
  sourceDone: boolean;
}

/**
 * Splits a source ReadableStream into two separate ReadableStreams based on a predicate function.
 *
 * ### Predicate-Based Splitting:
 * - The source stream is evaluated chunk by chunk using the provided predicate function.
 * - Chunks that satisfy the predicate are routed to the first stream.
 * - Chunks that do not satisfy the predicate are routed to the second stream.
 *
 * ### Disposal:
 * - Each resulting stream supports multiple readers and will automatically handle resource cleanup once all consumers have finished reading.
 * - The channels used to manage the streams are properly disposed of when the streams are closed or no longer needed.
 *
 * @template T The type of data contained in the source stream.
 * @param source The original source ReadableStream to be split.
 * @param predicate A function that evaluates each chunk and returns a boolean. `true` means the chunk goes to the first stream, `false` means it goes to the second stream.
 * @returns An array containing two ReadableStreams:
 * - The first stream contains chunks that satisfied the predicate.
 * - The second stream contains chunks that did not satisfy the predicate.
 *
 * @example
 * ```ts
 * import { splitByStream } from "./stream.ts"
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
 * const [evenStream, oddStream] = splitByStream(sourceStream, isEven);
 *
 * // Reading from the even stream
 * const evenReader = evenStream.getReader();
 * evenReader.read().then(({ value }) => console.log("Even:", value)); // Logs: 2
 *
 * // Reading from the odd stream
 * const oddReader = oddStream.getReader();
 * oddReader.read().then(({ value }) => console.log("Odd:", value)); // Logs: 1
 * ```
 */
export function splitStream<T, F = unknown>(
  sourceStream: ReadableStream<T | F>,
  predicate: (chunk: T | F) => boolean
):
  & readonly [ReadableStream<T>
    // , ReadableStream<F>
  ]
  & AsyncDisposable {
  // Create TransformStreams to act as minimal queues
  const { writable: queue1, readable: readable1 } = new TransformStream<T>();
  const { writable: queue2, readable: readable2 } = new TransformStream<F>();

  const context: SplitStreamContext<T, F> = {
    source: sourceStream.getReader(),
    predicate,
    queues: [
      { readable: readable1, writer: queue1.getWriter(), size: 0 },
      { readable: readable2, writer: queue2.getWriter(), size: 0 },
    ],
    readInProgress: false,
    sourceDone: false,
  };

  const trueStream = createPullStream<T, F, T>(context, { index: 0 });
  // const falseStream = createPullStream<T, F, F>(context, { index: 1 });

  return Object.assign([trueStream,
    // falseStream

  ] as const, {
    async [Symbol.asyncDispose]() {
      await Promise.all([
        trueStream.cancel("Symbol.asyncDispose"),
        // falseStream.cancel("Symbol.asyncDispose"),
      ]);
    },
  })
}

function createPullStream<T, F = unknown, V = T | F>(context: SplitStreamContext<T, F>, { index: currentQueueIndex }: { index: number }): ReadableStream<V> {
  const queue = context.queues[currentQueueIndex];
  const readable = queue.readable as ReadableStream<V> | null;

  return new ReadableStream<V>({
    async pull(controller) {
      if (context.sourceDone) {
        controller.close();
        return;
      }

      // Always trigger a read after pulling, whether we got a value or not
      // if (!context.readInProgress && !context.sourceDone) {
      while (queue.size === 0 && !context.sourceDone) {
        await readFromSource(context);
      }
      // }

      const reader = readable?.getReader();
      try {
        const { value, done } = await reader?.read() ?? { value: undefined, done: true, error: "Something went wrong" };

        console.log({ value, done })
        if (done) {
          if (!context.sourceDone) {
            // If this queue is empty but source isn't done, trigger another read
            if (!context.readInProgress) {
              await readFromSource(context);
            }

            return;  // Don't close the controller, wait for more data
          }

          controller.close();
        } else {
          controller.enqueue(value as V);
          queue.size--;
        }

        // Always trigger a read after pulling, whether we got a value or not
        // if (!context.readInProgress && !context.sourceDone) {
        //   readFromSource(context);
        // }
      } catch (error) {
        controller.error(error);
      } finally {
        reader?.releaseLock();
      }
    },
    async cancel(reason) {
      // Handle cancellation if needed
      await readable?.cancel(reason);

      const allQueuesCancelled = context.queues.every((queue, currentQueueIndex) => {
        if ((queue?.readable as V) === readable) {
          context.queues[currentQueueIndex].writer?.releaseLock();

          context.queues[currentQueueIndex].readable = null;
          context.queues[currentQueueIndex].writer = null;
        }

        return queue?.readable === null;
      });

      if (allQueuesCancelled && context.source) {
        if (!context.sourceDone) {
          await context.source?.cancel(reason);
        }

        context.source?.releaseLock();

        context.sourceDone = true;
        context.source = null;
      }
    }
  });
}

async function readFromSource<T, F = unknown>(context: SplitStreamContext<T, F>) {
  const { source, predicate } = context;
  if (context.readInProgress || context.sourceDone) return;

  try {
    while (!context.sourceDone) {
      const { value, done } = await source?.read() ?? { value: undefined, done: true };
      console.log({ value, done, readFromSource: true });

      if (done) {
        context.sourceDone = true;
        await Promise.all([
          context.queues.map((queue) => queue?.writer?.close())
        ]);
        break;
      }

      if (predicate?.(value)) {
        await context.queues[0]?.writer?.write(value as T);
        context.queues[0].size++;
        break;
      } else {
        await context.queues[1]?.writer?.write(value as F);
        context.queues[1].size++;
        break;
      }
    }
  } catch (error) {
    console.log("Error reading from source", error);
    await Promise.all([
      context.queues.map((queue) => queue?.writer?.abort(error))
    ]);
  }
}

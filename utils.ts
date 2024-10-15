/**
 * Converts a ReadableStream into an Async Generator.
 *
 * This allows you to iterate over the chunks of data in the stream using `for await...of` syntax.
 *
 * @param stream The ReadableStream to convert.
 * @returns An Async Iterator that yields the chunks of data from the stream.
 *
 * @example
 * ```ts
 * import { streamToAsyncGenerator } from "./stream.ts"
 * const readableStream = new ReadableStream({
 *   start(controller) {
 *     controller.enqueue("chunk1");
 *     controller.enqueue("chunk2");
 *     controller.close();
 *   }
 * });
 *
 * const asyncIterator = streamToAsyncGenerator(readableStream);
 *
 * for await (const chunk of asyncIterator) {
 *   console.log(chunk); // Logs: "chunk1", "chunk2"
 * }
 * ```
 */
export async function* streamToAsyncGenerator<T>(
  stream: ReadableStream<T>,
): AsyncGenerator<T> {
  const reader = stream.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Converts an Async Iterator into a ReadableStream.
 *
 * This allows you to produce a stream of data from an async iterator.
 *
 * @param iterator The Async Iterator to convert.
 * @returns A ReadableStream that streams the data produced by the async iterator.
 *
 * @example
 * ```ts
 * import { asyncIteratorToStream } from "./stream.ts"
 * async function* asyncGenerator() {
 *   yield "chunk1";
 *   yield "chunk2";
 * }
 *
 * const readableStream = asyncIteratorToStream(asyncGenerator());
 *
 * const reader = readableStream.getReader();
 * reader.read().then(({ value, done }) => {
 *   console.log(value); // Logs: "chunk1"
 * });
 * ```
 */
export function asyncIteratorToStream<T>(
  iterator: AsyncIterator<T>,
): ReadableStream<T> {
  return new ReadableStream<T>({
    async pull(controller) {
      try {
        const { value, done } = await iterator.next();
        if (done) {
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (err) {
        controller.error(err);
      }
    },
  });
}

/**
 * Converts a Synchronous Iterator into a ReadableStream.
 *
 * This allows you to produce a stream of data from a synchronous iterator.
 *
 * @param iterator The Synchronous Iterator to convert.
 * @returns A ReadableStream that streams the data produced by the iterator.
 *
 * @example
 * ```ts
 * import { iteratorToStream } from "./stream.ts"
 * function* syncGenerator() {
 *   yield "chunk1";
 *   yield "chunk2";
 * }
 *
 * const readableStream = iteratorToStream(syncGenerator());
 *
 * const reader = readableStream.getReader();
 * reader.read().then(({ value, done }) => {
 *   console.log(value); // Logs: "chunk1"
 * });
 * ```
 */
export function iteratorToStream<T>(iterator: Iterator<T>): ReadableStream<T> {
  return new ReadableStream<T>({
    pull(controller) {
      try {
        const { value, done } = iterator.next();
        if (done) {
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (err) {
        controller.error(err);
      }
    },
  });
}

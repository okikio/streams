/**
 * Converts a ReadableStream or ReadableStreamDefaultReader into an Async Generator.
 *
 * This function allows you to iterate over the chunks of data from a stream reader using the `for await...of` syntax.
 * It supports both ReadableStream and ReadableStreamDefaultReader as input and provides options to configure its behavior.
 *
 * @param stream The ReadableStream or ReadableStreamDefaultReader to convert into an Async Generator.
 *               If a ReadableStream is passed, a reader is automatically obtained from it.
 * @param options Configuration options for the function.
 * @param options.autoRelease Whether to automatically release the lock on the reader when done.
 *                            Defaults to `true` if a ReadableStream is passed, otherwise `false`.
 *                            When set to `true`, the lock on the reader will be released automatically
 *                            after the iteration is complete, ensuring that the stream can be read by other consumers.
 *                            When set to `false`, the caller is responsible for releasing the lock.
 * @param options.throw Whether to rethrow any errors encountered while reading from the stream.
 *                      Defaults to `false`, which logs a warning instead.
 *                      When set to `true`, any errors encountered during the reading process will be rethrown,
 *                      allowing the caller to handle them explicitly. When set to `false`, errors are caught,
 *                      a warning is logged, and the iteration stops gracefully.
 * @returns An Async Iterator that yields the chunks of data from the stream.
 *
 * @example
 * ```ts
 * import { iterableFromStream } from "./stream.ts"
 * const readableStream = new ReadableStream({
 *   start(controller) {
 *     controller.enqueue("chunk1");
 *     controller.enqueue("chunk2");
 *     controller.close();
 *   }
 * });
 *
 * const reader = readableStream.getReader();
 * const asyncIterator = iterableFromStream(reader);
 *
 * for await (const chunk of asyncIterator) {
 *   console.log(chunk); // Logs: "chunk1", "chunk2"
 * }
 * ```
 *
 * @example
 * ```ts
 * import { iterableFromStream } from "./stream.ts"
 * const readableStream = new ReadableStream({
 *   start(controller) {
 *     controller.enqueue("chunk1");
 *     controller.enqueue("chunk2");
 *     controller.close();
 *   }
 * });
 *
 * const asyncIterator = iterableFromStream(readableStream, { autoRelease: true, throw: true });
 *
 * try {
 *   for await (const chunk of asyncIterator) {
 *     console.log(chunk); // Logs: "chunk1", "chunk2"
 *   }
 * } catch (error) {
 *   console.error("Stream error:", error);
 * }
 * ```
 */
export async function* iterableFromStream<T>(
  stream: ReadableStreamDefaultReader<T> | ReadableStream<T>,
  { autoRelease: _autoRelease, throw: _throw = false }: { autoRelease?: boolean, throw?: boolean } = {},
): AsyncIterable<T> {
  const isReadableStream = stream instanceof ReadableStream;
  const reader = isReadableStream ? stream.getReader() : stream;
  _autoRelease = _autoRelease ?? isReadableStream; 

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      yield value;
    }
  } catch (error) {
    // If the stream is cancelled or there is an error, we handle it gracefully
    if (_throw) throw error;
    return;
  } finally {
    // Release the lock on the stream reader
    if (_autoRelease) {
      reader.releaseLock();
    }
  }
}

/**
 * Converts an Iterable, Async Iterable, Iterator, and/or Async Iterator into a ReadableStream.
 *
 * This allows you to produce a stream of data from a iterable.
 *
 * If the produced iterator (`iterable[Symbol.asyncIterator]()` or
 * `iterable[Symbol.iterator]()`) is a generator, or more specifically is found
 * to have a `.throw()` method on it, that will be called upon
 * `readableStream.cancel()`. This is the case for the second input type above:
 *
 * @param iterable The iterable to convert.
 * @returns A ReadableStream that streams the data produced by the iterable.
 *
 * @example
 * ```ts
 * import { iterableToStream } from "./stream.ts"
 * async function* asyncGenerator() {
 *   yield "chunk1";
 *   yield "chunk2";
 * }
 *
 * const readableStream = iterableToStream(asyncGenerator());
 *
 * const reader = readableStream.getReader();
 * reader.read().then(({ value, done }) => {
 *   console.log(value); // Logs: "chunk1"
 * });
 * ```
 */
export function iterableToStream<T>(
  iterable: Iterable<T> | AsyncIterable<T> | Iterator<T> | AsyncIterator<T>,
): ReadableStream<T> {
  const iterator: Iterator<T> | AsyncIterator<T> =
    (iterable as AsyncIterable<T>)[Symbol.asyncIterator]?.() ??
    (iterable as Iterable<T>)[Symbol.iterator]?.() ??
    iterable;
  
  return new ReadableStream<T>({
    async pull(controller) {
      const { value, done } = await iterator.next();
      if (done) {
        controller.close();
      } else {
        controller.enqueue(value);
      }
    },
    async cancel(reason) {
      if (typeof iterator.throw == "function") {
        try {
          await iterator.throw(reason);
        } catch { /* `iterator.throw()` always throws on site. We catch it. */ }
      }
    },
  });
}
